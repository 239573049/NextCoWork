/**
 * 运行时装配 —— 把内核的几个零件接成一台能跑的机器,并持有它们的单例。
 *
 * ★ **本文件零 electron import**,尽管它住在 `src/main/` 下。
 *
 * 宿主由 `main/index.ts` 在 app ready 之后经 `initRuntime(electronHost())` 注入。
 * 反过来写(runtime 直接 `import { electronHost }`)会让 `ipc/agent.ts` 的整条
 * import 链拖进 electron —— 而 `agent-pump.test.ts` 与 `agent-run.test.ts` 能在
 * 无头 Node 里跑完 IPC 泵与整条 Agent 链路,靠的正是这条链是干净的。
 * 哪天有人在这里加一个 electron 的**值**导入,挂的会是那两个测试,而那是正确的报警。
 *
 * 它存在的另一个理由是**收口**:`ipc/agent.ts` 只该关心「合批与推送」,
 * 不该同时知道 provider 表长什么样、工具在哪注册、演示上游挂在哪一层。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRequest } from '../shared/agent/run-request'
import { MAX_DEPTH } from '../shared/agent/run-request'
import type { RunStatus } from '../shared/agent/event'
import { visibleText } from '../shared/agent/message'
import type { AgentDefinition } from '../shared/domain/agent-def'
import { minPermission } from '../shared/agent/permission'
import { DEFAULT_WORKSPACE_SETTINGS } from '../shared/domain/workspace'
import type { ApproveFn } from './kernel/agent-session'
import { AgentSession } from './kernel/agent-session'
import type { KernelHost } from './kernel/host'
import { nodeHost } from './kernel/host'
import { ASK_NOT_WIRED_YET, TOOLS_NEEDING_NETWORK, evaluate } from './kernel/permission-gate'
import type { RunHandle } from './kernel/run-registry'
import { runs } from './kernel/run-registry'
import { AGENTS_DIR, PROJECT_AGENTS_PREFIX, scanAgents } from './kernel/agent/load'
import { agentRegistry } from './kernel/agent/registry'
import type { Skill } from '../shared/domain/skill'
import { PROJECT_SKILLS_PREFIX, SKILLS_DIR, scanSkills } from './kernel/skill/load'
import { skillRegistry } from './kernel/skill/registry'
import { builtinTools } from './kernel/tool/builtin'
import { taskTool } from './kernel/tool/builtin/task'
import type { SpawnSubagentFn } from './kernel/tool/registry'
import { ToolRegistry } from './kernel/tool/registry'
import { McpManager } from './mcp/manager'
import { installSearchConfig } from './search/service'
import { DEMO_ALIAS, DEMO_ALIASES, DEMO_PROVIDER, withDemo } from './kernel/upstream/demo'
import type { ProviderConfigSource } from './kernel/upstream/router'
import { UpstreamRouter } from './kernel/upstream/router'
import { searchSecretRef } from '../shared/domain/search'
import { searchStatuses } from './search/status'
import { store } from './state/store'

let host: KernelHost | null = null
let router: UpstreamRouter | null = null
let tools: ToolRegistry | null = null
let mcp: McpManager | null = null
let seeded = false

/**
 * 谁来广播 MCP 的状态变化。
 *
 * ★ 这个插槽的存在,是本文件那条「零 electron import」铁律的直接后果:
 * 广播要 `windows.emitToAll`,而 `window/registry` 拖着 electron ——
 * 一旦从这里 import 它,`agent-pump.test.ts` 那条无头链路当场断。
 * 所以由 `ipc/mcp.ts`(那一侧本来就在 electron 里)在 `registerIpc()` 时装进来,
 * 和 `registerThemeBridge()` 是同一种接线。
 *
 * 没装(测试里)时是一次 no-op,而不是「状态变了但没人知道」—— 因为测试里
 * 根本没有窗口可广播。
 */
let mcpOnChange: ((id: string) => void) | null = null

/**
 * 装宿主。**必须在第一个 run 之前**,由 `main/index.ts` 在 `app.whenReady()` 里调用 ——
 * `safeStorage` 与 `net.fetch` 都要求 app ready。
 */
export function installHost(h: KernelHost): void {
  host = h
  /*
    ★ 搜索服务的 Key 访问器。装在这里(而不是 `initRuntime`)是因为
    换宿主就得换访问器 —— 它闭包捕获的是 `h`,不是 `getHost()`。
    捕获后者的话这段代码本身没问题,但它会掩盖「谁依赖宿主」这件事。

    工具那一侧拿不到 `secrets`(`ToolHost` 里没有),所以这是明文 Key
    在整个工具链上的唯一入口,且它不经过 `ToolContext`。
  */
  installSearchConfig({
    statuses: () => searchStatuses(h.secrets),
    apiKey: (id) => h.secrets.get(searchSecretRef(id))
  })
  // 路由器在构造时就抓住了 host 的引用,换宿主必须让它重建,
  // 否则新装的宿主对已经建好的路由器完全不起作用
  router = null
}

export function getHost(): KernelHost {
  /**
   * 没装过就用 `nodeHost` + 演示上游。这**不是测试替身**:`host.ts` 的文件头
   * 已经把 `nodeHost()` 定义成真实默认值,Electron 侧只覆盖 paths/secrets/fetch 三项。
   * 于是无头测试跑的是和 dev 完全同一条装配路径,只是宿主换了一层皮。
   */
  host ??= withDemo(nodeHost())
  return host
}

/**
 * 路由器的配置来源。用函数而不是快照数组:设置页改完 provider 立刻生效,
 * 不必重建路由器(见 `ProviderConfigSource` 的注释)。
 */
const providerConfig: ProviderConfigSource = {
  providers: () => store.listProviders(),
  aliases: () => store.listAliases(),
  failoverEnabled: () => store.getSettings().gateway.failover
}

/**
 * 内置演示上游进表。
 *
 * ★ **总是进**,不是「没有别的 provider 时才进」。它的 priority 是 100(全表最低),
 * 真 provider 一配上就压过它;别名 `nextcowork-demo` 也不会和任何真别名撞。
 * 于是「什么时候该有演示上游」这个问题根本不需要答案 —— 它一直在,
 * 选不选是用户的事。反过来做成条件注册,就得回答「配了真 key 之后演示上游
 * 该不该消失」,而两个答案都会让某个人在某天困惑。
 */
function seed(): void {
  if (seeded) return
  seeded = true
  store.putProvider(DEMO_PROVIDER)
  for (const alias of DEMO_ALIASES) store.putAlias(alias)

  /**
   * 没配过模型 = 全新安装。指向演示上游,第一次点发送就有东西可看,
   * 不必先去设置页填 key —— 这正是内置演示上游存在的理由。
   *
   * 常量留在 main 侧而不是写进 `DEFAULT_SETTINGS`:`src/shared/` 不能
   * 反向 import `src/main/`,而演示上游是 main 的东西。
   */
  if (store.getSettings().defaultModel === '') {
    store.updateSettings({ defaultModel: DEMO_ALIAS })
  }

  seedDefaultWorkspace()
}

/**
 * 默认工作区 —— 和演示上游同一个理由:**全新安装点开就能用**。
 *
 * 没有它,首屏的外层 Tab 条是空的,侧边栏下半是空态,输入框没有 workspaceId
 * 可以发 —— 用户必须先经「打开文件夹」选一个目录才能看见这个应用长什么样。
 * 而参考实现里那个「默认工作区」正是这个位置(定时任务页的筛选器里
 * `全部工作区 / 默认工作区 / NextCoWork` 就是它和真实工作区并列)。
 *
 * 根目录落在 userData 下而**不是** `process.cwd()`:打包后 cwd 在应用包内部,
 * 步骤 9 的 fs 工具就会以「围栏之内」的名义写进应用包里。
 *
 * 建目录失败不该拦住启动 —— 标 `unavailable` 就是 `Workspace` 上那个字段
 * 存在的理由(方案 §9:「工作区根会在运行期被删除或改名,加载时标记
 * unavailable 而不是崩溃」)。
 */
const DEFAULT_WORKSPACE_ID = 'ws-default'

function seedDefaultWorkspace(): void {
  if (store.getWorkspace(DEFAULT_WORKSPACE_ID) !== undefined) return
  // 用户自己开过工作区就不再塞默认的 —— 否则每次启动都多一个他没要的 Tab
  if (store.listWorkspaces().length > 0) return

  const rootPath = join(getHost().paths.userData(), 'workspaces', 'default')
  let unavailable = false
  try {
    mkdirSync(rootPath, { recursive: true })
  } catch (err) {
    getHost().logger.warn(`[runtime] 默认工作区目录建不出来,标为不可用:${String(err)}`)
    unavailable = true
  }

  const now = getHost().clock.now()
  store.putWorkspace({
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区',
    rootPath,
    ...(unavailable ? { unavailable: true } : {}),
    settings: structuredClone(DEFAULT_WORKSPACE_SETTINGS),
    createdAt: now,
    lastOpenedAt: now
  })
}

/**
 * seed 的公开触发点。
 *
 * `getRouter()` 也会 seed,但首屏拉 provider / 模型列表时可能一个 run 都还没跑过 ——
 * 那时下拉框会是空的,而设置里的 defaultModel 已经指着演示上游了。
 * 两处指向同一个 `seed()`,所以「什么时候 seed 过了」只有一个答案。
 */
export function ensureSeeded(): void {
  seed()
}

export function getRouter(): UpstreamRouter {
  seed()
  router ??= new UpstreamRouter(getHost(), providerConfig)
  return router
}

export function getTools(): ToolRegistry {
  if (tools === null) {
    tools = new ToolRegistry()
    // 步骤 9 的 fs/bash、步骤 10 的 MCP、步骤 11 的 task 都从这里进来,
    // 且都经**同一个** register —— 那是消毒与命名的唯一收口点(方案 §4.4)
    for (const reg of builtinTools()) tools.register(reg)
  }
  return tools
}

/**
 * MCP 运行时。和 `getTools()` 同款惰性单例。
 *
 * ★ 它**必须**拿到 `getTools()` 返回的那一个注册表,而不是自己新建一个 ——
 * MCP 工具和内置工具要一起出现在同一次 `snapshot()` 里,否则模型看得见
 * `Read` 却看不见刚连上的服务器带来的工具。
 */
export function getMcp(): McpManager {
  if (mcp === null) {
    const h = getHost()
    mcp = new McpManager({
      tools: getTools(),
      secrets: h.secrets,
      logger: h.logger,
      onChange: (id) => mcpOnChange?.(id)
    })
  }
  return mcp
}

/** 由 `ipc/mcp.ts` 在 `registerIpc()` 里装上 —— 理由见 `mcpOnChange` 的注释 */
export function setMcpChangeListener(fn: (id: string) => void): void {
  mcpOnChange = fn
}

/**
 * 退出时收摊。**只在真的建过 manager 时动手** —— 用 `getMcp()` 会在一个
 * 从没连过 MCP 的进程里凭空造一个出来,只为了立刻关掉它。
 */
export async function shutdownMcp(): Promise<void> {
  await mcp?.shutdown()
}

/** app ready 时调一次。seed 提前跑,好让首屏的 bootstrap 已经带上默认模型。 */
export function initRuntime(h: KernelHost): void {
  installHost(h)
  seed()
  /*
    ★ **后台拉起,不 await。**每台服务器的握手有 30 秒预算,而 stdio 那一支
    还要先 `npx` 下一个包 —— 串起来足够让首屏白屏十几秒。
    连不上的那些会各自落到 `state:'error'` 并经 `mcp:changed` 播出去,
    设置页照实显示;对话那一侧只是少几个工具,不是启动不了。
  */
  getMcp().connectEnabledInBackground(store.listMcpServers())
}

/**
 * 会话绑定的工作区根。**查不到就给空串,不给回落目录。**
 *
 * 这里以前回落到 `paths.temp()`。★ 那是个会安静地骗人的默认值:模型以为自己
 * 在用户的项目里干活,于是把文件写进一个谁也不会去看的目录,然后报告「已完成」。
 * 打包后回落到 `process.cwd()` 更糟 —— 那是应用包内部,文件工具会以「围栏之内」
 * 的名义往应用包里写。
 *
 * 空串意味着 `resolvePath`(`tool/builtin/paths.ts`)对每一次路径调用都直接拒绝,
 * 并告诉模型「先让用户打开一个工作区」。宁可一步都走不动,也不要走错地方。
 *
 * 批次 5 会更进一步:没有工作区时**根本不下发**碰路径的工具(经 `SessionDeps.allowedTools`),
 * 那样模型连试都不会试。这一步先把安全相关的那一半落地。
 */
function workspaceRootFor(workspaceId: string): string {
  return store.getWorkspace(workspaceId)?.rootPath ?? ''
}

/**
 * 重扫两层 Skill 目录,结果整体换进注册表。
 *
 * ★ **每次发送前扫一遍**,不是启动时扫一次。用户在 `.nextcowork/skills/` 里
 * 放一条新的 Skill 之后,期待的是「下一次提问它就知道了」——「重启应用才生效」
 * 这件事没有任何地方会提示他。代价是两次 readDir,和一次上游往返比可以忽略。
 *
 * ★ 这个函数住在 runtime 而不是 `ipc/skills.ts`:它只需要 `getHost().paths`
 * 和 `store`,两样这里都有,而反过来会让内核的装配依赖 IPC 层。
 */
export async function refreshSkills(workspaceId: string): Promise<void> {
  const h = getHost()
  const root = workspaceRootFor(workspaceId)
  const result = await scanSkills({
    fs: h.fs,
    globalRoot: join(h.paths.userData(), SKILLS_DIR),
    projectRoot: root === '' ? '' : join(root, PROJECT_SKILLS_PREFIX, SKILLS_DIR)
  })
  // 诊断只记日志,不阻断:一条坏掉的 SKILL.md 不该让别的都用不了
  for (const d of result.diagnostics) h.logger.warn(`[skill] ${d.path}: ${d.message}`)
  skillRegistry().replaceAll(result)
}

/**
 * 这一轮真正要下发目录的那几条。
 *
 * 两道筛子,分别是两个不同的问题:`resolve()` 回答「这个工作区装了哪些」
 * (空清单 = 全都要,理由在 `SkillRegistry.resolve` 上),
 * `globalEnabled` 回答「用户有没有在设置里把它整个关掉」。
 */
function activeSkills(req: RunRequest): readonly Skill[] {
  const disabled = new Set(store.getDisabledSkillIds())
  return skillRegistry()
    .resolve(req.skillIds)
    .filter((s) => !disabled.has(s.id))
}

/**
 * 重扫两层子代理目录,结果整体换进注册表,**并用新清单重新注册 `Task` 工具**。
 *
 * ★ 第二件事不能省。`Task` 的 description 里逐字带着可用子代理的清单
 * (照搬 CC),而 description 是在 `register()` 的那一刻定死的字符串 ——
 * 不重注册的话,用户刚放进 `.nextcowork/agents/` 的那个代理**存在、能派、
 * 但模型看不见它**,而这件事没有任何症状。
 *
 * `register()` 按 internalId 幂等替换且保住 externalName,所以重注册不会让
 * 历史转录里的 `Task` 引用失配(见 `ToolRegistry.register` 的注释)。
 */
export async function refreshAgents(workspaceId: string): Promise<void> {
  const h = getHost()
  const root = workspaceRootFor(workspaceId)
  const result = await scanAgents({
    fs: h.fs,
    globalRoot: join(h.paths.userData(), AGENTS_DIR),
    projectRoot: root === '' ? '' : join(root, PROJECT_AGENTS_PREFIX, AGENTS_DIR)
  })
  for (const d of result.diagnostics) h.logger.warn(`[agent] ${d.path}: ${d.message}`)
  agentRegistry().replaceAll(result)
  getTools().register(taskTool())
}

// ─────────────────────────── 子代理 ───────────────────────────

/**
 * 谁来真的把子 run 建起来并推给渲染层。
 *
 * ★ 这个插槽和 `mcpOnChange` 是同一种接线,理由也一样:真正能建 run + 继承
 * 窗口订阅的是 `ipc/agent.ts` 的 `startChildRun`,而它拖着 electron ——
 * 从这里 import 它,`agent-run.test.ts` 那条无头链路当场就断了。
 * 方向必须是 **ipc 依赖 runtime,runtime 永不依赖 ipc**。
 *
 * 没装(纯内核测试)时降级成 `runs.create` + 直接跑:run 照跑,只是事件
 * 不推给任何窗口 —— 而无头测试里本来就没有窗口。
 */
export type ChildRunLauncher = (
  parent: RunHandle,
  req: RunRequest,
  driver: (handle: RunHandle, req: RunRequest) => Promise<void>
) => RunHandle

let childRunLauncher: ChildRunLauncher | null = null

export function installChildRunLauncher(fn: ChildRunLauncher): void {
  childRunLauncher = fn
}

/** 同一个父 run 名下最多同时跑几个子代理。超了直接拒,**不排队**(排队要配调度器和取消语义)。 */
const MAX_CONCURRENT_SUBAGENTS = 4

/** 子 runId 的序号。进程内单调递增就够 —— 它只需要在本进程里唯一。 */
let childSeq = 0

/**
 * 等一个 run 结束。
 *
 * ★ 先判 `status` 再挂监听,两件事都要做:`RunHandle.emit` 在发出 `run_end`
 * 之后会 `listeners.clear()`,所以晚一步挂上去的监听器**永远不会被调用**,
 * 表现是这个 Promise 永远不 resolve —— 父代理就卡在那次工具调用上,
 * 直到用户点停止。
 */
function waitForEnd(handle: RunHandle): Promise<RunStatus> {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      resolve(handle.status)
      return
    }
    const off = handle.on((ev) => {
      if (ev.type !== 'run_end') return
      off()
      resolve(ev.status)
    })
  })
}

/**
 * 子 run 的 `RunRequest`。三处继承规则各自挡着一种真实的坏结果。
 */
function childRequestFor(
  parentReq: RunRequest,
  parent: RunHandle,
  def: AgentDefinition,
  childRunId: string,
  prompt: string
): RunRequest {
  return {
    runId: childRunId,
    /*
      ★ **独立且派生的 sessionId。**复用父的那个,会被 `store.setHistory`
      整数组覆盖直接毁掉:父子并发跑完,谁后 `finally` 谁赢,父的转录凭空少几轮。
      派生还顺手回答了「子 run 的转录从哪儿读」—— `getHistory` 天然是 `[]`,
      而全新的上下文窗正是子代理存在的意义,不用特判。
    */
    sessionId: `${parentReq.sessionId}:sub:${childRunId}`,
    // 同一个工作区 = 同一道路径围栏。子代理换不了工作区。
    workspaceId: parentReq.workspaceId,
    parentRunId: parent.runId,
    depth: parentReq.depth + 1,
    input: [{ type: 'text', text: prompt }],
    /*
      ★ plan **必须传染**,normal / goal 一律降成 normal。
      不传染 plan:规划模式下可以借子代理写盘,那道围栏就白建了。
      传染 goal:MAX_TURNS_GOAL × N 个子代理,是一颗成本炸弹。
    */
    mode: parentReq.mode === 'plan' ? 'plan' : 'normal',
    thinking: parentReq.thinking,
    // 联网是用户的硬开关,子代理放宽不了
    webSearch: parentReq.webSearch,
    /*
      ★ 取 min,不是取子代理声明的那个。否则一个被投毒的 MCP 工具描述
      可以诱导主 agent 派一个子 agent 去做它自己不被允许做的事 ——
      这是**真实的提权路径**,不是理论风险(见 `minPermission` 的注释)。
    */
    permissionMode: minPermission(parentReq.permissionMode, def.permissionMode ?? 'full'),
    model: def.model ?? parentReq.model,
    skillIds: parentReq.skillIds,
    agentType: def.name
  }
}

/**
 * `ToolContext.spawnSubagent` 的生产实现 —— 三道闸门 + 建 run + 等结果。
 *
 * ★ 它住在 runtime 而不是 `task.ts`,因为只有这里同时握着**父 handle**
 * (要在它身上发 `subagent_start/end`)和 store(要取子代理的产出)。
 * `ctx.emit` 只会发 `tool_progress`,发不了子代理事件。
 */
function spawnSubagentFor(parent: RunHandle, parentReq: RunRequest): SpawnSubagentFn {
  return async (sub) => {
    /*
      ★ 深度在这里**再断言一次**,尽管 `Task.run` 第一行已经判过。
      那一道是给模型看的(告诉它为什么、以及改做什么),这一道是给代码看的 ——
      防的是将来别的调用方绕过 `Task` 直接调这个函数。
    */
    if (parentReq.depth >= MAX_DEPTH) {
      return {
        kind: 'refused',
        reason:
          `The subagent nesting limit of ${String(MAX_DEPTH)} levels has been reached. ` +
          `Do this step yourself.`
      }
    }

    const def = agentRegistry().get(sub.subagentType)
    if (def === undefined) {
      /*
        ★ **绝不静默回落到 general-purpose。**名字敲错的用户会拿到一份
        「看起来对」的、由错误代理产出的结果,而且永远不会发现。
        把可用清单列全,模型下一次就能选对,或者判断出没有合适的。
      */
      return {
        kind: 'refused',
        reason:
          `There is no subagent named "${sub.subagentType}". Available: ${agentRegistry().names().join(', ')}. ` +
          `Pick one from that list, or skip the subagent and do this step yourself.`
      }
    }

    if (runs.activeChildCount(parent.runId) >= MAX_CONCURRENT_SUBAGENTS) {
      return {
        kind: 'refused',
        reason:
          `The concurrent subagent limit of ${String(MAX_CONCURRENT_SUBAGENTS)} has been reached. ` +
          `Wait for the running ones to finish before launching another, or carry on yourself.`
      }
    }

    const childRunId = `${parent.runId}:sub:${String(++childSeq)}`
    const childReq = childRequestFor(parentReq, parent, def, childRunId, sub.prompt)

    parent.emit({ type: 'subagent_start', callId: sub.callId, childRunId })

    const launch =
      childRunLauncher ??
      /*
        没装启动器时的降级路径。run 照跑,只是不推给任何渲染层 ——
        这恰好是无头测试想要的形状,所以它不是「测试替身」,是一条真实的降级。
      */
      ((_p: RunHandle, r: RunRequest, driver: (h: RunHandle, rr: RunRequest) => Promise<void>) => {
        const h = runs.create(r)
        void driver(h, r)
        return h
      })

    /*
      ★ 除了 handle,还要攥住 driver 那个 promise —— 光等 `run_end` 是**不够**的。

      `runAgent` 的形状是 `session.run().finally(() => store.setHistory(...))`:
      `run_end` 在 `run()` 里面就发出去了,而写转录发生在它**之后**的那个
      `finally` 里。只等 handle 的话,这里读到的 history 会是空的 ——
      于是每一次子代理都被报成「结束时没有产出任何文字」,而它明明说了话。
    */
    let finished: Promise<void> | undefined
    const child = launch(parent, childReq, (h, r) => {
      finished = runAgent(h, r, def)
      return finished
    })
    const status = await waitForEnd(child)
    // 失败已经体现在 status 里了,这里只是等 finally 跑完
    if (finished !== undefined) await finished.catch(() => {})

    parent.emit({ type: 'subagent_end', callId: sub.callId, childRunId, status })

    /*
      产出 = 子代理最后一条 assistant 消息的可见文字。
      ★ 取的是转录而不是某个「结果」字段,因为子代理本来就没有别的出口 ——
      它和主代理跑的是同一条循环,`agentPrompt` 里已经写明「只有最后一条消息
      会被送回去」。
    */
    const history = store.getHistory(childReq.sessionId)
    const last = [...history].reverse().find((m) => m.role === 'assistant')
    return {
      kind: 'finished',
      childRunId,
      status,
      text: last === undefined ? '' : visibleText(last)
    }
  }
}

/**
 * 权限闸门的**接线**处 —— 策略在 `kernel/permission-gate.ts`,这里只负责把
 * 一次 run 的档位、联网开关和被调工具的标记喂进去,再把结果翻译成 `PermissionDecision`。
 *
 * ★ 分成两段是有意的:`evaluate()` 是纯函数、可穷举测,而「`ask` 这一档暂时怎么办」
 * 是**产品决定**,会随审批对话框落地而变。让 `evaluate()` 直接返回 deny 的话,
 * 那张策略表就再也读不出「这里本该问用户」这件事了。
 *
 * ★ `needsNetwork` 是**取或**,不是二选一:工具自己声明的那个字段,
 * 加上 `TOOLS_NEEDING_NETWORK` 这张下限表。表里的名字无论字段怎么填都算联网,
 * 所以一个字段被写错(或将来某个注册路径忘了填)也放不宽这道闸。
 * 为什么不只留表、也不只留字段,`TOOLS_NEEDING_NETWORK` 的注释写全了。
 */
function approveWith(req: RunRequest): ApproveFn {
  // 契约要求返回 Promise;策略本身是同步的纯函数
  return async ({ tool }) => {
    const outcome = evaluate({
      mode: req.permissionMode,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      needsNetwork: tool.needsNetwork || TOOLS_NEEDING_NETWORK.has(tool.internalId),
      webSearch: req.webSearch
    })
    if (outcome.kind === 'allow') return { kind: 'allow_once' }
    if (outcome.kind === 'deny') return { kind: 'deny', reason: outcome.reason }
    /*
      ★ 「需要询问」这一档在这个版本里统一降级为**拒绝**,理由和原文都在
      `ASK_NOT_WIRED_YET` 那个常量上。这里不能返回 `allow_once` 兜底 ——
      那等于「审批还没做好,所以先全放行」,恰好是这道闸门要防的事。
    */
    return { kind: 'deny', reason: ASK_NOT_WIRED_YET }
  }
}

/**
 * 生产路径的 run 驱动 —— **`ipc/agent.ts` 的默认驱动**。
 * 假发射器从此只是 pump 测试的夹具。
 *
 * `AgentSession.run()` 承诺不抛异常(结局一律经 `handle.finish`),
 * 所以这里不需要 catch;真加一个 catch 反而会掩盖那个承诺哪天被破坏。
 */
export async function runAgent(
  handle: RunHandle,
  req: RunRequest,
  /**
   * 这个 run 由哪个子代理跑。**由启动器闭包传进来,不在这里查注册表**:
   * 查的话,派出去和真的跑起来之间夹着一次目录重扫,拿到的可能已经是
   * 另一份定义了 —— 而模型看到的工具清单还是派出去那一刻的。
   */
  agent?: AgentDefinition
): Promise<void> {
  /*
    ★ 扫描在**建 session 之前**。系统提示词是在第一轮组装时定下来的,
    晚一步扫的话这一轮的目录还是上一轮那份 —— 用户刚装的那条 Skill
    要到下一次提问才出现,而他会以为是没装上。

    ★ 子 run **不重扫**:它的定义在派出去那一刻就定死了(见上面的 `agent` 参数),
    而重扫会在父代理正跑着的时候把 `Task` 的 description 换掉。
  */
  if (agent === undefined) {
    await refreshSkills(req.workspaceId)
    await refreshAgents(req.workspaceId)
  }

  const session = new AgentSession(
    {
      host: getHost(),
      upstream: getRouter(),
      tools: getTools(),
      workspaceRoot: workspaceRootFor(req.workspaceId),
      /**
       * ★ 多轮的全部实现。缺省(空转录)意味着模型每轮都从零开始 ——
       * 界面上明明有三轮问答,它却只看得见最后一句。
       *
       * 存储是 `state/store` 里的一个 Map,步骤 6 换成 SQLite;
       * **接线不变**,换的只是 `getHistory`/`setHistory` 的实现。
       */
      history: store.getHistory(req.sessionId),
      approve: approveWith(req),
      /*
        ★ 这里给的是**目录**,不是正文。`context-assembler.ts` 只读
        name / description 两个字段拼成一行一条的清单,正文要模型自己调
        `Skill` 工具去取(渐进披露)。传的仍然是完整的 `Skill` 对象,
        是因为注册表本来就有它,而多一份裁剪过的类型只会多一处要同步的地方。
      */
      skills: activeSkills(req),
      /*
        ★ 角色提示词是**追加**的(见 `buildSystemPrompt` 里那段),
        工具清单是**收窄**的(`snapshot` 只过滤不新增)。两个方向都只能变严,
        所以一个 agent 定义文件永远不可能给子代理拿到父代理没有的东西。
      */
      ...(agent !== undefined ? { agentPrompt: agent.prompt } : {}),
      ...(agent?.tools !== undefined ? { allowedTools: agent.tools } : {}),
      spawnSubagent: spawnSubagentFor(handle, req)
    },
    handle,
    req
  )
  /**
   * `finally` 而不是 `then`:中断路径上 `finalizeAbort` 已经把半截回复和
   * 补上的 tool_result 都写进了 `history`。不在中断时落盘,下一轮就会带着
   * 一堆没有配对 tool_result 的 tool_call 上行 —— 那正是方案 §4.8
   * 花了整节篇幅避免的 400。
   */
  return session.run().finally(() => {
    store.setHistory(req.sessionId, session.history)
  })
}

/** 测试专用:把单例清干净,让每个用例从同一个起点开始。 */
export function resetRuntimeForTest(): void {
  host = null
  router = null
  tools = null
  // 不 await shutdown:这个函数是同步的(beforeEach 里调),而留着的
  // manager 会攥着上一个用例的 ToolRegistry —— 那正是要断开的引用
  mcp = null
  mcpOnChange = null
  childRunLauncher = null
  childSeq = 0
  seeded = false
  store.clearHistoriesForTest()
}
