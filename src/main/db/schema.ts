/**
 * 建表脚本。**只增不改** —— 每条迁移一旦发布过就是历史,改它等于让已经升过级的
 * 库和新装的库长得不一样,而这种分叉没有任何机制会报警。要改结构就追加下一条。
 *
 * ## 为什么大部分表是「JSON 一列 + 少数几列真字段」
 *
 * 这不是偷懒,是按**查询形状**分的:
 *
 * - `settings` / `kv` / `workspaces` / `providers` / `model_aliases` 全都是
 *   **整行读、整行写**,行数在几十这个量级,没有一处按字段过滤或聚合。
 *   拆成真列换不到任何查询能力,却要为领域类型的每一次增删字段写一条迁移 ——
 *   而 `ModelAlias` 接下来就要加 `modality` / `enabled` / `order` 三个字段
 *   (方案 §1.2 / §1.4)。存 JSON 的话那三个字段一条迁移都不用写。
 * - 例外是**排序键**:`providers.priority` 和 `workspaces.last_opened_at`
 *   提到真列上,因为 `listProviders()` / `listWorkspaces()` 的顺序是有语义的
 *   (前者决定故障切换先切到谁),交给 SQLite 的 ORDER BY 比读回来再排稳。
 *
 * ★ 反过来说:`usage_records` 与 `model_pricing`(下一条迁移)**必须是真列**,
 * 因为它们唯一的用法就是按时间窗聚合和按 `(provider_id, model_id)` 查找。
 * 判据是查询形状,不是「新表一律怎样」。
 *
 * ## 级联删除是结构性的,不再是记在心里的
 *
 * `model_aliases.provider_id` 上有真 FK + `ON DELETE CASCADE`。之前这条级联
 * 是 `store.removeProvider` 里手写的一个循环 —— 对的,但要靠人记得。
 * 悬空别名的症状离删除点很远(「模型还在下拉框里,选了却报『没有已启用的供应商』」),
 * 所以让数据库来保证它。**FK 的前提是连接级的 `PRAGMA foreign_keys=ON`**,
 * 见 `index.ts` 的 `openAt()`。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * 第 1 条:除会话转录外的全部持久化状态。
 *
 * `conversations` / `messages` / `runs` / `messages_fts` **不在这里** ——
 * 那是步骤 6,理由见 `index.ts` 文件头的划界表。
 */
const V1_CORE = `
-- 单例行。用 CHECK 把「只能有一行」写进表里,而不是靠每个写入点都记得用 id=1:
-- 多出来的第二行不会报错,只会让 getSettings 随机读到其中一行。
CREATE TABLE settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

-- 窗口/Tab 布局这类易失 UI 状态。键名收在 state/store.ts 的 outerTabKey / innerTabKey。
CREATE TABLE kv (
  key  TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  -- 提成真列:listWorkspaces() 按它倒序,首屏「开哪个工作区」依赖这个顺序
  last_opened_at INTEGER NOT NULL,
  json           TEXT NOT NULL
);
CREATE INDEX workspaces_by_last_opened ON workspaces (last_opened_at DESC);

CREATE TABLE providers (
  id       TEXT PRIMARY KEY,
  -- 提成真列:故障切换按它挑下一个候选(方案 §5.3),顺序是有语义的
  priority INTEGER NOT NULL,
  json     TEXT NOT NULL
);
CREATE INDEX providers_by_priority ON providers (priority);

-- ★ 主键是 (provider_id, alias) 的**复合主键**,不是 alias。
-- 同一个 alias 由多个 provider 提供正是别名表存在的理由(方案 §5.2):
-- 用 alias 当主键,故障切换就只剩一个候选。
--
-- 顺带消掉了一个 Map 实现里必须自己防的坑:拼接字符串当键时
--   "a" + "|b" 和 "a|" + "b" 会撞成同一个键,旧实现为此选了 U+0000 当分隔符。
-- 复合主键下这件事结构上就不可能发生。
CREATE TABLE model_aliases (
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  json        TEXT NOT NULL,
  PRIMARY KEY (provider_id, alias)
);

-- 上游密钥。**存的是 safeStorage.encryptString 的产物,不是明文**(方案 §9)——
-- 加解密逻辑全在 main/host/index.ts 那两个函数里,这张表只认字节。
-- 系统密钥环不可用时那边直接抛错拒绝存储,不会有明文走到这里来。
CREATE TABLE credentials (
  ref  TEXT PRIMARY KEY,
  blob BLOB NOT NULL
);
`

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'core', sql: V1_CORE }]
