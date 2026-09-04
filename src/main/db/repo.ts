/**
 * 领域对象的读写。**`state/store.ts` 唯一的后端** —— 那边的访问器逐个转发到这里,
 * 签名一个都没改,所以全应用的调用点一处都不用动。
 *
 * 函数名刻意和 `store` 的访问器一一对应:换实现时能逐行对照,
 * 而不是要先在脑子里做一次映射。
 *
 * ## 一处**行为**上的变化,值得单独说
 *
 * Map 版的 `getWorkspace` 返回的是表里那个**活对象**,改它就等于改了库;
 * 这里返回的是一次 `JSON.parse` 的产物,改它谁也不影响。
 * 方向是安全的(意外的写入变成无效果,而不是意外生效),而且和 `getSettings`
 * 一直以来的 `structuredClone` 语义终于一致了。已核对现有两个调用点
 * (`ipc/workspace.ts` 的 `updateWorkspace` / `listDir`)都是展开取值,不改返回对象。
 */
import type { McpServerConfig } from '../../shared/domain/mcp'
import { mcpSecretRef } from '../../shared/domain/mcp'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import type { SearchProviderConfig, SearchProviderId } from '../../shared/domain/search'
import { defaultProviderConfigs, searchSecretRef } from '../../shared/domain/search'
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/domain/settings'
import type { Workspace } from '../../shared/domain/workspace'
import { stmt, tx } from './index'

export { tx } from './index'

/** 列里存的是 JSON 文本;`String()` 是给 `SQLOutputValue` 那个联合类型收窄用的。 */
const parse = <T>(json: unknown): T => JSON.parse(String(json)) as T

// ── settings ────────────────────────────────────────────────────────────────

/**
 * ★ 读出来的值是**合并到 `DEFAULT_SETTINGS` 上**的,不是直接返回。
 *
 * 这样旧版本存下的行缺了新字段时,拿到的是新字段的默认值,而不是 `undefined`
 * 顺着 IPC 流到界面上变成一个空下拉框。下一步就要用到:方案 §7 要把
 * `gateway.failover` 改名成 `routing.failover`,那之后所有已经存在的行都缺 `routing`。
 *
 * `mergeSettings` 是逐字段展开的(还带一张编译期哨兵表),所以它顺带也把
 * **已经删掉的字段**挡在外面 —— 它只认识 `AppSettings` 上真实存在的键。
 */
export function getSettings(): AppSettings {
  const row = stmt('SELECT json FROM settings WHERE id = 1').get()
  if (row === undefined) return structuredClone(DEFAULT_SETTINGS)
  return mergeSettings(DEFAULT_SETTINGS, parse<AppSettingsPatch>(row['json']))
}

export function updateSettings(patch: AppSettingsPatch): AppSettings {
  // 读-改-写要在一个事务里:否则两个 handler 同时改不同字段时,后写的那个
  // 拿的是改之前的快照,会把前一个的改动原样覆盖回去。
  return tx(() => {
    const next = mergeSettings(getSettings(), patch)
    stmt(
      'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json'
    ).run(JSON.stringify(next))
    return next
  })
}

// ── workspaces ──────────────────────────────────────────────────────────────

export function listWorkspaces(): Workspace[] {
  return stmt('SELECT json FROM workspaces ORDER BY last_opened_at DESC')
    .all()
    .map((r) => parse<Workspace>(r['json']))
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = stmt('SELECT json FROM workspaces WHERE id = ?').get(id)
  return row === undefined ? undefined : parse<Workspace>(row['json'])
}

export function putWorkspace(w: Workspace): Workspace {
  stmt(
    `INSERT INTO workspaces (id, last_opened_at, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_opened_at = excluded.last_opened_at, json = excluded.json`
  ).run(w.id, w.lastOpenedAt, JSON.stringify(w))
  return w
}

export function removeWorkspace(id: string): void {
  stmt('DELETE FROM workspaces WHERE id = ?').run(id)
}

// ── 上游供应商 / 模型别名 ────────────────────────────────────────────────────

export function listProviders(): UpstreamProvider[] {
  // priority 相同时用 id 兜底,保证顺序是确定的 —— 故障切换按这个顺序挑候选,
  // 「今天先切到 A、明天先切到 B」比切错还难查
  return stmt('SELECT json FROM providers ORDER BY priority, id')
    .all()
    .map((r) => parse<UpstreamProvider>(r['json']))
}

export function putProvider(p: UpstreamProvider): UpstreamProvider {
  stmt(
    `INSERT INTO providers (id, priority, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET priority = excluded.priority, json = excluded.json`
  ).run(p.id, p.priority, JSON.stringify(p))
  return p
}

/**
 * 别名**不用**在这里手动删。`model_aliases.provider_id` 上的
 * `ON DELETE CASCADE` 接着(见 `schema.ts`),前提是连接开了 `foreign_keys`
 * —— `index.ts` 的 `openAt()` 用构造参数打开的。
 */
export function removeProvider(id: string): void {
  stmt('DELETE FROM providers WHERE id = ?').run(id)
}

export function listAliases(): ModelAlias[] {
  return stmt('SELECT json FROM model_aliases ORDER BY provider_id, alias')
    .all()
    .map((r) => parse<ModelAlias>(r['json']))
}

export function putAlias(a: ModelAlias): ModelAlias {
  stmt(
    `INSERT INTO model_aliases (provider_id, alias, json) VALUES (?, ?, ?)
     ON CONFLICT (provider_id, alias) DO UPDATE SET json = excluded.json`
  ).run(a.providerId, a.alias, JSON.stringify(a))
  return a
}

export function removeAlias(providerId: string, alias: string): void {
  stmt('DELETE FROM model_aliases WHERE provider_id = ? AND alias = ?').run(providerId, alias)
}

// ── kv ──────────────────────────────────────────────────────────────────────

export function getKv<T>(key: string, fallback: T): T {
  const row = stmt('SELECT json FROM kv WHERE key = ?').get(key)
  if (row === undefined) return fallback
  // `?? fallback` 保住 Map 版的语义:存进去的 null 读出来也是兜底值,
  // 而不是一个会顺着 IPC 流到界面上的 null
  return parse<T>(row['json']) ?? fallback
}

export function setKv(key: string, value: unknown): void {
  // `JSON.stringify(undefined)` 返回的是 undefined 而不是字符串,会撞上 NOT NULL。
  // 归一成 null,读回来正好走上面那条兜底。
  stmt(
    'INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json'
  ).run(key, JSON.stringify(value ?? null))
}

export function removeKv(key: string): void {
  stmt('DELETE FROM kv WHERE key = ?').run(key)
}

// ── MCP 服务器 ──────────────────────────────────────────────────────────────

/**
 * 顺序按 id —— MCP 服务器的顺序**没有语义**(每台带来的工具都平铺进同一个
 * ToolRegistry,不存在「先试这台」),但列表页需要一个稳定顺序,
 * 否则每次读回来行序都可能不同,看起来像在自己跳。
 */
export function listMcpServers(): McpServerConfig[] {
  return stmt('SELECT json FROM mcp_servers ORDER BY id')
    .all()
    .map((r) => parse<McpServerConfig>(r['json']))
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  const row = stmt('SELECT json FROM mcp_servers WHERE id = ?').get(id)
  return row === undefined ? undefined : parse<McpServerConfig>(row['json'])
}

export function putMcpServer(c: McpServerConfig): McpServerConfig {
  stmt(
    `INSERT INTO mcp_servers (id, json) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET json = excluded.json`
  ).run(c.id, JSON.stringify(c))
  return c
}

/**
 * ★ 配置和它的密钥**一起删,在一个事务里**。
 *
 * 只删配置的话,`credentials` 里那行密文会永远留着 —— 而且它是**孤儿**:
 * 键名存在刚被删掉的那条配置里,再没有任何东西知道该怎么清理它。
 * 更糟的是下次建一个同 id 的服务器会**默默继承**上一个的 token,
 * 症状是「我明明没填 Authorization,它却连上了」。
 *
 * 两个 kind 都删,而不是先读出配置再判断该删哪个:少一次读,
 * 而且配置读不出来(行已经不在了)时仍然清得干净。
 */
export function removeMcpServer(id: string): void {
  tx(() => {
    stmt('DELETE FROM mcp_servers WHERE id = ?').run(id)
    stmt('DELETE FROM credentials WHERE ref = ?').run(mcpSecretRef(id, 'env'))
    stmt('DELETE FROM credentials WHERE ref = ?').run(mcpSecretRef(id, 'headers'))
  })
}

// ── 搜索服务 ────────────────────────────────────────────────────────────────

/**
 * ★ 返回的是**目录表里的八家全部**,不是库里存着的那几行。
 *
 * 库里只存「用户动过的那几家」——一家都没配过时表是空的。而设置页要列出八家
 * 供用户挑,`web_search` 也要知道完整的优先级序。让每个调用点各自去和
 * `defaultProviderConfigs()` 做一次左连接,是三份必然会分叉的实现;
 * 收在这里一次做完。
 *
 * 顺序:**按 `priority` 升序**,平局用目录顺序兜底。
 *
 * 平局是真会出现的:界面拖拽走 `reorderProviders`,它把八家整批重编号,
 * 所以正常路径下没有重复。但只写了其中两家(测试、导入、将来某条迁移)之后,
 * 没存过的那几家仍然带着目录序号当 priority,和新编号撞得上。
 * 撞了就用目录顺序兜底 —— 关键是**确定**:「今天先试 A、明天先试 B」
 * 比顺序不合心意难查得多。
 */
export function listSearchProviders(): SearchProviderConfig[] {
  const stored = new Map(
    stmt('SELECT json FROM search_providers')
      .all()
      .map((r) => {
        const c = parse<SearchProviderConfig>(r['json'])
        return [c.id, c] as const
      })
  )
  return defaultProviderConfigs()
    .map((d, catalogIndex) => ({ cfg: stored.get(d.id) ?? d, catalogIndex }))
    .sort((a, b) => a.cfg.priority - b.cfg.priority || a.catalogIndex - b.catalogIndex)
    .map((x) => x.cfg)
}

export function putSearchProvider(c: SearchProviderConfig): SearchProviderConfig {
  stmt(
    `INSERT INTO search_providers (id, priority, json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET priority = excluded.priority, json = excluded.json`
  ).run(c.id, c.priority, JSON.stringify(c))
  return c
}

/**
 * 拖拽排序的落点:**整批写,一个事务**。
 *
 * 逐行写的话,中途失败会留下一半新序一半旧序 —— 而 priority 不是描述性的,
 * 它决定调用顺序,两个 0 或者一个空档都会让「先试哪家」变得不确定。
 */
export function putSearchProviders(list: readonly SearchProviderConfig[]): void {
  tx(() => {
    for (const c of list) putSearchProvider(c)
  })
}

/** Key 也一起删,理由同 `removeMcpServer` —— 同 id 重配时不该继承上一次的 Key。 */
export function clearSearchCredential(id: SearchProviderId): void {
  stmt('DELETE FROM credentials WHERE ref = ?').run(searchSecretRef(id))
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * ★ 存取的是**密文字节**,这里不认识明文也不该认识 ——
 * 加解密只在 `main/host/index.ts` 那两个函数之间发生(方案 §9)。
 *
 * 读回来的是 `Uint8Array`,`safeStorage.decryptString` 要 `Buffer`,
 * 转换留给调用方 —— 数据库层不 import electron 的任何东西。
 */
export function getCredential(ref: string): Uint8Array | undefined {
  const row = stmt('SELECT blob FROM credentials WHERE ref = ?').get(ref)
  if (row === undefined) return undefined
  const blob = row['blob']
  return blob instanceof Uint8Array ? blob : undefined
}

export function putCredential(ref: string, blob: Uint8Array): void {
  stmt(
    'INSERT INTO credentials (ref, blob) VALUES (?, ?) ON CONFLICT (ref) DO UPDATE SET blob = excluded.blob'
  ).run(ref, blob)
}

export function removeCredential(ref: string): void {
  stmt('DELETE FROM credentials WHERE ref = ?').run(ref)
}
