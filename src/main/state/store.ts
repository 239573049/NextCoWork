/**
 * 主进程状态的访问器。配置、会话与完整转录都落在 SQLite 里(`src/main/db/`)。
 *
 * 这一层刻意保留下来,没有让 handler 直接调 `db/repo`:
 *
 * - 它是**唯一的收口点**。全应用没有第二个地方摸持久化,所以「把 Db 挪进
 *   `utilityProcess`」那天要改的仍然只有这一层的实现(`DatabaseSync` 是同步的,
 *   迟早要挪 —— 理由写在 `db/index.ts` 文件头)。
 * - kv 的键名(`outerTabKey` / `innerTabKey`)属于这一层的词汇,不属于数据库。
 * - 调用点不需要知道各领域对象在 SQLite 中的具体表结构。
 *
 * 当初那句「步骤 6 的迁移只该是『实现换掉』,不该是『调用点全改』」就是为这一刻写的:
 * 这次替换**没有改动任何一个访问器的签名**,同目录的 `__tests__/store.test.ts`
 * 原样跑过。
 */
import type { AgentMessage } from '../../shared/agent/message'
import type { ContextCheckpoint, ContextSearchHit } from '../../shared/agent/context-management'
import type { McpServerConfig } from '../../shared/domain/mcp'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import type { ModelCatalogDefinition } from '../../shared/domain/model-catalog'
import type { SearchProviderConfig, SearchProviderId } from '../../shared/domain/search'
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import type { InnerTabState, WindowTabState } from '../../shared/domain/tab'
import type { Workspace } from '../../shared/domain/workspace'
import type { Session, SessionDetail, SessionListItem, SearchHit } from '../../shared/domain/session'
import type {
  UsageAttemptRecord,
  UsageDimensionStat,
  UsageRequestLogsPage,
  UsageRequestLogsQuery,
  UsageSummary,
  UsageWindow
} from '../../shared/domain/usage'
import type { SessionCreateInput } from '../db/repo'
import * as repo from '../db/repo'

/** Skill 全局开关的 kv 键。值是**被关掉**的那些 id。 */
const DISABLED_SKILLS_KEY = 'skills.disabled'

export const store = {
  // ── settings ──
  getSettings(): AppSettings {
    return repo.getSettings()
  },
  updateSettings(patch: AppSettingsPatch): AppSettings {
    // 合并规则在 shared/domain/settings.ts 的 mergeSettings —— 纯函数,有测试。
    // 曾经是浅合并,于是连点同一块里的两个开关,第二次写会把第一次的覆盖回去。
    return repo.updateSettings(patch)
  },

  // ── workspaces ──
  listWorkspaces(): Workspace[] {
    return repo.listWorkspaces()
  },
  getWorkspace(id: string): Workspace | undefined {
    return repo.getWorkspace(id)
  },
  putWorkspace(w: Workspace): Workspace {
    return repo.putWorkspace(w)
  },
  removeWorkspace(id: string): void {
    // 两条删除要么都生效要么都不生效:只删了工作区却留下内层 Tab 记录的话,
    // 下次建一个同 id 的工作区会莫名带着上一个的 Tab
    repo.tx(() => {
      repo.removeWorkspace(id)
      repo.removeKv(innerTabKey(id))
    })
  },

  // ── 上游供应商 / 模型别名 ──
  /** 按 priority 升序 —— 故障切换按这个顺序挑下一个候选(方案 §5.3) */
  listProviders(): UpstreamProvider[] {
    return repo.listProviders()
  },
  putProvider(p: UpstreamProvider): UpstreamProvider {
    return repo.putProvider(p)
  },
  /**
   * 别名跟着走。留下一条指向已删 provider 的别名,表现是
   * 「模型还在下拉框里,选了却报『没有已启用的供应商』」—— 症状离这里很远。
   *
   * 级联现在由 `model_aliases` 上的外键做(`db/schema.ts`),不再是这里的一个循环:
   * 数据库保证的不变式不需要每个写入点都记得。
   */
  removeProvider(id: string): void {
    repo.removeProvider(id)
  },
  /**
   * ★ 别名的主键是 `(providerId, alias)`,不是 alias。
   * 同一个 alias 由多个 provider 提供**正是别名表存在的理由**(方案 §5.2:
   * 没有它就谈不上「切到下一个」)。用 alias 当主键,故障切换就只剩一个候选。
   */
  listAliases(): ModelAlias[] {
    return repo.listAliases()
  },
  putAlias(a: ModelAlias): ModelAlias {
    return repo.putAlias(a)
  },
  removeAlias(providerId: string, alias: string): void {
    repo.removeAlias(providerId, alias)
  },

  // ── usage ledger ──
  recordUsageAttempt(record: UsageAttemptRecord): void {
    repo.recordUsageAttempt(record)
  },
  updateUsageToolsForRun(runId: string, toolCalls: number, toolErrors: number): boolean {
    return repo.updateUsageToolsForRun(runId, toolCalls, toolErrors)
  },
  getUsageSummary(window: UsageWindow): UsageSummary {
    return repo.getUsageSummary(window)
  },
  getUsageRequestLogs(query: UsageRequestLogsQuery): UsageRequestLogsPage {
    return repo.getUsageRequestLogs(query)
  },
  getUsageProviderStats(window: UsageWindow): UsageDimensionStat[] {
    return repo.getUsageProviderStats(window)
  },
  getUsageModelStats(window: UsageWindow): UsageDimensionStat[] {
    return repo.getUsageModelStats(window)
  },

  // ── user model catalogue ──
  // Provider discovery intentionally never calls these methods. A row enters
  // this collection only through the explicit model-catalog IPC actions.
  listUserModelCatalog(): ModelCatalogDefinition[] {
    return repo.listUserModelCatalog()
  },
  putUserModelCatalog(model: ModelCatalogDefinition): ModelCatalogDefinition {
    return repo.putUserModelCatalog(model)
  },
  removeUserModelCatalog(id: string): void {
    repo.removeUserModelCatalog(id)
  },

  // ── MCP 服务器(设置 › 连接 › MCP) ──
  /**
   * 顺序按 id,没有语义 —— 但要稳定。理由在 `repo.listMcpServers`。
   *
   * ★ 这里出去的是**配置**,不带运行时状态。状态在 `McpManager` 手里
   * (`main/mcp/manager.ts`),两者由 `ipc/mcp.ts` 合成 `McpServerStatus` 再下发。
   * 让这一层去问 manager 会把「持久化」和「进程内运行时」拧在一起,
   * 而 manager 的生命周期比数据库短得多。
   */
  listMcpServers(): McpServerConfig[] {
    return repo.listMcpServers()
  },
  getMcpServer(id: string): McpServerConfig | undefined {
    return repo.getMcpServer(id)
  },
  putMcpServer(c: McpServerConfig): McpServerConfig {
    return repo.putMcpServer(c)
  },
  /** 配置连密钥一起删,在一个事务里 —— 理由在 `repo.removeMcpServer` */
  removeMcpServer(id: string): void {
    repo.removeMcpServer(id)
  },

  // ── 搜索服务(设置 › 连接 › 搜索服务) ──
  /** ★ 返回目录表里的八家**全部**,不只是库里存过的那几行(见 repo) */
  listSearchProviders(): SearchProviderConfig[] {
    return repo.listSearchProviders()
  },
  putSearchProvider(c: SearchProviderConfig): SearchProviderConfig {
    return repo.putSearchProvider(c)
  },
  /** 拖拽排序:整批写、一个事务。半新半旧的 priority 会让「先试哪家」不确定 */
  putSearchProviders(list: readonly SearchProviderConfig[]): void {
    repo.putSearchProviders(list)
  },
  clearSearchCredential(id: SearchProviderId): void {
    repo.clearSearchCredential(id)
  },

  // ── kv(窗口/Tab 布局等易失 UI 状态) ──
  getKv<T>(key: string, fallback: T): T {
    return repo.getKv(key, fallback)
  },
  setKv(key: string, value: unknown): void {
    repo.setKv(key, value)
  },

  // ── Skill 的全局开关 ──
  /**
   * ★ 存的是**关掉的那些**,不是打开的那些。
   *
   * 存「打开的」的话,用户新装一条 Skill 之后它默认不在列表里 ——
   * 表现是「装了但没反应」,而界面上那个开关看起来是开着的。
   * 存「关掉的」则相反:没被点过的一律有效,这也和
   * `SkillRegistry.resolve()` 里「空清单 = 全都要」是同一个取向。
   */
  getDisabledSkillIds(): string[] {
    const raw = repo.getKv<unknown>(DISABLED_SKILLS_KEY, [])
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  },
  setSkillGlobalEnabled(skillId: string, enabled: boolean): void {
    const now = new Set(store.getDisabledSkillIds())
    if (enabled) now.delete(skillId)
    else now.add(skillId)
    repo.setKv(DISABLED_SKILLS_KEY, [...now])
  },

  // ── 会话转录(步骤 6 迁到 messages 表) ──
  getHistory(sessionId: string): readonly AgentMessage[] {
    return repo.getHistory(sessionId)
  },
  setHistory(sessionId: string, messages: readonly AgentMessage[]): void {
    const existing = repo.getSession(sessionId)
    if (existing === undefined) {
      // 兼容旧的 renderer：它可能在真正发送前就生成了 sessionId。
      repo.createSession({ id: sessionId, workspaceId: '', rootPathAtCreation: '' })
    }
    repo.replaceHistory(sessionId, messages)
  },

  // ── 会话实体 ──
  getInnerTabs(workspaceId: string): InnerTabState {
    const state = repo.getKv<InnerTabState>(innerTabKey(workspaceId), EMPTY_INNER)
    return { ...state, tabs: state.tabs.map((tab) => {
      // sessionId 为 null = 还没发过消息的草稿 Tab,库里没有它,标题就用 Tab 自己的
      const session = tab.kind === 'chat' && tab.ref.sessionId !== null ? repo.getSession(tab.ref.sessionId) : undefined
      const title = session?.workspaceId === workspaceId ? session.title : undefined
      return title === undefined || title === tab.title ? tab : { ...tab, title }
    }) }
  },
  createSession(input: SessionCreateInput): Session {
    return repo.createSession(input)
  },
  ensureSession(input: SessionCreateInput): Session {
    return repo.ensureSession(input)
  },
  putSession(session: Session): Session {
    return repo.putSession(session)
  },
  getSession(sessionId: string): Session | undefined {
    return repo.getSession(sessionId)
  },
  getSessionDetail(sessionId: string): SessionDetail | undefined {
    return repo.getSessionDetail(sessionId)
  },
  replaceHistory(sessionId: string, messages: readonly AgentMessage[]): void {
    repo.replaceHistory(sessionId, messages)
  },
  sessionAttachmentPaths(sessionId: string): string[] {
    return repo.sessionAttachmentPaths(sessionId)
  },
  getAttachmentRowByOwnerAndFileName(ownerId: string, fileName: string): repo.AttachmentRow | undefined {
    return repo.findAttachmentByOwnerAndFileName(ownerId, fileName)
  },
  listSessions(workspaceId: string, archived?: boolean): SessionListItem[] {
    return repo.listSessions(workspaceId, archived)
  },
  renameSession(sessionId: string, title: string): void {
    repo.renameSession(sessionId, title)
  },
  setSessionArchived(sessionId: string, archived: boolean): void {
    repo.setSessionArchived(sessionId, archived)
  },
  setSessionFavorited(sessionId: string, favorited: boolean): void {
    repo.setSessionFavorited(sessionId, favorited)
  },
  deleteSession(sessionId: string): void {
    // 未发出的输入、以及派生出来的子代理转录,都由 `repo.deleteSession` 一起收 ——
    // 它是整棵子树遍历的那一层,级联必须和遍历在同一处(见那边的注释)。
    repo.deleteSession(sessionId)
  },
  searchSessions(q: string, workspaceId?: string, limit = 50): SearchHit[] {
    return repo.searchAll(q, workspaceId, limit)
  },
  listContextCheckpoints(sessionId: string): ContextCheckpoint[] {
    return repo.listContextCheckpoints(sessionId)
  },
  getContextCheckpoint(id: string): ContextCheckpoint | undefined {
    return repo.getContextCheckpoint(id)
  },
  upsertContextCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
    return repo.upsertContextCheckpoint(checkpoint)
  },
  updateContextCheckpoint(id: string, note: string, revision: number, now: number): ContextCheckpoint {
    return repo.updateContextCheckpoint(id, note, revision, now)
  },
  searchSessionHistory(sessionId: string, q: string, limit = 5): ContextSearchHit[] {
    return repo.searchSessionHistory(sessionId, q, limit)
  },
  commitMessage(sessionId: string, message: AgentMessage): void {
    repo.commitMessage(sessionId, message)
  },
  setRunRecord(id: string, sessionId: string, status: string, startedAt: number, endedAt?: number): void {
    repo.setRunRecord(id, sessionId, status, startedAt, endedAt)
  },

  /**
   * 测试专用。转录是**跨 run 累积**的,而同一个文件里的用例通常共用一个
   * sessionId —— 不清的话第二个用例会看见第一个用例的对话,
   * 表现是断言里凭空多出几条消息。
   */
  clearHistoriesForTest(): void {
    repo.clearSessionDataForTest()
  }
}

// ─── kv 键名收在这里,不散落 ───

export const outerTabKey = (windowKind: string): string => `tabs.outer.${windowKind}`
export const innerTabKey = (workspaceId: string): string => `tabs.inner.${workspaceId}`

/**
 * 未发出的输入(草稿 + 插入队列)。
 *
 * ★ 复用 `kv` 而不是新建表:查询形状是**整行读、整行写**,每会话一行,
 * 字段还在演进 —— 与 `schema.ts` 给 kv 写的判据逐条对上,拆真列换不到
 * 任何查询能力,却要为 `QueuedInput` 的每次增删字段写一条迁移。
 */
export const sessionInputKey = (sessionId: string): string => `session.input.${sessionId}`

export const EMPTY_OUTER: WindowTabState = { outer: [], activeOuterId: null }
export const EMPTY_INNER: InnerTabState = { tabs: [], activeTabId: null }
