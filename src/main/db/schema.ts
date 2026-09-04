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
 * ★ 反过来说:`usage_records` 与 `model_pricing`(第 3 条)**必须是真列**,
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

/**
 * 第 2 条:MCP 服务器与搜索服务。「设置 › 连接」那一页要存的两样东西。
 *
 * 两张表的形状**刻意不一样**,判据就是文件头那条「按查询形状分」:
 *
 * - `mcp_servers` 整行读、整行写,行数是个位数,顺序没有语义 → JSON 一列。
 *   而 `McpServerConfig` 是个三传输方式的可辨识联合(stdio 有 command/args/envNames,
 *   http/sse 有 url/headerNames),拆成真列就得为并集里每个字段留一列可空,
 *   然后靠代码记住「stdio 那行的 url 列没意义」—— 那正是 JSON 列要避免的事。
 * - `search_providers` 的 `priority` **提成真列**,理由和 `providers.priority`
 *   一模一样:「按优先级依次调用、失败切下一家」是它唯一的语义,
 *   交给 ORDER BY 比读回来再排稳。
 *
 * ★ **两张表里都没有一个明文密钥。** MCP 的 env / headers 值、搜索服务的 API Key
 * 全部在 `credentials` 表里(ref 分别是 `mcpSecretRef()` 和 `searchSecretRef()`),
 * 经 safeStorage 加密。这也意味着删一行配置要顺手删对应的 credentials 行 ——
 * 那件事在 `repo.ts` 的 `removeMcpServer` 里做,不在这里,因为这张表不认识 ref 的构造规则。
 */
const V2_CONNECTIONS = `
CREATE TABLE mcp_servers (
  id   TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE search_providers (
  id       TEXT PRIMARY KEY,
  -- 提成真列:web_search 按它升序依次尝试,失败切下一家(见 main/search/service.ts)
  priority INTEGER NOT NULL,
  json     TEXT NOT NULL
);
CREATE INDEX search_providers_by_priority ON search_providers (priority);
`

/**
 * 第 3 条:定价表与用量记录(方案 §4 / §5)。
 *
 * 文件头那条「按查询形状分」在这两张表上给出的答案和前两条相反 ——
 * **查找键与聚合键必须是真列**,只有「一整套费率」这种从不按字段查的嵌套结构留 JSON。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ `model_pricing.provider_id` **不是** `providers.id`,所以这里没有外键
 * ─────────────────────────────────────────────────────────────
 *
 * 它是**厂商**维度的键(`presets.ts` 里的预设 id,如 `deepseek` / `zai`),
 * 不是「用户配的某一条连接」。理由是种子表 `pricing-seed.ts` 里的国内条目
 * **在用户配置任何供应商之前就存在** —— DeepSeek 的人民币价是这张表的初始内容,
 * 而那时 `providers` 表可能一行都没有。
 *
 * 所以加外键会**让整张种子表插不进去**。这条注释就是写给下一个看见
 * `provider_id` 就想补 `REFERENCES providers (id)` 的人的 —— 那不是加固,是把
 * 「重装后没有任何国内定价」变成开箱即有的行为。
 *
 * (跟着的推论:运行时查价传的是该 provider 的**厂商归属**,不是它的行 id。
 * 这条映射在步骤 3 落地 `provider:upsert` 时定形;DDL 对两种选择都成立,
 * 所以这里不替那个决定表态。)
 *
 * ★ NULL 在 UNIQUE 约束里彼此不相等,所以 `(provider_id, model_id, effective_from)`
 * 直接做主键**挡不住重复**:两条 `(NULL, 'gpt-5', NULL)` 会双双插入成功,
 * 然后 `findPricing` 随机读到其中一条。用 `COALESCE(...,'')` 的表达式唯一索引
 * 把这个洞补上,同时让列本身保持诚实的可空 —— 空值的含义(通用价 / 永远生效)
 * 是领域语义的一部分,不该为了绕开 SQLite 的 NULL 规则而编码成空串。
 */
const V3_PRICING_USAGE = `
CREATE TABLE model_pricing (
  -- NULL = 通用基础定价;非 NULL = 该厂商的价(见上面那段,**不要**加外键)
  provider_id     TEXT,
  model_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  currency        TEXT NOT NULL,
  modality        TEXT NOT NULL,
  -- 一整套费率(含阶梯)。从不按字段查询、结构还会长(perCall 之类),所以留 JSON
  tiers           TEXT NOT NULL,
  windows         TEXT,
  -- YYYY-MM-DD,NULL = 该侧无界。厂商会预告调价,同一模型可以有多行
  effective_from  TEXT,
  effective_until TEXT,
  source          TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  -- ★ 这一行是不是来自仓库种子表。pricing:resetToSeed 靠它区分「重置」的边界:
  -- 没有这一列,重置要么连用户手工录的覆盖价一起抹掉,要么根本没法只换种子那部分。
  is_seed         INTEGER NOT NULL DEFAULT 0
);

-- 见上面:NULL 不参与 UNIQUE 比较,所以折成空串再比
CREATE UNIQUE INDEX model_pricing_key
  ON model_pricing (model_id, COALESCE(provider_id, ''), COALESCE(effective_from, ''));

-- findPricing 先按 model_id 收窄,再在少数几行里挑 provider 与日期区间
CREATE INDEX model_pricing_by_model ON model_pricing (model_id);

-- 一次 HTTP 尝试一条(方案 §5.2)。首字节后禁止切换意味着一次逻辑请求可能有多条,
-- 合并成一条就算不出参考图要的「请求成功率」。
CREATE TABLE usage_records (
  id             TEXT PRIMARY KEY,
  at             INTEGER NOT NULL,
  -- 同一次逻辑请求的多条尝试共用它。日志视图按它分组
  run_id         TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  alias          TEXT NOT NULL,
  -- ★ 上游真实模型名,不是别名 —— 定价按它查(方案 §4.1)
  upstream_model TEXT NOT NULL,

  -- ★ token 数用 NOT NULL DEFAULT 0,和「价格绝不填 0」是**两件事**:
  -- 缺一个价意味着「我们不知道多少钱」,填 0 会静默变成「免费」;
  -- 而 TokenUsage 里缺一项缓存字段就是真的没有那类 token,0 是它准确的值。
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens   INTEGER NOT NULL DEFAULT 0,

  latency_ms     INTEGER NOT NULL,
  ok             INTEGER NOT NULL,
  http_status    INTEGER,
  error_kind     TEXT,

  -- ★★ **可空,而且 NULL 与 0 必须分得开。** NULL = 查不到定价,
  -- 0 = 真的不要钱。PricingTable 顶部那张「用过但查不到定价」的表就是
  --   SELECT DISTINCT upstream_model ... WHERE cost_micros IS NULL
  -- 而「种子表把 modelId 抄错了」这一类错,唯一的外显方式就是费用列永远是「—」。
  --
  -- 记账时算好并**冻结**(方案 §5.2):事后改定价表不改历史账单。
  cost_micros    INTEGER,
  currency       TEXT,
  pricing_tier   INTEGER,
  pricing_window TEXT,

  tool_calls     INTEGER NOT NULL DEFAULT 0,
  tool_errors    INTEGER NOT NULL DEFAULT 0
);

-- 五条 usage:* 查询**每一条**都带时间窗(方案 §5.4)。带上 id 是为了让
-- getRequestLogs 的游标是全序的:同毫秒的两条记录不加 id 就会在翻页时重复或漏掉。
CREATE INDEX usage_records_by_at ON usage_records (at DESC, id DESC);

-- getModelStats / getProviderStats:先按维度收窄再按时间窗过滤
CREATE INDEX usage_records_by_model ON usage_records (upstream_model, at DESC);
CREATE INDEX usage_records_by_provider ON usage_records (provider_id, at DESC);
`

/**
 * 第 4 条：会话转录与本机数据管理。
 *
 * 会话/消息的正文仍以 JSON 保存，避免把 ContentPart[] 压扁成字符串后丢掉
 * 工具调用、思考签名和图片引用。可查询字段单独提列，FTS 索引由 repository
 * 在 message_commit 边界维护。
 */
const V4_SESSIONS = `
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  title                TEXT NOT NULL,
  model                TEXT NOT NULL,
  mode                 TEXT NOT NULL,
  thinking             TEXT NOT NULL,
  root_path_at_creation TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'idle',
  archived             INTEGER NOT NULL DEFAULT 0,
  favorited            INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  json                 TEXT NOT NULL
);
CREATE INDEX sessions_by_workspace ON sessions (workspace_id, archived, updated_at DESC);
CREATE INDEX sessions_by_updated ON sessions (updated_at DESC);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  role           TEXT NOT NULL,
  parts          TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX messages_by_session ON messages (session_id, ordinal);

CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  json       TEXT
);
CREATE INDEX runs_by_session ON runs (session_id, started_at DESC);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  message_id  TEXT REFERENCES messages (id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  checksum    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX attachments_by_path ON attachments (path);
CREATE INDEX attachments_by_message ON attachments (message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);
`

/**
 * 第 5 条:附件的 scope 与生命周期。
 *
 * ## 为什么必须加这两列
 *
 * `attachments` 原本只记录**已经提交进消息**的会话附件,而清理规则是
 * 「扫附件根目录,不在表里的一律删」。那条规则默认「表覆盖全集」。
 *
 * 一旦附件根下开始放别的东西,这个默认就不成立了,而它的失效方式是**静默删文件**:
 *
 * - 主题图不在表里 → 被当孤儿删掉
 * - **用户刚上传、还没点发送的附件不在表里** → 挑好图去倒杯水,
 *   期间清理跑过一次,回来图没了
 *
 * `scope` 让清理能按子树分治,`status` 把孤儿的定义从「表里没有」
 * 收紧为「表里标记为可回收且已过宽限期」。
 *
 * ## 为什么是 ALTER 而不是重建表
 *
 * `attachments` 上有两条指向 `sessions`/`messages` 的外键。重建表要先关外键、
 * 拷数据、改名、再开 —— 而 SQLite 的 `PRAGMA foreign_keys` 是**连接级**的,
 * 在事务里改它不生效。两列都有默认值,ALTER 是安全且足够的。
 */
const V5_ATTACHMENT_SCOPE = `
-- 既有行全部是「会话附件且已提交」——这正是加这两列之前唯一可能存在的形态,
-- 所以默认值就是对历史数据的正确回填,不需要额外的 UPDATE。
ALTER TABLE attachments ADD COLUMN scope TEXT NOT NULL DEFAULT 'session';
ALTER TABLE attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'committed';

-- ★ owner_id 与 session_id 是**两回事**,不是冗余:
--
-- session_id 上有指向 sessions 的外键,而附件是在**发送之前**上传的 ——
-- 用户新建对话、还没发第一条消息时,sessions 表里没有那一行
-- (见 store.setHistory 里「渲染层可能在真正发送前就生成 sessionId」那句)。
-- 上传时往 session_id 里填就会直接违反外键。
--
-- 所以:draft 行填 owner_id(无外键),消息提交时由 recordMessageAttachments
-- 填上 session_id —— 那一刻会话行必然已经存在,CASCADE 从此生效。
-- owner_id 同时给了 theme/export 的 ownerId 一个落点。
ALTER TABLE attachments ADD COLUMN owner_id TEXT;
UPDATE attachments SET owner_id = session_id WHERE owner_id IS NULL;

-- 清理按 (status, created_at) 扫:找「draft 且超期」的那批
CREATE INDEX attachments_by_status ON attachments (status, created_at);
-- 上传去重按 (checksum, scope, owner_id) 查
CREATE INDEX attachments_by_checksum ON attachments (checksum, scope, owner_id);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core', sql: V1_CORE },
  { version: 2, name: 'connections', sql: V2_CONNECTIONS },
  { version: 3, name: 'pricing-usage', sql: V3_PRICING_USAGE },
  { version: 4, name: 'sessions-data', sql: V4_SESSIONS },
  { version: 5, name: 'attachment-scope', sql: V5_ATTACHMENT_SCOPE }
]
