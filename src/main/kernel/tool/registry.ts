/**
 * ToolRegistry —— MCP 一等公民的落点(方案 §4.4)。
 *
 * MCP server 连上后,把 `listTools()` 的结果经**同一个 `register`** 塞进来。
 * Agent 循环完全不知道某个工具是内置、MCP 还是 Skill 带来的 —— 这才是
 * 「一等公民」的实际含义,也意味着只有一条权限链路、一套命名方案、一个执行路径。
 */
import type { ToolInfo, ToolProgress, ToolResult, ToolSource } from '../../../shared/agent/tool'
import type { PermissionMode } from '../../../shared/agent/permission'
import type { RunStatus } from '../../../shared/agent/event'
import type { AgentError } from '../../../shared/agent/error'
import type { KernelHost } from '../host'
import type { InteractFn } from '../interaction-gate'
import { isValidExternalName, sanitizeDescription, ToolNamer } from './naming'

/**
 * 工具能摸到的宿主能力,是 `KernelHost` 的**真子集**。少的两项是故意的:
 *
 * - `secrets`:注册表同时是 MCP 工具的入口(步骤 10),那些工具的代码不是我们写的。
 *   把 `secrets.get()` 递过去,等于 `host.ts` 里「明文 key 永不进内核」那条作废。
 * - `paths`:`userData` 在工作区外面。工具要么走路径围栏,要么根本不该碰路径。
 */
export type ToolHost = Pick<KernelHost, 'fs' | 'spawn' | 'fetch' | 'browserFetch' | 'clock' | 'logger'>

/**
 * 派一个子代理出去 —— `Task` 工具与外面那台机器之间**唯一**的接触面。
 *
 * ★ 这条窄缝的形状和 `SessionUpstream` 是同一个道理,理由也一样:
 * `Task` 住在内核里,而真正能建 run、能推事件给窗口的东西住在 `ipc/agent.ts`。
 * 让 `task.ts` 直接 import 它会形成 `ipc/agent → runtime → tools → task → ipc/agent`
 * 的环,并把 electron 拖进内核的 import 图 —— 那样 `agent-run.test.ts`
 * 「无头 Node 里跑完整条链路」的前提当场就没了。
 *
 * 缺省(`undefined`)= 这个环境里派不了子代理(纯内核测试)。`Task` 会
 * 当场 `toolFail` 并说清楚,而不是抛一个 `undefined is not a function`。
 */
export interface SubagentRequest {
  /** `agents/*.md` 里的 name。找不到时由实现方给出「当前可用:…」的错误 */
  subagentType: string
  /** 交给子代理的完整任务说明 —— 它**看不到当前对话** */
  prompt: string
  /** 3–8 个字的简述,给 UI 上那张卡片用 */
  description: string
  /** 父 run 的这次工具调用 id。`subagent_start/end` 要靠它把子 run 挂到这张卡片上 */
  callId: string
  /** 不等待结果，让父代理继续工作；子 run 仍在主进程中独立运行。 */
  background?: boolean
}

/**
 * 派子代理的两种结局。
 *
 * ★ 拆成两支、而不是把「名字不对」塞进 `status: 'error'`,是因为它们对模型
 * 意味着完全不同的事:`refused` 是**这次调用本身不成立**(名字敲错了、
 * 并发满了),该改的是入参;`finished` 是子代理真的跑了一遍,该看的是产出。
 * 混成一支的话,模型收到的是「子代理 reviewr 失败:没有名为 reviewr 的子代理」——
 * 它会以为那个子代理存在但坏了,于是原样再试一次。
 */
export type SubagentOutcome =
  /** 还没派出去就被拒。`reason` 是给模型看的完整人话,`Task` 原样转交。 */
  | { kind: 'refused'; reason: string }
  | {
      kind: 'finished'
      childRunId: string
      status: RunStatus
      /** 子代理最后一条助手消息的可见文字。`status !== 'done'` 时可能是空串 */
      text: string
      /** `status === 'error'` 时的原因 */
      error?: AgentError | string
    }
  | {
      kind: 'background'
      childRunId: string
    }

export type SpawnSubagentFn = (req: SubagentRequest) => Promise<SubagentOutcome>

/**
 * 工具执行时能拿到的一切。
 *
 * ★ `signal` 必填,且**必须真的传到 execute 体内**(方案 §4.3)。
 * 只中断 HTTP 流而不把 signal 传进工具体,会留下一堆僵尸 shell 和还在写的文件。
 */
export interface ToolContext {
  /** 工作区身份。浏览器工具用它做会话隔离；旧的无头调用可省略。 */
  workspaceId?: string
  workspaceRoot: string
  signal: AbortSignal
  /** 运行期快照 —— run 开始时定死 */
  permissionMode: PermissionMode
  /** 子代理深度,0 = 主 run */
  depth: number
  /** 本次调用的 id,进度事件要带 */
  callId: string
  /** 所属 run。子代理要用它当 parentRunId,日志也靠它把工具调用归到某次运行 */
  runId: string
  /**
   * ★ 宿主**从 ctx 传进来,不在工具里闭包捕获**。
   *
   * `getTools()` 是进程内单例,而 `installHost()` 只重建 `router`、不动 `tools`
   * (见 runtime.ts)。工厂闭包意味着换宿主之后已注册的工具还攥着旧的那个;
   * 而让 `installHost` 顺手重建 `tools`,又会重建 `ToolNamer` 并丢掉运行期注册的
   * MCP 工具 —— 而 naming.ts 写明了映射在会话内必须稳定(转录里存的是 externalName)。
   * ctx 每次调用现造,所以它天然是「当下那个宿主」。
   */
  host: ToolHost
  /** 进度是**易失的**:单独的事件类型,永不写入转录 */
  emit(progress: ToolProgress): void
  /**
   * 派子代理。只有 `Task` 用得到,所以是可选的 —— 让每个工具的
   * ctx 都必须带上一个它永远不会碰的函数,是没有道理的。
   */
  spawnSubagent?: SpawnSubagentFn
  interact?: InteractFn
}

/**
 * 运行时的工具。
 *
 * ★ 定义在 main 而不是 shared,因为 `execute` 是闭包 —— 过不了 IPC。
 * 渲染层拿到的是它的 `ToolInfo` 部分(审批弹窗要显示名字与入参)。
 *
 * 不拆 `ToolDefinition` / `ToolExecutor`:只有定义要跨网络传输时才划算,
 * 而那时执行器无论如何是闭包(方案 §10)。
 */
export interface Tool extends ToolInfo {
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

/** 注册方提供的东西 —— **没有 externalName**,那是注册表算出来的 */
export interface ToolRegistration extends Omit<ToolInfo, 'externalName'> {
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface SnapshotFilter {
  /** plan 模式:过滤掉所有写工具(方案 §4.8) */
  readOnlyOnly?: boolean
  /**
   * Skill frontmatter 的 `allowedTools`。作者写的可能是 internalId 也可能是
   * externalName —— 两边都认,因为让用户去猜我们内部用哪个名字是没有道理的。
   */
  allowList?: readonly string[]
  /**
   * 工作区的「联网」开关(`WorkspaceSettings.webSearch`)。
   *
   * ★ 关掉时**根本不下发**联网工具,而不是下发了再在调用时拒绝。
   * 后者也拦得住(`permission-gate.ts` 那张表的第 1 行),但代价是模型先花一轮
   * 去调一个注定被拒的工具 —— 用户看到的是「它先试了一次搜索,被拒,才回答」。
   * 那道闸仍然留着:它挡的是「这一轮下发之后开关被关掉」的窗口,以及
   * 任何绕过快照的调用路径。两道各挡一件事,不重复。
   *
   * 缺省(`undefined`)= 不过滤。这是刻意的:`snapshot()` 有一堆调用点
   * (Skill、子代理、诊断),它们不该因为忘了传这个字段就把联网工具全弄没了 ——
   * 真正承重的那道闸在 `permission-gate.ts`,而它不看这个字段。
   */
  network?: boolean
}

function sourceKey(s: ToolSource): string {
  switch (s.kind) {
    case 'builtin':
      return 'builtin'
    case 'mcp':
      return `mcp:${s.serverId}`
    case 'skill':
      return `skill:${s.skillId}`
  }
}

export class ToolRegistry {
  /** internalId → Tool。**插入顺序即快照顺序**,让下发给模型的工具列表稳定。 */
  private readonly tools = new Map<string, Tool>()
  private readonly namer = new ToolNamer()

  /**
   * 注册(或替换)一个工具。返回补全了 `externalName` 的运行时对象。
   *
   * 重复的 internalId 是**替换**而不是报错 —— MCP server 重连时会原样再注册一遍,
   * 那是正常路径,不是错误。因为 externalName 由 internalId 记忆,替换后名字不变,
   * 历史转录里的引用仍然对得上。
   */
  register(reg: ToolRegistration): Tool {
    const externalName = this.namer.nameFor(reg.internalId)
    /* c8 ignore next 3 */
    if (!isValidExternalName(externalName)) {
      throw new Error(`为 ${reg.internalId} 生成的 externalName 非法:${externalName}`)
    }
    const tool: Tool = {
      ...reg,
      externalName,
      // ⚠️ 不可信输入的收口点:MCP / Skill 的描述直接进系统提示词
      description: sanitizeDescription(reg.description)
    }
    this.tools.set(reg.internalId, tool)
    return tool
  }

  /**
   * 下线一个来源的全部工具(MCP server 断开、Skill 停用)。
   *
   * ★ 若该源某个工具**正在执行,不能打断它**(方案 §4.4)。
   * 这里天然满足:执行方在调用前就持有了 `Tool` 对象的引用,
   * 从 map 里删掉不影响那个引用 —— 前提是执行方**不在完成时回注册表重新查找**。
   */
  unregisterBySource(source: ToolSource): number {
    const key = sourceKey(source)
    let n = 0
    for (const [id, t] of this.tools) {
      if (sourceKey(t.source) === key) {
        this.tools.delete(id)
        n++
      }
    }
    return n
  }

  /**
   * ★ **每轮开始时取一次**(方案 §4.4)。
   *
   * 这样 server 中途断开产出的是一个工具错误(下一轮它就不在列表里了),
   * 而不是崩溃 —— 也不会出现「下发的工具列表里有,执行时却找不到」的错位。
   */
  snapshot(filter: SnapshotFilter = {}): Tool[] {
    const allow = filter.allowList === undefined ? undefined : new Set(filter.allowList)
    const out: Tool[] = []
    for (const t of this.tools.values()) {
      if (filter.readOnlyOnly === true && !t.readOnly) continue
      if (filter.network === false && t.needsNetwork) continue
      if (allow !== undefined && !allow.has(t.internalId) && !allow.has(t.externalName)) continue
      out.push(t)
    }
    return out
  }

  /**
   * 模型回传的是 externalName —— 这是把它换回工具的唯一入口。
   *
   * 返回 undefined 有两种含义,调用方都该当成**工具错误**而不是崩溃:
   * 名字是模型编的,或者工具在这一轮进行中被下线了。
   */
  resolveByExternalName(name: string): Tool | undefined {
    const internalId = this.namer.toInternal(name)
    return internalId === undefined ? undefined : this.tools.get(internalId)
  }

  byInternalId(internalId: string): Tool | undefined {
    return this.tools.get(internalId)
  }

  /** 给 IPC `agent:listTools` 用 —— 去掉 execute 之后才过得了结构化克隆 */
  info(filter: SnapshotFilter = {}): ToolInfo[] {
    return this.snapshot(filter).map(({ execute: _execute, ...info }) => info)
  }

  get size(): number {
    return this.tools.size
  }
}
