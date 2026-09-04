/**
 * 主进程状态的访问器。**除会话转录外都已经落在 SQLite 里**(`src/main/db/`)。
 *
 * 这一层刻意保留下来,没有让 handler 直接调 `db/repo`:
 *
 * - 它是**唯一的收口点**。全应用没有第二个地方摸持久化,所以「把 Db 挪进
 *   `utilityProcess`」那天要改的仍然只有这一层的实现(`DatabaseSync` 是同步的,
 *   迟早要挪 —— 理由写在 `db/index.ts` 文件头)。
 * - kv 的键名(`outerTabKey` / `innerTabKey`)属于这一层的词汇,不属于数据库。
 * - 转录还在内存里,而调用点不需要知道哪些字段落了盘、哪些没有。
 *
 * 当初那句「步骤 6 的迁移只该是『实现换掉』,不该是『调用点全改』」就是为这一刻写的:
 * 这次替换**没有改动任何一个访问器的签名**,同目录的 `__tests__/store.test.ts`
 * 原样跑过。
 */
import type { AgentMessage } from '../../shared/agent/message'
import type { ModelAlias, UpstreamProvider } from '../../shared/domain/provider'
import type { AppSettings, AppSettingsPatch } from '../../shared/domain/settings'
import type { InnerTabState, WindowTabState } from '../../shared/domain/tab'
import type { Workspace } from '../../shared/domain/workspace'
import * as repo from '../db/repo'

/**
 * 会话转录。**仍然是内存 Map —— 步骤 6 才换成 `messages` 表 + FTS5。**
 * `db/index.ts` 文件头那张表画了确切的界。
 *
 * 在那一步之前它不能不存在:`AgentSession` 的 `history` 缺省是空转录,
 * 于是每一轮模型都从零开始 —— 界面上明明有三轮问答,模型却看不见前两轮。
 * 那不是「步骤 6 还没做」,是对话功能是坏的。
 *
 * 内存无上限,这是它是临时实现的一部分。
 */
const transcripts = new Map<string, AgentMessage[]>()

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

  // ── kv(窗口/Tab 布局等易失 UI 状态) ──
  getKv<T>(key: string, fallback: T): T {
    return repo.getKv(key, fallback)
  },
  setKv(key: string, value: unknown): void {
    repo.setKv(key, value)
  },

  // ── 会话转录(步骤 6 迁到 messages 表) ──
  getHistory(sessionId: string): readonly AgentMessage[] {
    return transcripts.get(sessionId) ?? []
  },
  setHistory(sessionId: string, messages: readonly AgentMessage[]): void {
    transcripts.set(sessionId, [...messages])
  },

  /**
   * 测试专用。转录是**跨 run 累积**的,而同一个文件里的用例通常共用一个
   * sessionId —— 不清的话第二个用例会看见第一个用例的对话,
   * 表现是断言里凭空多出几条消息。
   */
  clearHistoriesForTest(): void {
    transcripts.clear()
  }
}

// ─── kv 键名收在这里,不散落 ───

export const outerTabKey = (windowKind: string): string => `tabs.outer.${windowKind}`
export const innerTabKey = (workspaceId: string): string => `tabs.inner.${workspaceId}`

export const EMPTY_OUTER: WindowTabState = { outer: [], activeOuterId: null }
export const EMPTY_INNER: InnerTabState = { tabs: [], activeTabId: null }
