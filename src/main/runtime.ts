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
import { DEFAULT_WORKSPACE_SETTINGS } from '../shared/domain/workspace'
import { AgentSession } from './kernel/agent-session'
import type { KernelHost } from './kernel/host'
import { nodeHost } from './kernel/host'
import type { RunHandle } from './kernel/run-registry'
import { builtinTools } from './kernel/tool/builtin'
import { ToolRegistry } from './kernel/tool/registry'
import { DEMO_ALIAS, DEMO_ALIASES, DEMO_PROVIDER, withDemo } from './kernel/upstream/demo'
import type { ProviderConfigSource } from './kernel/upstream/router'
import { UpstreamRouter } from './kernel/upstream/router'
import { store } from './state/store'

let host: KernelHost | null = null
let router: UpstreamRouter | null = null
let tools: ToolRegistry | null = null
let seeded = false

/**
 * 装宿主。**必须在第一个 run 之前**,由 `main/index.ts` 在 `app.whenReady()` 里调用 ——
 * `safeStorage` 与 `net.fetch` 都要求 app ready。
 */
export function installHost(h: KernelHost): void {
  host = h
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

/** app ready 时调一次。seed 提前跑,好让首屏的 bootstrap 已经带上默认模型。 */
export function initRuntime(h: KernelHost): void {
  installHost(h)
  seed()
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
 * 生产路径的 run 驱动 —— **`ipc/agent.ts` 的默认驱动**。
 * 假发射器从此只是 pump 测试的夹具。
 *
 * `AgentSession.run()` 承诺不抛异常(结局一律经 `handle.finish`),
 * 所以这里不需要 catch;真加一个 catch 反而会掩盖那个承诺哪天被破坏。
 */
export function runAgent(handle: RunHandle, req: RunRequest): Promise<void> {
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
      history: store.getHistory(req.sessionId)
      // skills / approve 分别是步骤 12 / 5。它们的缺省行为(无 Skill、一律放行)
      // 就是此刻的正确行为,所以这里不需要占位实现 ——
      // 占位实现只会让人以为那两步已经做了一半。
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
  seeded = false
  store.clearHistoriesForTest()
}
