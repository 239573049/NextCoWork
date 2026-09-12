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
import type { AgentEvent, RunStatus } from '../shared/agent/event'
import { agentError, type AgentError } from '../shared/agent/error'
import { userMessage, visibleText, type AgentMessage, type SubagentResult } from '../shared/agent/message'
import type { AgentDefinition } from '../shared/domain/agent-def'
import { minPermission } from '../shared/agent/permission'
import { DEFAULT_WORKSPACE_SETTINGS } from '../shared/domain/workspace'
import type { ApproveFn } from './kernel/agent-session'
import { AgentSession } from './kernel/agent-session'
import { abortable } from './kernel/abort'
import type { KernelHost } from './kernel/host'
import { nodeHost } from './kernel/host'
import { TOOLS_NEEDING_NETWORK, evaluate } from './kernel/permission-gate'
import { decideAfterHooks, decideBeforeHooks } from './kernel/permission-decision'
import { addLocalPermissionRule, readLocalSettings } from './kernel/local-settings'
import { matchPermissionRules, suggestPermissionRule } from '../shared/agent/permission-rule'
import { interactions } from './kernel/interaction-gate'
import type { RunHandle } from './kernel/run-registry'
import { runs } from './kernel/run-registry'
import { AGENTS_DIR, PROJECT_AGENTS_PREFIX, scanAgents } from './kernel/agent/load'
import type { GitContext } from './kernel/git-context'
import { readGitContext } from './kernel/git-context'
import { INSTRUCTIONS_MAX, sanitizeInstructions, scanInstructions } from './kernel/instructions'
import { clampWithEllipsis } from './kernel/text'
import { readTextBounded } from './imports/assets'
import { managedInstructionsPath } from './imports/service'
import { agentRegistry } from './kernel/agent/registry'
import type { Skill } from '../shared/domain/skill'
import { PROJECT_SKILLS_PREFIX, SKILLS_DIR, scanSkills } from './kernel/skill/load'
import { skillRegistry } from './kernel/skill/registry'
import { builtinTools } from './kernel/tool/builtin'
import { taskTool } from './kernel/tool/builtin/task'
import type { SpawnSubagentFn } from './kernel/tool/registry'
import { ToolRegistry } from './kernel/tool/registry'
import { McpManager } from './mcp/manager'
import { environmentTransport } from './mcp/environment-transport'
import type { McpServerConfig, McpServerStatus } from '../shared/domain/mcp'
import { installSearchConfig } from './search/service'
import { withDemo } from './kernel/upstream/demo'
import { opencodeGoProtocolFor } from './kernel/upstream/opencode-protocol'
import type { ProviderConfigSource } from './kernel/upstream/router'
import { UpstreamRouter } from './kernel/upstream/router'
import {
  BUILTIN_PLAN_PROVIDER_ID,
  BUILTIN_PROVIDER_ID,
  endpointFor,
  findPreset
} from '../shared/domain/presets'
import type { ModelAlias, UpstreamProtocol } from '../shared/domain/provider'
import { subagentModelSelection } from '../shared/domain/model-selection'
import { searchSecretRef } from '../shared/domain/search'
import { searchStatuses } from './search/status'
import { store } from './state/store'
import { listResolvedModels } from './state/model-bindings'
import { PRICING_SEED } from '../shared/domain/pricing-seed'
import { findPricing, priceOf } from '../shared/domain/pricing'
import type { ModelPricing } from '../shared/domain/pricing'
import { findBuiltinModel } from '../shared/domain/model-catalog-inventory'
import type { UnpricedUsageAttempt } from '../shared/domain/usage'
import { SessionTitleGenerator } from './session-title'
import type { SessionChange } from '../shared/domain/session'
import type { CanonicalRequest } from './kernel/upstream/canonical'
import { ulid } from '../shared/util/id'
import { runHookEvent } from './hooks'
import { getExecutionPlanV2, getPlanV2, transitionPlanV2 } from './db/repo'
import type { ConnectionStatus, SshConnectionProfile } from '../shared/domain/environment'
import { EnvironmentManager } from './environment/manager'
import { localEnvironment } from './environment/local'
import { connectSshEnvironment } from './environment/ssh/provider'
import { EnvironmentError } from './environment/errors'
import { normalizeEnvironmentRef } from '../shared/domain/environment'
import type { FileReferenceSource } from '../shared/domain/attachment'
import type { WorkspaceEnvironment } from './environment/contract'

let host: KernelHost | null = null
let router: UpstreamRouter | null = null
let tools: ToolRegistry | null = null
let mcp: McpManager | null = null
let seeded = false
let sessionTitles: SessionTitleGenerator | null = null
let environments: EnvironmentManager | null = null
let environmentStatusSink: ((status: ConnectionStatus) => void) | undefined
let environmentAuthentication: ((profile: SshConnectionProfile, senderId: number) => Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void>; resolve?(values: Map<string, string>): void }>) | undefined

export function installEnvironmentInteraction(authentication: NonNullable<typeof environmentAuthentication>, status: NonNullable<typeof environmentStatusSink>): void {
  environmentAuthentication = authentication
  environmentStatusSink = status
}

export function getEnvironments(): EnvironmentManager {
  environments ??= new EnvironmentManager({
    workspace: (id) => store.getWorkspace(id), profile: (id) => store.getConnectionProfile(id),
    local: (root) => localEnvironment(getHost(), root),
    connect: async (profile, context) => {
      if (!environmentAuthentication) throw new EnvironmentError('authentication')
      return connectSshEnvironment(profile, context, await environmentAuthentication(profile, context.senderId))
    },
    onStatus: (status) => environmentStatusSink?.(status)
  })
  return environments
}

export function getWorkspaceEnvironment(workspaceId: string): WorkspaceEnvironment { return getEnvironments().get(workspaceId) }
export async function shutdownEnvironments(): Promise<void> { await environments?.shutdown() }

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
 * 会话持久化发生在 runtime，但广播属于 Electron IPC 层。和 MCP 状态
 * 广播一样用一个零 Electron 的注入回调，避免 runtime 反向依赖窗口模块。
 */
let sessionOnChange: ((change: SessionChange) => void) | null = null

/**
 * 某条凭证被刷新、或者被标成需要重新登录了。
 *
 * ★ 和上面那个 sink 是同一个套路、同一个理由:内核里的 `CredentialResolver`
 * 拿不到窗口,而 runtime 又不能反向依赖窗口模块(**零 Electron import** 是
 * 无头测试能跑通的前提)。真正的广播器由 `ipc/index.ts` 在启动时装上。
 */
let credentialOnChange: ((credentialRef: string) => void) | null = null

/**
 * 装宿主。**必须在第一个 run 之前**,由 `main/index.ts` 在 `app.whenReady()` 里调用 ——
 * `safeStorage` 与 `net.fetch` 都要求 app ready。
 */
export function installHost(h: KernelHost): void {
  shutdownSessionTitles()
  void environments?.shutdown()
  environments = null
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
  aliases: () => listResolvedModels(),
  failoverEnabled: () => store.getSettings().gateway.failover
}

/**
 * 全新安装要种进去的东西。
 *
 * ★★ **演示上游(`demo.invalid`)不再进供应商表。**
 * 它以前是种的,理由写在这里:priority 100 全表最低、别名不会和真别名撞、
 * 「一直在」比「条件注册」少一个要回答的问题。**那些理由都还成立,推翻它的是别的:
 * 内置上游现在是一家真服务(RoutinAI),而设置页里并排列着一条地址写着
 * `https://demo.invalid` 的供应商,对用户就是一件需要解释的东西** ——
 * 它既不能用、又删不掉(seed 会把它种回来),而「点开就能用」这个它本来要买的好处,
 * 已经被那家真上游买走了。
 *
 * ★ **`demo.ts` 一行没动,那套机器整个还在**:`withDemo` 仍然包在生产宿主外面
 * (`host/index.ts`),发往 `demo.invalid` 的请求照旧被截下来喂罐头 SSE。
 * 也就是说手工建一个指向 `https://demo.invalid` 的供应商,今天照样能跑完整条链路 ——
 * 拿掉的只是「默认替用户建好它」。测试里要它的,自己 `store.putProvider(DEMO_PROVIDER)`
 * 一行就有(`agent-run.test.ts` / `subagent-wiring.test.ts` 就是这么做的)。
 */
function seed(): void {
  if (seeded) return
  seeded = true
  seedBuiltinUpstream()
  backfillOpencodeGoProtocol()

  /**
   * 没配过 = 全新安装,指向内置上游的别名。**两个设置项指两个不同的模型:**
   * 正文用 `deepseek-v4-pro`,子代理用 `deepseek-v4-flash` —— 子代理是被批量拉起的
   * (`subagent.perSessionLimit` 默认 4),拿主力模型跑它们既慢又贵。
   *
   * ★ 名字不在这里写死,从预设的 `suggestedModels` 里按位置取 ——
   * 那张表是这两个模型唯一的出处,写第二遍就会有一天它们对不上,
   * 而症状是 `defaultModel` 指着一条**不存在的别名**:不报错,下一次发送才在路由器里炸。
   *
   * ★ 这两条别名**都没有密钥**(见 `seedBuiltinUpstream`),所以第一次发送会得到一个
   * 鉴权错误而不是一段回答 —— 这是拿掉演示上游换来的代价,是清楚的:
   * 一个「填 key」的提示,比一条地址写着 `demo.invalid` 的假供应商更好解释。
   *
   * 常量留在 main 侧而不是写进 `DEFAULT_SETTINGS`:`src/shared/` 不能
   * 反向 import `src/main/`,而上游是 main 的东西。
   */
  const builtin = findPreset(BUILTIN_PROVIDER_ID)?.suggestedModels ?? []
  const settings = store.getSettings()
  const [defaultModel, subagentModel] = [builtin[0], builtin[1]]

  if (defaultModel !== undefined && settings.defaultModel === '') {
    // 种子时把供应商一并写死是对的:这一刻只有内置上游一家,不存在「按优先级择优」的余地。
    store.updateSettings({ defaultModel, defaultModelProviderId: BUILTIN_PROVIDER_ID })
  }
  if (subagentModel !== undefined && settings.subagent.model === '') {
    store.updateSettings({ subagent: { model: subagentModel, modelProviderId: BUILTIN_PROVIDER_ID } })
  }

  seedDefaultWorkspace()
}

/**
 * 内置上游 RoutinAI —— **全新安装被种进供应商表的那两条。**
 *
 * ★★ **它们和演示上游是两个东西。**
 * 演示上游(`demo.invalid`)是**假网络**:`withDemoUpstream` 按主机名把它的请求
 * 截下来喂罐头 SSE。那套机器整个还在(见上面 `seed` 的文件头),只是不再替用户
 * 建好那条配置。内置上游是**真网络**,要真 key。
 *
 * ★ 演示上游不种了,但下面这条禁令**一个字都没松**:绝不能把
 * `DEMO_PROVIDER.baseUrl` 改成 api.routin.ai ——
 * 那个常量正是 `withDemoUpstream` 用来算劫持主机名的东西
 * (`demo.ts` 的 `new URL(DEMO_PROVIDER.baseUrl).hostname`)。改了它,
 * **每一个发往 api.routin.ai 的真请求都会收到罐头假回复**,而且看起来完全正常 ——
 * 正是 demo.ts 文件头那句「dev 里一切正常,因为根本没有请求出去过」的最坏版本。
 *
 * ★★ **两条是两条,不是一条的两种协议。** 按量走 `api.routin.ai` + Anthropic,
 * 订阅(Plan)走 `api.routin.ai/plan/v1` + Responses。两边的 key 不通用 ——
 * 合成一条记录再让用户翻「API 格式」开关,填了哪种 key 另一半就全 401。
 *
 * 地址和模型都从预设表取,不在这里写第二遍:两处各写一份的话,改了预设而没改这里,
 * 内置上游会停在一个旧地址上,而界面显示的是预设那条。
 *
 * ★ 不种密钥。演示上游有一个常量假 key(走的是 safeStorage 同一条取值路径),
 * 这里**没有** —— 往一个真服务发 `sk-demo-not-a-real-key` 只会换回一个 401,
 * 而那句「未授权访问」会让用户以为是自己填错了。没有 key 就显示「未配置」。
 */
const BUILTIN_UPSTREAMS: readonly {
  presetId: string
  protocol: UpstreamProtocol
  priority: number
}[] = [
  // 50 / 51:都让位给用户自己配的(预设建出来是 `PRESET_PRIORITY` 60)。
  // 手工建的演示上游仍是 100 —— 全表最低,谁都排在它前面
  { presetId: BUILTIN_PROVIDER_ID, protocol: 'anthropic', priority: 50 },
  { presetId: BUILTIN_PLAN_PROVIDER_ID, protocol: 'openai-responses', priority: 51 }
]

/**
 * 预设里的 `suggestedModels` → 一条可用的别名(`alias === upstreamModel`)。
 *
 * ★ 元数据**从内置 catalog 取,不在这里手写**。以前这里写死
 * `200_000 / 64_000 + 四个 true`,而那串数字对 `claude-fable-5-1` 都不准,
 * 对 deepseek(1M 上下文)差了五倍 —— 表现是上下文条和「即将超长」的判断全是错的,
 * 且不报错。catalog 里查不到的(比如 `gpt-5.3-codex-spark`,订阅线独有)才退回保守值。
 */
function builtinAlias(providerId: string, model: string, index: number): ModelAlias {
  const known = findBuiltinModel(model)
  return {
    alias: model,
    providerId,
    upstreamModel: model,
    ...(known?.manufacturerId === 'anthropic' ? { protocolOverride: 'anthropic' as const } : {}),
    // 表内顺序即优先级 —— 预设里 deepseek 排在前面是因为设置项要指它们
    priority: index * 10,
    capabilities: known?.capabilities ?? {
      tools: true,
      vision: false,
      thinking: true,
      caching: true
    },
    contextWindow: known?.contextWindow ?? 200_000,
    maxOutputTokens: known?.maxOutputTokens ?? 64_000,
    ...(known === undefined
      ? {}
      : {
          displayName: known.displayName,
          modality: known.modality,
          thinkingConfig: known.thinkingConfig
        })
  }
}

function seedBuiltinUpstream(): void {
  for (const spec of BUILTIN_UPSTREAMS) {
    const preset = findPreset(spec.presetId)
    if (preset === null) continue
    const endpoint = endpointFor(preset, spec.protocol)
    if (endpoint === null) continue

    // Seeding runs once per process, including after a database restart. Never
    // overwrite an existing provider: doing so would erase protocolOptions
    // (including the user's Anthropic cache TTL), a protocol switch, or an
    // explicit disabled state. A deleted built-in provider is still recreated.
    const existing = store.listProviders().find((p) => p.id === preset.id)
    if (existing === undefined) {
      store.putProvider({
        id: preset.id,
        name: preset.name,
        protocol: endpoint.protocol,
        baseUrl: endpoint.baseUrl,
        credentialRef: `provider:${preset.id}`,
        priority: spec.priority,
        enabled: true
      })
    }

    /*
      ★ 别名也按「不存在才种」,和上面那条供应商同一个理由 ——
      每次启动无条件 `putAlias` 会把用户改过的上下文长度、显示名、思考档位
      全部顶回种子值,而且悄无声息。

      ★★ **判重必须带 providerId。** 别名的主键是 `(provider_id, alias)`
      (`repo.ts` 的 `ON CONFLICT`),同一个别名**可以**挂在多家上 ——
      那正是故障切换的轴(`router.ts` 的候选链、`enabled-models.ts` 的 `isDefault`
      都建立在「同一个别名、多个供应商」上)。
      只按名字判重的话:用户已经配了 DeepSeek 官方那家、上面有 `deepseek-v4-pro`,
      内置上游就**永远拿不到**这条别名 —— 而 `defaultModel` 指着的那个名字确实存在,
      于是不报错,只是默认走了另一家,且内置上游从此不参与这条别名的故障切换。
    */
    const seeded = new Set(store.listAliases().map((a) => `${a.providerId}\u0000${a.alias}`))
    preset.suggestedModels.forEach((model, i) => {
      if (seeded.has(`${preset.id}\u0000${model}`)) {
        // Migrate the built-in Claude seed introduced before per-model
        // protocols existed. Preserve any explicit user override.
        const existingAlias = store.listAliases().find((a) => a.providerId === preset.id && a.alias === model)
        if (existingAlias !== undefined && existingAlias.protocolOverride === undefined && findBuiltinModel(model)?.manufacturerId === 'anthropic') {
          store.putAlias({ ...existingAlias, protocolOverride: 'anthropic' })
        }
        return
      }
      store.putAlias(builtinAlias(preset.id, model, i))
    })
  }
}

/** 一次性标记,避免这段回填在每次进程启动时都把整张别名表扫一遍。 */
const OPENCODE_GO_PROTOCOL_MIGRATION_KEY = 'provider.opencode-go-model-protocol-v1'

/**
 * 老库里 OpenCode Go 的别名早于「协议按模型钉」这条规则存在,补种一次。
 *
 * ★★ **光改 `ipc/provider.ts` 的 `setAliases` 救不了已经配好的人。** 那条只在
 * 用户下次拉模型列表时才跑,而他此刻的症状是**发一句就 500**
 * (`muse-spark-1.3-contributor` 被发去 `/chat/completions`)——
 * 一句读不出「和协议有关」的报错。指望他自己想到去重拉一次列表是不现实的。
 *
 * ★ 只补 `protocolOverride` 为空的。用户在「协议」下拉里显式选过的一律不碰,
 * 且标记落库后永不重跑 —— 他之后把某个模型翻回别的协议,不会被下次启动悄悄改回去。
 * (同样的取舍见 `ipc/client-auth.ts` 的 `backfillAnthropicOverride`。)
 *
 * ★ 这里**不广播** `provider:changed`:本文件零 electron import(见文件头),
 * 而 `window/registry` 是 electron 的。不需要广播 —— `ipc/provider.ts` 的
 * `listProviders` / `listModels` 都以 `ensureSeeded()` 开头,渲染层读到的
 * 必然已经是补完之后的值。
 */
function backfillOpencodeGoProtocol(): void {
  if (store.getKv<boolean>(OPENCODE_GO_PROTOCOL_MIGRATION_KEY, false)) return
  store.setKv(OPENCODE_GO_PROTOCOL_MIGRATION_KEY, true)

  const providers = new Map(store.listProviders().map((p) => [p.id, p]))
  for (const alias of store.listAliases()) {
    if (alias.protocolOverride !== undefined) continue
    const provider = providers.get(alias.providerId)
    if (provider === undefined) continue
    const protocol = opencodeGoProtocolFor(provider, alias.upstreamModel)
    if (protocol === undefined) continue
    store.putAlias({ ...alias, protocolOverride: protocol })
  }
}

/**
 * 默认工作区 —— 和演示上游同一个理由:**全新安装点开就能用**。
 *
 * 没有它,首屏的外层 Tab 条是空的,侧边栏下半是空态,输入框没有 workspaceId
 * 可以发 —— 用户必须先经「打开文件夹」选一个目录才能看见这个应用长什么样。
 * 而参考实现里那个「默认工作区」正是这个位置(定时任务页的筛选器里
 * `全部工作区 / 默认工作区 / NextCoWork` 就是它和真实工作区并列)。
 *
 * 根目录落在统一的应用数据根 `.next-cowork/` 下,而不是 `process.cwd()`:
 * 打包后 cwd 在应用包内部,步骤 9 的 fs 工具就会以「围栏之内」的名义写进应用包里。
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
 * 那时下拉框会是空的,而设置里的 defaultModel 已经指着内置上游了。
 * 两处指向同一个 `seed()`,所以「什么时候 seed 过了」只有一个答案。
 */
export function ensureSeeded(): void {
  seed()
}

export function getRouter(): UpstreamRouter {
  seed()
  router ??= new UpstreamRouter(getHost(), providerConfig, {
    onUsageAttempt: persistUsageAttempt,
    onCredentialChanged: (ref) => credentialOnChange?.(ref)
  })
  return router
}

function getSessionTitles(): SessionTitleGenerator {
  if (sessionTitles !== null) return sessionTitles
  // Reuse protocol/configuration/usage handling with independent provider health:
  // a failed auxiliary request must not affect the Agent's provider selection.
  const generator = new SessionTitleGenerator({
    upstream: new UpstreamRouter(getHost(), providerConfig, {
      onUsageAttempt: (record) => {
        if (sessionTitles === generator) persistUsageAttempt(record)
      }
    }),
    getSession: store.getSession,
    putSession: store.putSession,
    onChange: (session) => sessionOnChange?.({ kind: 'metadata', sessionIds: [session.id], workspaceId: session.workspaceId, renamed: { sessionId: session.id, title: session.title } }),
    logger: getHost().logger
  })
  sessionTitles = generator
  return generator
}

export function shutdownSessionTitles(): void {
  sessionTitles?.clear()
  sessionTitles = null
}

/**
 * Freeze pricing at the attempt boundary. Later seed updates must never change
 * historical spend, and an unavailable rate remains NULL rather than silently
 * turning into a plausible-looking zero.
 */
export function resolveUsagePricingModelId(upstreamModel: string): string {
  const catalogModel = findBuiltinModel(upstreamModel)
  return catalogModel?.pricingModelId ?? catalogModel?.id ?? upstreamModel
}

/**
 * 这条用量该按哪张价目行计价 —— 查不到就是 null。
 *
 * ★ 返回 null 让调用方记 `costMicros: null`,而不是一个看着挺像样的 0 ——
 * `schema.ts` 要求 NULL 与 0 分得开。那张「用过但查不到定价」的待补表还没实现;
 * 将来实现它的时候,`usage_records` 有 `provider_id` 列,够用。
 *
 * ★ 和 `resolveUsagePricingModelId` 同一个理由抽成导出的纯函数:判断本身要可测,
 * 而 `persistUsageAttempt` 挂在内核回调上,测不到。
 */
export function resolveUsagePricing(
  providerId: string,
  pricingModelId: string,
  at: number
): ModelPricing | null {
  return findPricing(PRICING_SEED, providerId, pricingModelId, at)
}

function persistUsageAttempt(record: UnpricedUsageAttempt): void {
  const pricingModelId = resolveUsagePricingModelId(record.upstreamModel)
  const pricing = resolveUsagePricing(record.providerId, pricingModelId, record.at)
  const priced =
    pricing === null
      ? null
      : priceOf(
          pricing,
          {
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            cacheReadInputTokens: record.cacheReadTokens,
            cacheCreationInputTokens: record.cacheWriteTokens,
            cacheCreation1hInputTokens: record.cacheWrite1hTokens,
            ...(record.thinkingTokens !== null && !record.thinkingTokensEstimated
              ? { reasoningTokens: record.thinkingTokens }
              : {})
          },
          record.at
        )

  store.recordUsageAttempt({
    ...record,
    costMicros: priced?.micros ?? null,
    currency: priced?.currency ?? null,
    pricingTier: priced?.tier ?? null,
    pricingWindow: priced?.window ?? null
  })
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

const workspaceMcps = new Map<string, { key: string; manager: McpManager; tools: ToolRegistry; started: Set<string>; release(): void }>()

function workspaceMcp(workspaceId: string, environment = getWorkspaceEnvironment(workspaceId)) {
  environment.assertReady()
  const existing = workspaceMcps.get(workspaceId)
  if (existing?.key === environment.key) return existing
  if (existing) { void existing.manager.shutdown(); existing.release() }
  const lease = getEnvironments().acquire(workspaceId)
  const scopedTools = new ToolRegistry()
  const app = getHost()
  const manager = new McpManager({ tools: scopedTools, secrets: app.secrets, logger: app.logger,
    assertReady: environment.assertReady,
    transportFactory: (config, values) => environmentTransport(environment, config, values),
    onChange: (id) => mcpOnChange?.(id) })
  const scope = { key: environment.key, manager, tools: scopedTools, started: new Set<string>(), release: lease.release }
  workspaceMcps.set(workspaceId, scope)
  return scope
}

export function listMcpStatuses(): McpServerStatus[] {
  return store.listMcpServers().map((config) => {
    if (config.workspaceId === undefined) return getMcp().statusOf(config)
    const scope = workspaceMcps.get(config.workspaceId)
    try {
      if (scope?.key === getWorkspaceEnvironment(config.workspaceId).key) return scope.manager.statusOf(config)
    } catch { /* Disconnected workspaces have no usable MCP tools. */ }
    return { config, state: 'disconnected', tools: [], toolCount: 0 }
  })
}

export async function connectConfiguredMcp(config: McpServerConfig): Promise<McpServerStatus> {
  if (config.workspaceId === undefined) return getMcp().connect(config)
  try {
    const scope = workspaceMcp(config.workspaceId)
    scope.started.add(config.id)
    return await scope.manager.connect(config)
  } catch (error) {
    return { config, state: 'error', tools: [], toolCount: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function disconnectConfiguredMcp(id: string): Promise<void> {
  await Promise.all([getMcp().disconnect(id), ...[...workspaceMcps.values()].map((scope) => scope.manager.disconnect(id))])
}

async function prepareWorkspaceMcp(workspaceId: string, environment: WorkspaceEnvironment): Promise<ToolRegistry | undefined> {
  const configs = store.listMcpServers().filter((config) => config.workspaceId === workspaceId && config.enabled)
  if (configs.length === 0) return undefined
  const scope = workspaceMcp(workspaceId, environment)
  await Promise.all(configs.filter((config) => !scope.started.has(config.id)).map((config) => {
    scope.started.add(config.id)
    return scope.manager.connect(config)
  }))
  environment.assertReady()
  return scope.tools
}

/** 由 `ipc/mcp.ts` 在 `registerIpc()` 里装上 —— 理由见 `mcpOnChange` 的注释 */
export function setMcpChangeListener(fn: (id: string) => void): void {
  mcpOnChange = fn
}

/** 由 `ipc/index.ts` 在注册阶段安装；纯 Node 测试中保持 no-op。 */
export function setSessionChangeListener(fn: NonNullable<typeof sessionOnChange>): void {
  sessionOnChange = fn
}

/** 同上。刷新 token 改写凭证后，把新的登录态推给可能正开着设置页的窗口。 */
export function setCredentialChangeListener(fn: NonNullable<typeof credentialOnChange>): void {
  credentialOnChange = fn
}

/**
 * 退出时收摊。**只在真的建过 manager 时动手** —— 用 `getMcp()` 会在一个
 * 从没连过 MCP 的进程里凭空造一个出来,只为了立刻关掉它。
 */
export async function shutdownMcp(): Promise<void> {
  await mcp?.shutdown()
  await Promise.all([...workspaceMcps.values()].map(async (scope) => { await scope.manager.shutdown(); scope.release() }))
  workspaceMcps.clear()
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
 * ★ **每次发送前扫一遍**,不是启动时扫一次。用户在 `.next-cowork/skills/` 里
 * 放一条新的 Skill 之后,期待的是「下一次提问它就知道了」——「重启应用才生效」
 * 这件事没有任何地方会提示他。代价是两次 readDir,和一次上游往返比可以忽略。
 *
 * ★ 这个函数住在 runtime 而不是 `ipc/skills.ts`:它只需要 `getHost().paths`
 * 和 `store`,两样这里都有,而反过来会让内核的装配依赖 IPC 层。
 */
export async function refreshSkills(workspaceId: string, environment?: WorkspaceEnvironment): Promise<readonly Skill[]> {
  const h = getHost()
  const root = workspaceRootFor(workspaceId)
  environment ??= store.getWorkspace(workspaceId) ? getWorkspaceEnvironment(workspaceId) : undefined
  const remote = environment?.remote ? environment : undefined
  const result = await scanSkills({
    fs: h.fs,
    projectFs: remote?.fs, projectPath: remote?.path,
    globalRoot: join(h.paths.userData(), SKILLS_DIR),
    projectRoot: root === '' ? '' : remote ? await remote.path.resolveWithin(remote.rootPath, `${PROJECT_SKILLS_PREFIX}/${SKILLS_DIR}`) : join(root, PROJECT_SKILLS_PREFIX, SKILLS_DIR)
  })
  // 诊断只记日志,不阻断:一条坏掉的 SKILL.md 不该让别的都用不了
  for (const d of result.diagnostics) h.logger.warn(`[skill] ${d.path}: ${d.message}`)
  skillRegistry().replaceAll(result)
  return result.skills
}

/**
 * 读这个工作区的 `AGENTS.md`(全局一份 + 项目一份,拼接后消毒)。
 *
 * ★ 和 `refreshSkills` / `refreshAgents` 不同,这里**不建注册表单例**:
 * 没有任何工具会在运行期查它,它只在组装时用一次。一个返回字符串的函数就够,
 * 而且顺带躲掉了 `skillRegistry()` 那个没有 test reset 钩子的问题。
 */
export async function loadInstructions(workspaceId: string, environment?: WorkspaceEnvironment): Promise<string> {
  const h = getHost()
  const root = workspaceRootFor(workspaceId)
  environment ??= store.getWorkspace(workspaceId) ? getWorkspaceEnvironment(workspaceId) : undefined
  const result = await scanInstructions({
    fs: h.fs,
    ...(environment?.remote ? { projectFs: environment.fs, projectPath: environment.path } : {}),
    globalRoot: h.paths.userData(),
    projectRoot: root
  })
  // 诊断只记日志,不阻断 —— 一份读不了的 AGENTS.md 不该让这次提问跑不起来
  for (const d of result.diagnostics) h.logger.warn(`[instructions] ${d.path}: ${d.message}`)

  /*
    ★★ 导入来的说明拼在**最后**,而且读的是受管副本,不是任何原生文件。

    三条边界一条都不能少:
    - **不覆盖原生 `AGENTS.md`** —— 那是用户自己写的,导入不该动它;
    - **不修改源 `CLAUDE.md`** —— 只读承诺,受管副本是导入时另存的第三份;
    - **原生内容优先占用总长度预算** —— 拼在后面意味着超出 `INSTRUCTIONS_MAX`
      时先被 `clampWithEllipsis` 从尾部截掉的是导入的那部分。
  */
  const managed = await loadManagedInstructions(workspaceId)
  if (managed === '') return result.text
  return clampWithEllipsis(
    result.text === '' ? managed : `${result.text}${MANAGED_SEPARATOR}${managed}`,
    INSTRUCTIONS_MAX
  )
}

const MANAGED_SEPARATOR = '\n\n--- (imported instructions — the native rules above win) ---\n\n'

/**
 * 读全局与本工作区的受管说明副本。
 *
 * ★ 每一份都过 `sanitizeInstructions` —— 它来自另一个工具的目录,和 clone 来的
 * 仓库一样是**不可信输入**(见 `kernel/instructions.ts` 文件头)。「已经导入过
 * 一次」并不让它变可信:那份源文件在导入之后还会被改。
 */
async function loadManagedInstructions(workspaceId: string): Promise<string> {
  const chunks: string[] = []
  for (const source of store.listImportSources()) {
    for (const scopeKey of ['', workspaceId]) {
      if (scopeKey === '' && workspaceId === '') continue
      const mapping = store.getImportMapping(
        source.sourceId,
        scopeKey,
        'instructions',
        scopeKey === '' ? 'global' : scopeKey
      )
      // suppressed = 用户删过这一项,不要在下一轮把它拼回上下文里。
      if (mapping === undefined || mapping.syncState === 'suppressed') continue
      const text = await readTextBounded(managedInstructionsPath(source.sourceId, scopeKey), 64 * 1024)
      if (text === null) continue
      const clean = sanitizeInstructions(text)
      if (clean !== '') chunks.push(clean)
    }
  }
  return chunks.join('\n\n')
}

/**
 * 这一轮真正要下发目录的那几条。
 *
 * 两道筛子,分别是两个不同的问题:`resolve()` 回答「这个工作区装了哪些」
 * (空清单 = 全都要,理由在 `SkillRegistry.resolve` 上),
 * `globalEnabled` 回答「用户有没有在设置里把它整个关掉」。
 */
function activeSkills(req: RunRequest, snapshot?: readonly Skill[]): readonly Skill[] {
  const disabled = new Set(store.getDisabledSkillIds())
  const source = snapshot ?? skillRegistry().list()
  return (snapshot === undefined ? skillRegistry().resolve(req.skillIds, req.skillSelectionMode ?? 'all') : resolveSkillsSnapshot(source, req))
    .filter((s) => !disabled.has(s.id) && !s.unavailableReason)
}

function resolveSkillsSnapshot(skills: readonly Skill[], req: RunRequest): readonly Skill[] {
  if (req.skillIds.length === 0) return req.skillSelectionMode === 'explicit' ? [] : skills
  const ids = new Set(req.skillIds)
  return skills.filter((s) => ids.has(s.id))
}

/**
 * 重扫两层子代理目录,结果整体换进注册表,**并用新清单重新注册 `Task` 工具**。
 *
 * ★ 第二件事不能省。`Task` 的 description 里逐字带着可用子代理的清单
 * (照搬 CC),而 description 是在 `register()` 的那一刻定死的字符串 ——
 * 不重注册的话,用户刚放进 `.next-cowork/agents/` 的那个代理**存在、能派、
 * 但模型看不见它**,而这件事没有任何症状。
 *
 * `register()` 按 internalId 幂等替换且保住 externalName,所以重注册不会让
 * 历史转录里的 `Task` 引用失配(见 `ToolRegistry.register` 的注释)。
 */
export async function refreshAgents(workspaceId: string, environment?: WorkspaceEnvironment): Promise<readonly AgentDefinition[]> {
  const h = getHost()
  const root = workspaceRootFor(workspaceId)
  environment ??= store.getWorkspace(workspaceId) ? getWorkspaceEnvironment(workspaceId) : undefined
  const remote = environment?.remote ? environment : undefined
  const result = await scanAgents({
    fs: h.fs,
    projectFs: remote?.fs, projectPath: remote?.path,
    globalRoot: join(h.paths.userData(), AGENTS_DIR),
    projectRoot: root === '' ? '' : remote ? await remote.path.resolveWithin(remote.rootPath, `${PROJECT_AGENTS_PREFIX}/${AGENTS_DIR}`) : join(root, PROJECT_AGENTS_PREFIX, AGENTS_DIR)
  })
  for (const d of result.diagnostics) h.logger.warn(`[agent] ${d.path}: ${d.message}`)
  /*
    ★ 用户在扩展面板里关掉的那些，在这里滤掉 —— 不滤的话「禁用」只改了界面上
    一个开关的样子，模型照样能通过 `Task` 派遣它。

    过滤放在这一层而不是 `scanAgents` 里：内核不认识 kv，而「磁盘上有这个子代理吗」
    和「我想不想用它」是两个问题，扫描器只回答前一个（`ipc/agents.ts` 要列出被
    关掉的那些，靠的就是扫描器不过滤）。
  */
  const disabled = new Set(store.getDisabledAgentNames())
  const enabled = { ...result, agents: result.agents.filter((a) => !disabled.has(a.name)) }
  agentRegistry().replaceAll(enabled)
  getTools().register(taskTool())
  return enabled.agents
}

interface RunResources {
  fileReferenceSource: FileReferenceSource
  environment: WorkspaceEnvironment
  agents: readonly AgentDefinition[]
  tools: ToolRegistry
}

function snapshotRunTools(environment: WorkspaceEnvironment, agents: readonly AgentDefinition[], scoped?: ToolRegistry): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of getTools().snapshot()) {
    if (environment.remote && (tool.source.kind === 'mcp' || tool.internalId.startsWith('browser_'))) continue
    registry.register(tool.internalId === 'Bash' && environment.remote ? {
      ...tool,
      description: `Runs a non-interactive command on the SSH server in the workspace directory using ${environment.platform.shell}. `
        + 'Each call starts a fresh shell, stdin is closed, and output and execution time are bounded. '
        + (environment.platform.os === 'win32' ? 'Use PowerShell syntax and Windows paths, not Bash or cmd.exe syntax. ' : 'Use the remote shell syntax and paths. ')
        + 'Commands do not run on the client. A lost connection may leave the outcome unknown; do not automatically repeat a mutation.'
    } : tool)
  }
  registry.register(taskTool(agents))
  for (const tool of scoped?.snapshot() ?? []) registry.register(tool)
  return registry
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

/** 配置损坏时的安全回退值。正常值来自 settings.subagent。 */
const DEFAULT_CONCURRENT_SUBAGENTS = 4

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
function waitForEnd(handle: RunHandle): Promise<Extract<AgentEvent, { type: 'run_end' }>> {
  return new Promise((resolve) => {
    if (handle.status !== 'running') {
      const end = handle.since(handle.seq - 1)[0]
      resolve(end?.type === 'run_end' ? end : { type: 'run_end', status: handle.status })
      return
    }
    const off = handle.on((ev) => {
      if (ev.type !== 'run_end') return
      off()
      resolve(ev)
    })
  })
}

interface ChildRunResult {
  status: RunStatus
  text: string
  error?: AgentError
  endedAt?: number
}

/**
 * 监听子 run 的低频状态，并把汇总写回父 run。原始子 run 事件仍会通过
 * inherited topic 推给渲染层，后台子任务在父 run 结束后也能继续被观察。
 */
function monitorChildRun(
  parent: RunHandle,
  child: RunHandle,
  childReq: RunRequest,
  callId: string,
  background: boolean,
  finished?: Promise<void>
): Promise<ChildRunResult> {
  let toolCalls = 0
  let toolErrors = 0
  const off = child.on((event, childSeq) => {
    if (event.type === 'tool_start') {
      toolCalls++
      if (parent.status === 'running') parent.emit({
        type: 'subagent_update', callId, childRunId: child.runId,
        phase: 'tool', currentTool: event.toolName, currentTarget: toolTarget(event.input), toolCalls, toolErrors, childSeq, at: event.at
      })
    } else if (event.type === 'tool_end') {
      if (event.isError) toolErrors++
      if (parent.status === 'running') parent.emit({
        type: 'subagent_update', callId, childRunId: child.runId,
        phase: 'thinking', currentTool: undefined, currentTarget: undefined, toolCalls, toolErrors, childSeq, at: event.at
      })
    } else if (event.type === 'context_usage' && parent.status === 'running') {
      parent.emit({
        type: 'subagent_update', callId, childRunId: child.runId,
        contextUsage: { used: event.used, window: event.window, shouldCompact: event.shouldCompact },
        toolCalls, toolErrors, childSeq
      })
    } else if (event.type === 'stream' && event.delta.type === 'message_end' && parent.status === 'running') {
      parent.emit({
        // ★ 一轮回复完整结束 = 之前那句「正在退避重试」必然已经过期。清除走的是
        //   和 `currentTool` 同一个约定(键在即清),所以哪怕这条遥测抢在继承事件
        //   前头到达,卡片上也不会挂着一句过期的重试提示。
        type: 'subagent_update', callId, childRunId: child.runId,
        phase: 'finishing', notice: undefined, usage: event.delta.usage, toolCalls, toolErrors, childSeq
      })
    }
  })

  return (async () => {
    const { status, error } = await waitForEnd(child)
    if (finished !== undefined) await finished.catch(() => {})
    off()
    const history = store.getHistory(childReq.sessionId)
    const last = [...history].reverse().find((m) => m.role === 'assistant')
    const text = last === undefined ? '' : visibleText(last)
    const endedAt = child.endedAt
    persistSubagentCompletion(parent.sessionId, callId, child.runId, status, text, error, background)
    /*
      SubagentStop 钩子。★ fire-and-forget，理由同 Stop。
      环境从 `childReq.workspaceId` 现取而不是闭包捕获：子 run 可能跑在
      和父不同的租约上，拿错的话钩子会在另一个工作区的根目录下执行。
    */
    try {
      void runHookEvent({
        event: 'SubagentStop',
        environment: getWorkspaceEnvironment(childReq.workspaceId),
        sessionId: childReq.sessionId,
        runId: child.runId,
        extra: { status }
      }).catch(() => undefined)
    } catch {
      // 环境已经释放（父 run 早就结束了）—— 子代理收尾的钩子不值得为此报错。
    }
    if (parent.status === 'running') {
      parent.emit({
        type: 'subagent_end', callId, childRunId: child.runId, status,
        childSeq: child.seq,
        ...(text.trim() === '' ? {} : { summary: text.slice(0, 240) }),
        ...(error === undefined ? {} : { error }),
        ...(endedAt === undefined ? {} : { at: endedAt })
      })
    } else if (background) {
      // The parent may have finished before this detached child. Its own run_end
      // is still delivered through the inherited child topic for the renderer.
      getHost().logger.info(`[subagent] background child finished after parent: ${child.runId}`)
    }
    return { status, text, ...(error === undefined ? {} : { error }), ...(endedAt === undefined ? {} : { endedAt }) }
  })()
}

function toolTarget(input: unknown): string | undefined {
  if (typeof input === 'string') return input.slice(0, 160)
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['path', 'filePath', 'query', 'pattern', 'command', 'url']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 160)
  }
  return undefined
}

/** Update the durable Task receipt when a detached/background child finishes. */
function persistSubagentCompletion(
  sessionId: string,
  callId: string,
  childRunId: string,
  status: RunStatus,
  text: string,
  error?: AgentError,
  background = false
): void {
  const history = store.getHistory(sessionId)
  let changed = false
  const summary = text.trim() === '' ? undefined : text.trim().slice(0, 240)
  const messages = history.map((message) => {
    let messageChanged = false
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_result' || part.callId !== callId || part.subagent?.childRunId !== childRunId) return part
      messageChanged = true
      changed = true
      return {
        ...part,
        subagent: {
          ...part.subagent,
          status,
          ...(background ? { reportStatus: 'pending' as const } : {}),
          ...(summary === undefined ? {} : { summary }),
          ...(error === undefined ? {} : { error })
        }
      }
    })
    return messageChanged ? { ...message, parts } : message
  })
  if (changed) store.setHistory(sessionId, messages)
}

/**
 * A parent run writes its complete in-memory history in `finally`, while a
 * detached child can update the durable Task receipt at the same time. Merge
 * the latest receipt into that final write so the older parent snapshot cannot
 * downgrade a completed child back to `running`.
 */
function mergeLatestSubagentReceipts(
  messages: readonly AgentMessage[],
  latest: readonly AgentMessage[]
): AgentMessage[] {
  const receipts = new Map<string, SubagentResult>()
  for (const message of latest) {
    for (const part of message.parts) {
      if (part.type !== 'tool_result' || part.subagent === undefined) continue
      receipts.set(part.callId, part.subagent)
    }
  }
  if (receipts.size === 0) return [...messages]

  const rank = (status: SubagentResult['status']): number => {
    if (status === undefined) return 0
    return status === 'running' ? 1 : 2
  }
  return messages.map((message) => {
    let messageChanged = false
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_result' || part.subagent === undefined) return part
      const current = receipts.get(part.callId)
      if (current === undefined) return part
      const status = rank(current.status) >= rank(part.subagent.status)
        ? current.status
        : part.subagent.status
      const merged: SubagentResult = {
        ...part.subagent,
        ...(current.background === undefined
          ? {}
          : { background: current.background }),
        ...(current.summary === undefined
          ? {}
          : { summary: current.summary }),
        ...(current.error === undefined
          ? {}
          : { error: current.error }),
        ...(current.reportStatus === undefined
          ? {}
          : { reportStatus: current.reportStatus }),
        ...(status === undefined ? {} : { status })
      }
      messageChanged = true
      return { ...part, subagent: merged }
    })
    return messageChanged ? { ...message, parts } : message
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
  prompt: string,
  configuredModel: { model: string; modelProviderId?: string }
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
    /*
      ★ 上面那个派生 id 只是**惯例**,这一项才是**事实**。

      「这条转录不进侧边栏/搜索/导出」和「删父会话时跟着回收」全都读
      `sessions.parent_session_id`,没有任何一处再去 parse 那个 `:sub:` ——
      它是递归拼出来的(子 runId 自己也含 `:sub:`),想从里面反推父亲,
      第一个切出的是**爷爷**、最后一个切出的是一个**不存在的 id**。
      理由完整写在 `db/schema.ts` 第 10 条迁移上。
    */
    parentSessionId: parentReq.sessionId,
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
    // ★ 别名和供应商必须成对决定 —— 三档来源的优先级连同理由都在
    //   `subagentModelSelection` 里。`configuredModel` 已经过可用性校验(见调用点)。
    ...subagentModelSelection(def.model, configuredModel, parentReq),
    skillIds: parentReq.skillIds,
    skillSelectionMode: parentReq.skillSelectionMode,
    agentType: def.name
  }
}

/**
 * 设置页那个「默认子代理」当前**还指得到一条绑定吗**。
 *
 * ★ 这道校验不能省,也不能挪进 `subagentModelSelection`(那是个纯函数,够不着
 * 路由器)。`settings.subagent.model` 是一个别名字符串,而供应商随时会被删、
 * 别名随时会被改名 —— `ipc/provider.ts` 的 `repairModelSelection` 会在那些写入
 * 之后修好它,但**中间存在窗口期**,而且用户手动改设置文件也绕得过去。
 * 悬空时的表现不是报错,是子代理在路由器里拿到空候选集然后整条失败 ——
 * 而父代理只会转述一句「子代理失败了」,用户无从知道是这一栏的锅。
 *
 * 查不到就退回 `{ model: '' }`,让 `subagentModelSelection` 落到下一档(父 run)。
 * 静默降级是对的:这一栏是**偏好**,不是硬约束;硬约束是药丸上那个显式选择。
 */
function availableSubagentModel(configured: { model: string; modelProviderId?: string }):
  { model: string; modelProviderId?: string } {
  const model = configured.model.trim()
  if (model === '') return { model: '' }
  if (getRouter().resolveModel(model, configured.modelProviderId) === undefined) {
    getHost().logger.warn(`[subagent] configured default model is unavailable: ${model}`)
    return { model: '' }
  }
  const providerId = configured.modelProviderId
  return { model, ...(providerId === undefined ? {} : { modelProviderId: providerId }) }
}

/**
 * `ToolContext.spawnSubagent` 的生产实现 —— 三道闸门 + 建 run + 等结果。
 *
 * ★ 它住在 runtime 而不是 `task.ts`,因为只有这里同时握着**父 handle**
 * (要在它身上发 `subagent_start/end`)和 store(要取子代理的产出)。
 * `ctx.emit` 只会发 `tool_progress`,发不了子代理事件。
 */
function spawnSubagentFor(parent: RunHandle, parentReq: RunRequest, parentSkills: readonly Skill[] | undefined, resources: RunResources): SpawnSubagentFn {
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

    resources.environment.assertReady()
    const def = resources.agents.find((definition) => definition.name === sub.subagentType)
    if (def === undefined) {
      /*
        ★ **绝不静默回落到 general-purpose。**名字敲错的用户会拿到一份
        「看起来对」的、由错误代理产出的结果,而且永远不会发现。
        把可用清单列全,模型下一次就能选对,或者判断出没有合适的。
      */
      return {
        kind: 'refused',
        reason:
          `There is no subagent named "${sub.subagentType}". Available: ${resources.agents.map((definition) => definition.name).join(', ')}. ` +
          `Pick one from that list, or skip the subagent and do this step yourself.`
      }
    }

    // 读取最新设置,让用户在运行期间调整并发上限也能影响下一次派发。
    // 设置文件是用户可编辑输入,因此对异常值做一次防御性归一化。
    const configured = store.getSettings().subagent
    const perSessionLimit = Number.isInteger(configured.perSessionLimit) && configured.perSessionLimit >= 1
      ? configured.perSessionLimit
      : DEFAULT_CONCURRENT_SUBAGENTS
    const globalLimit = Number.isInteger(configured.globalLimit) && configured.globalLimit >= 0
      ? configured.globalLimit
      : DEFAULT_CONCURRENT_SUBAGENTS

    if (runs.activeChildCount(parent.runId) >= perSessionLimit) {
      return {
        kind: 'refused',
        reason:
          `The per-conversation concurrent subagent limit of ${String(perSessionLimit)} has been reached. ` +
          `Wait for the running ones to finish before launching another, or carry on yourself.`
      }
    }

    if (runs.activeSubagentCount() >= globalLimit) {
      return {
        kind: 'refused',
        reason:
          `The global concurrent subagent limit of ${String(globalLimit)} has been reached. ` +
          `Wait for the running ones to finish before launching another, or carry on yourself.`
      }
    }

    const childRunId = `${parent.runId}:sub:${String(++childSeq)}`
    const childReq = childRequestFor(
      parentReq, parent, def, childRunId, sub.prompt, availableSubagentModel(configured)
    )

    const startedAt = getHost().clock.now()
    parent.emit({
      type: 'subagent_start', callId: sub.callId, childRunId,
      description: sub.description,
      subagentType: def.name,
      model: childReq.model,
      background: sub.background === true,
      at: startedAt
    })

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
      finished = runAgent(h, r, def, parentSkills, resources)
      return finished
    })
    const result = monitorChildRun(parent, child, childReq, sub.callId, sub.background === true, finished)
    if (sub.background === true) {
      void result.catch((error: unknown) => {
        getHost().logger.warn(`[subagent] background child failed: ${childRunId}`, error)
      })
      return { kind: 'background', childRunId }
    }

    const completed = await result
    return {
      kind: 'finished', childRunId, status: completed.status, text: completed.text,
      ...(completed.error === undefined ? {} : { error: completed.error })
    }
  }
}

/**
 * 权限闸门的**接线**处 —— 策略在 `kernel/permission-gate.ts`,这里只负责把
 * 一次 run 的档位、联网开关和被调工具的标记喂进去,再把结果翻译成 `PermissionDecision`。
 *
 * `evaluate()` 是纯策略判断;`ask` 的异步审批由 InteractionGate 持有,
 * 所以窗口重载不会丢掉待决项,中断也能结束等待。
 *
 * ★ `needsNetwork` 是**取或**,不是二选一:工具自己声明的那个字段,
 * 加上 `TOOLS_NEEDING_NETWORK` 这张下限表。表里的名字无论字段怎么填都算联网,
 * 所以一个字段被写错(或将来某个注册路径忘了填)也放不宽这道闸。
 * 为什么不只留表、也不只留字段,`TOOLS_NEEDING_NETWORK` 的注释写全了。
 *
 * ★ 判定顺序在 `approveWith` 里,**顺序即语义**:
 * 联网开关 → 本地 `deny` → 本地 `ask`(压过下面两步)→ 档位 → 本地 `allow` → AI 审核 → 问人。
 * 联网必须排第一 —— 一条写进 `.next-cowork/settings.local.json` 的 allow 规则,
 * 不该能把用户亲手关掉的开关重新打开。
 */
type ReviewResult = 'allow' | 'deny' | 'unknown'

/**
 * “为我批准”的 AI 审核器。它是一个无工具、短输出的独立请求，不能继承
 * 当前 agent 的权限，也不能通过审核器再次调用工具。任何网络/解析/模型错误
 * 都返回 unknown，由调用方回退到人工审批，避免“审核器挂了却放行”。
 */
async function reviewSensitiveOperation(
  req: RunRequest,
  reviewerModel: string,
  reviewerModelProviderId: string | undefined,
  toolName: string,
  input: unknown,
  signal: AbortSignal
): Promise<ReviewResult> {
  reviewerModel = reviewerModel.trim()
  if (reviewerModel === '') return 'unknown'
  if (getRouter().resolveModel(reviewerModel, reviewerModelProviderId) === undefined) {
    getHost().logger.warn(`[permission-review] configured model is unavailable: ${reviewerModel}`)
    return 'unknown'
  }
  let payload: string
  try {
    payload = JSON.stringify(input) ?? '{}'
  } catch {
    return 'unknown'
  }
  const prompt = [
    'You are a safety reviewer for an AI computer-use agent.',
    'Decide whether the proposed tool call is safe and consistent with the user task.',
    'Reply with exactly one JSON object and no markdown: {"decision":"allow"} or {"decision":"deny"}.',
    `User task: ${req.input.filter((part) => part.type === 'text').map((part) => part.text).join('\n').slice(0, 8000)}`,
    `Tool: ${toolName}`,
    `Input: ${payload.slice(0, 12000)}`
  ].join('\n')
  const reviewRequest: CanonicalRequest = {
    model: reviewerModel,
    ...(reviewerModelProviderId === undefined ? {} : { modelProviderId: reviewerModelProviderId }),
    system: 'Be conservative. Deny destructive, irreversible, credential-related, or ambiguous actions.',
    messages: [userMessage(ulid(getHost().clock.now()), [{ type: 'text', text: prompt }], getHost().clock.now())],
    tools: [],
    maxOutputTokens: 128,
    thinkingLevel: 'off'
  }
  let text = ''
  try {
    for await (const event of getRouter().stream(reviewRequest, signal, {
      workspaceId: req.workspaceId,
      runId: `${req.runId}:permission-review`,
      sessionId: req.sessionId
    })) {
      if (event.type === 'text_delta') text += event.text
      if (event.type === 'error') return 'unknown'
    }
  } catch {
    getHost().logger.warn(`[permission-review] model request failed for ${reviewerModel}`)
    return 'unknown'
  }
  const normalized = text.trim()
  // 兼容模型常见的 ```json 包裹、前后解释文字，以及中文“允许/拒绝”。
  // 只接受明确的 decision 字段或整句明确答案；含糊内容仍然回退人工审批。
  const candidates = [normalized]
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const embedded = normalized.match(/\{\s*["']decision["']\s*:\s*["'](?:allow|deny)["']\s*\}/iu)?.[0]
  if (embedded !== undefined) candidates.push(embedded)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { decision?: unknown }
      if (parsed.decision === 'allow') return 'allow'
      if (parsed.decision === 'deny') return 'deny'
    } catch {
      // Try the next representation.
    }
  }
  if (/\bdecision\s*[:=]\s*["']?allow\b|(?:^|\s)(?:allow|allowed|approve|approved|允许|同意)(?:[.!。]|$)/iu.test(normalized)) return 'allow'
  if (/\bdecision\s*[:=]\s*["']?deny\b|(?:^|\s)(?:deny|denied|拒绝|禁止)(?:[.!。]|$)/iu.test(normalized)) return 'deny'
  getHost().logger.warn(`[permission-review] model returned an unrecognized decision for ${reviewerModel}`)
  return 'unknown'
}

function approveWith(req: RunRequest, handle: RunHandle, environment: WorkspaceEnvironment): ApproveFn {
  // 与 permissionMode 一样按 run 冻结，避免用户改设置后同一轮请求前后使用不同审核器。
  // ★ 别名和供应商必须在**同一刻**冻结:一个冻结一个现取的话,用户中途换了供应商
  //   就会拼出「旧别名 + 新供应商」,而这一轮的审核器是谁将无从解释。
  const { permissionReviewerModel: reviewerModel,
    permissionReviewerModelProviderId: reviewerModelProviderId } = store.getSettings()
  // 契约要求返回 Promise;策略本身是同步的纯函数
  return async ({ tool, callId, input }) => {
    const outcome = evaluate({
      mode: req.permissionMode,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      needsNetwork: tool.needsNetwork || TOOLS_NEEDING_NETWORK.has(tool.internalId),
      webSearch: req.webSearch
    })
    const host = getHost()
    environment.assertReady()
    const root = environment.rootPath
    const filesystem = environment.remote ? environment.fs : host.fs
    const scope = environment.remote ? { path: environment.path, namespace: environment.key } : undefined
    // 规则用 internalId 匹配 —— externalName 会被注册表截断去重,跨会话不稳定。
    const local = await readLocalSettings(filesystem, root, host.logger, scope)

    /*
      ★ 判定顺序在 `kernel/permission-decision.ts`，那里一条一条写明了为什么是这个次序。
      拆成「钩子之前 / 钩子之后」两段，是因为跑钩子会 fork 进程：拿到 early deny 就
      直接 return，物理上到不了跑钩子那一步。
    */
    const early = decideBeforeHooks(outcome, matchPermissionRules(local.permissions.deny, tool.internalId, input))
    if (early.kind === 'deny') return { kind: 'deny', reason: early.reason }
    /*
      PreToolUse 钩子。★ **顺序即语义**，这个位置是设计的一部分：

      - 排在 `deny` 桶**之后** —— `deny` 是「连档位都放宽不了」的那一层
        （见 `shared/domain/local-settings.ts` 文件头），一条钩子不该能把它打开。
      - 排在 `ask` / `allow` 桶**之前** —— 钩子的 deny 必须压得过一条 allow 规则，
        否则用户点过一次「以后都允许」，就等于永久绕开了所有安全钩子。

      钩子失败（超时 / 起不来 / 非 0 非 2 退出）**不阻断**，理由见 `hook/run.ts`
      文件头那段 fail-open。
    */
    const hookReports = await runHookEvent({
      event: 'PreToolUse',
      environment,
      sessionId: req.sessionId,
      runId: req.runId,
      tool: { internalId: tool.internalId, externalName: tool.externalName, input },
      signal: handle.signal
    })
    const blockedBy = hookReports.find((r) => r.outcome === 'blocked' || r.decision === 'deny')
    const verdict = decideAfterHooks({
      gate: outcome,
      hook: {
        ...(blockedBy === undefined
          ? {}
          : { deny: blockedBy.reason ?? 'A PreToolUse hook blocked this call.' }),
        allow: hookReports.some((r) => r.decision === 'allow'),
        ask: hookReports.some((r) => r.decision === 'ask')
      },
      askRule: matchPermissionRules(local.permissions.ask, tool.internalId, input),
      allowRule: matchPermissionRules(local.permissions.allow, tool.internalId, input),
      autoReview: req.permissionMode === 'auto' && tool.destructive
    })
    if (verdict.kind === 'deny') return { kind: 'deny', reason: verdict.reason }
    if (verdict.kind === 'allow') return { kind: 'allow_once' }
    if (verdict.kind === 'review') {
      const review = await reviewSensitiveOperation(req, reviewerModel, reviewerModelProviderId, tool.externalName, input, handle.signal)
      if (review === 'allow') return { kind: 'allow_once' }
      if (review === 'deny') return { kind: 'deny', reason: 'The configured AI reviewer denied this potentially unsafe operation.' }
    }

    const suggestedRule = suggestPermissionRule(tool.internalId, input)
    /*
      Notification 钩子 —— 「有个弹窗在等你」的那一刻。典型用法是
      `osascript -e 'display notification …'`。
      ★ fire-and-forget：不 await、不看结果。审批弹窗已经在等人了，
      再为一条通知脚本多等几秒只会让用户更晚看到它。
    */
    void runHookEvent({
      event: 'Notification',
      environment,
      sessionId: req.sessionId,
      runId: req.runId,
      tool: { internalId: tool.internalId, externalName: tool.externalName, input },
      extra: { notification: { kind: 'tool_permission', toolName: tool.externalName } },
      signal: handle.signal
    }).catch(() => undefined)

    const response = await interactions.request(handle, {
      kind: 'tool_permission', callId, toolName: tool.externalName,
      input, readOnly: tool.readOnly, destructive: tool.destructive,
      ...(root === '' ? {} : { suggestedRule })
    }, getHost().clock.now())
    if (response.kind !== 'tool_permission') return { kind: 'deny' }
    const decision = response.decision
    if (decision.kind !== 'allow_always') return decision
    // 落盘失败不该把用户刚点下的「允许」变成「拒绝」—— 这一次照常放行,只是没记住。
    const saved = await addLocalPermissionRule(filesystem, root, 'allow', suggestedRule, host.logger, scope)
    if (!saved.ok) host.logger.warn(`[permission] 未能记住规则 ${suggestedRule}: ${saved.reason}`)
    return { kind: 'allow_once' }
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
  agent?: AgentDefinition,
  inheritedSkills?: readonly Skill[],
  inheritedResources?: RunResources
): Promise<void> {
  let approvedPlanContext: import('../shared/domain/plan').PlanDocumentV2 | undefined
  handle.beforeFinish((status) => {
    try {
      const current = getExecutionPlanV2(req.runId)
      if (current !== undefined && current.lifecycle === 'executing') {
        const lifecycle = status === 'done' ? 'completed' : 'failed'
        const next = transitionPlanV2(current.id, current.version, lifecycle)
        if (lifecycle === 'completed') handle.emit({ type: 'plan_execution_completed', planId: next.id, sessionId: next.sessionId, runId: req.runId, version: next.version, lifecycle: 'completed' })
        else handle.emit({ type: 'plan_execution_failed', planId: next.id, sessionId: next.sessionId, runId: req.runId, version: next.version, lifecycle: 'failed' })
      }
    } catch (error) {
      getHost().logger.warn(`[plan] failed to finalize execution: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (req.approvedPlan !== undefined) {
    const plan = getPlanV2(req.approvedPlan.planId)
    if (plan === undefined || plan.version !== req.approvedPlan.version || (plan.lifecycle !== 'approved' && plan.lifecycle !== 'failed')) {
      throw new Error('Approved plan is missing, stale, or no longer approved.')
    }
    transitionPlanV2(plan.id, plan.version, 'executing', req.runId)
    approvedPlanContext = { ...plan, lifecycle: 'executing', executionRunId: req.runId }
    handle.emit({ type: 'plan_execution_started', planId: plan.id, sessionId: plan.sessionId, runId: req.runId, version: plan.version, lifecycle: 'executing' })
  }
  const existing = store.getSession(req.sessionId)
  const workspace = store.getWorkspace(req.workspaceId)
  if (!workspace || (existing && existing.workspaceId !== req.workspaceId)) throw new EnvironmentError('unbound')
  const session = store.ensureSession({
    id: req.sessionId,
    workspaceId: req.workspaceId,
    // 非空 = 这是子代理的转录:落盘照旧,但它从此不出现在任何面向用户的枚举里。
    ...(req.parentSessionId === undefined ? {} : { parentSessionId: req.parentSessionId }),
    model: req.model,
    ...(req.modelProviderId === undefined ? {} : { modelProviderId: req.modelProviderId }),
    mode: req.mode,
    thinking: req.thinking,
    rootPathAtCreation: workspaceRootFor(req.workspaceId)
  })
  // 新会话第一次发送时把模型/模式冻结到元数据；后续 run 不覆盖用户改过的标题。
  // ★ 比较里必须带上 modelProviderId:同一个会话里从 RoutinAI 切到 Codex 时别名没变,
  //   漏了这一项的话会话元数据会一直停在旧供应商上。
  if (existing !== undefined && (existing.model !== req.model
    || existing.modelProviderId !== req.modelProviderId
    || existing.mode !== req.mode || existing.thinking !== req.thinking)) {
    store.putSession({ ...session, model: req.model,
      // ★ 无条件写,不能用条件展开:req 这次没锁供应商而会话上还留着上次那个的话,
      //   条件展开清不掉它,于是会话永远停在旧供应商上 —— 又是「只改一半」。
      modelProviderId: req.modelProviderId,
      mode: req.mode, thinking: req.thinking, updatedAt: Date.now() })
  }
  /*
    ★ 这一行是**这条会话在侧边栏里出生的那一刻**。

    渲染层不再抢先建会话(白纸不落库,见 `renderer/stores/tabs.ts` 的 `makeTab`),
    所以「最近对话」里这一条只能等这里广播。不广播的话,它要拖到标题生成器
    跑完第一次 `putSession` 才冒出来 —— 中间那几秒用户看着自己的消息在流式,
    左边却什么都没有,像是发进了黑洞。

    子代理的转录不算:`parentSessionId` 非空的那些从来不进面向用户的枚举。
  */
  if (existing === undefined && req.parentSessionId === undefined) sessionOnChange?.({ kind: 'metadata', sessionIds: [req.sessionId], workspaceId: req.workspaceId })
  const startedAt = getHost().clock.now()
  store.setRunRecord(req.runId, req.sessionId, 'running', startedAt)
  /*
    ★ 扫描在**建 session 之前**。系统提示词是在第一轮组装时定下来的,
    晚一步扫的话这一轮的目录还是上一轮那份 —— 用户刚装的那条 Skill
    要到下一次提问才出现,而他会以为是没装上。

    ★ 子 run **不重扫**:它的定义在派出去那一刻就定死了(见上面的 `agent` 参数),
    而重扫会在父代理正跑着的时候把 `Task` 的 description 换掉。
  */
  let runSkills: readonly Skill[] | undefined = inheritedSkills
  let environment: WorkspaceEnvironment
  let scopedMcpTools: ToolRegistry | undefined
  let runAgents = inheritedResources?.agents ?? agentRegistry().list()
  let release = (): void => {}
  let projectInstructions: string
  let git: GitContext | undefined
  try {
    if (inheritedResources) {
      const lease = getEnvironments().retain(inheritedResources.environment)
      environment = lease.environment
      release = lease.release
    }
    else {
      const lease = getEnvironments().acquire(req.workspaceId)
      environment = lease.environment
      release = lease.release
    }
    environment.assertReady()
    if (agent === undefined) {
      runSkills = await abortable(() => refreshSkills(req.workspaceId, environment), handle.signal)
      runAgents = await abortable(() => refreshAgents(req.workspaceId, environment), handle.signal)
      scopedMcpTools = await abortable(() => prepareWorkspaceMcp(req.workspaceId, environment), handle.signal)
    }

    /*
      ★ 这两件事在那个 `if` **外面** —— 先弄清那个 `if` 到底在防什么:
      它防的**不是**「数据太旧」,而是 `refreshSkills` / `refreshAgents` 会
      `replaceAll()` 一个**进程内单例**(父 run 跑到一半时子 run 去重扫,
      父代理下一轮的 Skill 目录就被换掉了)。

      读一个文件、shell 一次 git,**什么单例都不动**,所以不属于那道闸门。
      而子代理在**同一个工作区**里改同一份代码:不给它项目规矩,它会写出一份
      不合仓库约定的代码交回来 —— 父代理拿到的只有结论,看不出错在哪一步。

      ★ 唯一不给子代理的是 todo 快照,而它**不需要特判**:快照是从 `messages`
      反推的,子 run 的 `messages` 是空的,推出来自然就是没有。这条自解。
    */
    projectInstructions = await abortable(() => loadInstructions(req.workspaceId, environment), handle.signal)
    git = await abortable(() => readGitContext(
      environment.spawn,
      environment.rootPath,
      handle.signal
    ), handle.signal)
    environment.assertReady()
    handle.signal.throwIfAborted()
  } catch (error) {
    release()
    if (!handle.signal.aborted) throw error
    handle.finish('aborted')
    store.setRunRecord(req.runId, req.sessionId, handle.status, startedAt, getHost().clock.now())
    return
  }

  const history = store.getHistory(req.sessionId)

  /*
    UserPromptSubmit 钩子。★ 位置是**拿到环境之后、`new AgentSession` 之前** ——
    用户消息是在 AgentSession 的构造函数里 commit 的，晚一步就拦不住了。
    （`ipc/agent.ts` 的 `startRun` 是同步函数，在那儿 await 不了，所以只能落这里。）

    守卫 `agent === undefined`：子 run 不跑这个事件，它没有「用户提交了提示词」这回事。
  */
  if (agent === undefined && req.input.length > 0) {
    const reports = await runHookEvent({
      event: 'UserPromptSubmit',
      environment,
      sessionId: req.sessionId,
      runId: req.runId,
      // `req.input` 是 ContentPart[]（可能带附件）；钩子只关心文字那部分。
      extra: { prompt: req.input.filter((p) => p.type === 'text').map((p) => p.text).join('\n') },
      signal: handle.signal
    })
    const blocked = reports.find((r) => r.outcome === 'blocked' || r.decision === 'deny')
    if (blocked !== undefined) {
      release()
      handle.finish('error', agentError('unknown', blocked.reason ?? '被钩子拦下'))
      store.setRunRecord(req.runId, req.sessionId, handle.status, startedAt, getHost().clock.now())
      return
    }
    /*
      注入走 `projectInstructions` 而不是新开一个字段：它经 `context-assembler.ts`
      的 `decorate` 只进**发出去的那份消息流**，转录一个字不动 —— 这正是钩子注入
      上下文该有的语义（不该出现在用户的聊天气泡里，也不该被重放到旧会话）。
    */
    const injected = reports.map((r) => r.additionalContext ?? '').filter((s) => s !== '').join('\n')
    if (injected !== '') {
      projectInstructions = projectInstructions === ''
        ? `<hook-context>\n${injected}\n</hook-context>`
        : `${projectInstructions}\n\n<hook-context>\n${injected}\n</hook-context>`
    }
  }
  const ref = normalizeEnvironmentRef(workspace.environment)
  const fileReferenceSource: FileReferenceSource = ref.kind === 'connection'
    ? { kind: 'workspace', workspaceId: workspace.id, environment: ref, rootPath: environment.rootPath, connectionRevision: store.getConnectionProfile(ref.connectionId)?.revision ?? -1 }
    : { kind: 'local' }
  const resources: RunResources = inheritedResources ?? { environment, fileReferenceSource, agents: runAgents, tools: snapshotRunTools(environment, runAgents, scopedMcpTools) }
  let agentSession: AgentSession
  try { agentSession = new AgentSession(
    {
      host: getHost(),
      fileReferenceSource: resources.fileReferenceSource,
      ...(environment.remote ? { workspace: environment } : {}),
      upstream: getRouter(),
      tools: resources.tools,
      workspaceRoot: environment.rootPath,
      /**
       * ★ 多轮的全部实现。缺省(空转录)意味着模型每轮都从零开始 ——
       * 界面上明明有三轮问答,它却只看得见最后一句。
       *
       * 存储由 `state/store` 收口到 SQLite；这里始终只依赖
       * `getHistory`/`message_commit`，不接触数据库结构。
       */
      history,
      contextManagement: store.getSettings().contextManagement,
      contextCheckpoints: store.listContextCheckpoints(req.sessionId),
      saveContextCheckpoint: (checkpoint) => {
        store.upsertContextCheckpoint(checkpoint)
      },
      onMessageCommit: (message) => {
        // ★ 带上 runId:重启之后逐轮用量全靠这一跳把消息接回 `usage_records`
        // (那张表一直有 run_id,缺的一直是反向的归属)。
        store.commitMessage(req.sessionId, message, req.runId)
        // message_commit 已经完成 SQLite 写入，再通知渲染层刷新侧边栏
        // 的 updatedAt；事件泵随后仍会按原顺序接收 message_commit。
        //
        /*
          ★ 子 run 不广播。`commitMessage` 只 bump **它自己那条会话**的 updated_at,
          父的一个字节没变;而子会话又不在 `listSessions` 里 —— 这次广播会让每个
          窗口重拉一遍列表,然后渲染出和上一帧逐字相同的结果。一个跑 30 轮的
          后台子代理就是 30 次这样的空转,且正好落在主进程最忙的时刻
          (`listSessions` 对每一行还要多一次 `getSession` 去读 favorited,
          而 `DatabaseSync` 是同步阻塞的)。

          判据用 `parentSessionId` 而不是 `depth === 0`:让「这条会话是隐藏的」
          和「不发侧边栏事件」共用同一个条件,将来多一种隐藏会话也自动跟上。
        */
        if (req.parentSessionId === undefined) sessionOnChange?.({ kind: 'messages', sessionIds: [req.sessionId], workspaceId: req.workspaceId })
      },
      onToolUsage: ({ runId, toolCalls, toolErrors }) => {
        store.updateUsageToolsForRun(runId, toolCalls, toolErrors)
      },
      /*
        PostToolUse 钩子。★ 只能追加反馈，不能改 output（见 `SessionDeps` 上那段）。

        `exit 2` 时把 `isError` 翻成 true —— 「你的改动被 lint 钩子拒绝了」是模型
        能据此行动的信息，而一段夹在正常输出里的抱怨它多半会忽略。
      */
      onToolExecuted: async ({ tool, input, output, isError }) => {
        const reports = await runHookEvent({
          event: 'PostToolUse',
          environment,
          sessionId: req.sessionId,
          runId: req.runId,
          tool: { internalId: tool.internalId, externalName: tool.externalName, input },
          extra: { toolOutput: output.content, toolIsError: isError },
          signal: handle.signal
        })
        if (reports.length === 0) return undefined
        const context = reports.map((r) => r.additionalContext ?? r.reason ?? '').filter((s) => s !== '').join('\n')
        const blocked = reports.some((r) => r.outcome === 'blocked')
        return {
          ...(context === '' ? {} : { additionalContext: context }),
          ...(blocked ? { isError: true } : {})
        }
      },
      approve: approveWith(req, handle, environment),
      interact: (draft) => interactions.request(handle, draft, getHost().clock.now()),
      /*
        ★ 这里给的是**目录**,不是正文。`context-assembler.ts` 只读
        name / description 两个字段拼成一行一条的清单,正文要模型自己调
        `Skill` 工具去取(渐进披露)。传的仍然是完整的 `Skill` 对象,
        是因为注册表本来就有它,而多一份裁剪过的类型只会多一处要同步的地方。
      */
      skills: activeSkills(req, runSkills),
      /*
        ★ 角色提示词是**追加**的(见 `buildSystemPrompt` 里那段),
        工具清单是**收窄**的(`snapshot` 只过滤不新增)。两个方向都只能变严,
        所以一个 agent 定义文件永远不可能给子代理拿到父代理没有的东西。
      */
      ...(agent !== undefined ? { agentPrompt: agent.prompt } : {}),
      ...(agent?.tools !== undefined ? { allowedTools: agent.tools } : {}),
      spawnSubagent: spawnSubagentFor(handle, req, runSkills, resources),
      /*
        ★ 这两项注入的是**发出去的那份消息流**,转录一个字都不动
        (`context-assembler.ts` 的 `decorate`)。commit 进转录的话,用户会在
        **自己的**聊天气泡里逐字读到整篇 AGENTS.md,而且旧会话会永远重放旧规矩。
      */
      ...(projectInstructions !== '' ? { projectInstructions } : {}),
      ...(git !== undefined ? { git } : {}),
      /*
        ★ 和上面两项一样**照给子代理** —— 用户设的是「跟我说话时是什么样」,
        而子代理写的代码、交回的结论最终都是给同一个人看的。

        无条件给,不在这里判断三栏是不是全空:`buildPersonalizationSection`
        对全空的那份返回空串,而空串会被 `buildSystemPrompt` 的 filter 丢掉 ——
        「什么都没填」这件事只该有一个地方知道,多一处判断就多一处会漂移的判断。
      */
      personalization: store.getSettings().personalization
      ,...(approvedPlanContext === undefined ? {} : { approvedPlan: approvedPlanContext })
    },
    handle,
    req
  ) } catch (error) { release(); throw error }
  /**
   * `finally` 而不是 `then`:中断路径上 `finalizeAbort` 已经把半截回复和
   * 补上的 tool_result 都写进了 `history`。不在中断时落盘,下一轮就会带着
   * 一堆没有配对 tool_result 的 tool_call 上行 —— 那正是方案 §4.8
   * 花了整节篇幅避免的 400。
   */
  const running = agentSession.run()
  if (agent === undefined && req.depth === 0 && history.length === 0 && req.input.length > 0 && !handle.signal.aborted) {
    // The primary stream has already started. Title generation is detached from
    // its promise, and from tool calls, approval waits, and later user turns.
    try {
      const current = store.getSession(req.sessionId)
      const firstMessage = agentSession.history[0]
      if (current !== undefined && firstMessage !== undefined) getSessionTitles().start(current, firstMessage, req.model, req.modelProviderId)
    } catch {
      getHost().logger.warn('[session-title] Could not start background title generation.')
    }
  }
  return running.finally(() => {
    release()
    /*
      Stop 钩子 —— 一轮运行收尾。★ fire-and-forget 且**不 await**：这里是
      `finally` 里的异步续延，落盘才是正事；让一条通知脚本拖慢转录落盘，
      换来的是「应用退出时这一轮没存上」。
      守卫 `depth === 0 && parentSessionId === undefined`：子 run 收尾走
      SubagentStop，不重复触发。
    */
    if (req.depth === 0 && req.parentSessionId === undefined) {
      void runHookEvent({
        event: 'Stop',
        environment,
        sessionId: req.sessionId,
        runId: req.runId,
        extra: { status: handle.status }
      }).catch(() => undefined)
    }
    // message_commit 已逐条落盘；replaceHistory 是兼容旧调用/修复异常的最终校验。
    // A detached child may have completed between the last commit and this
    // final write. Preserve its newest durable metadata when replacing the
    // parent's in-memory snapshot.
    /**
     * ★ 这是一个**异步续延**:`abortAll()` 早已返回,库可能已经在退出流程里封掉了
     * (`shutdownRuns()` 同步返回,6 秒兜底的 `finish()` 不等环境/MCP 关完就 closeDatabase)。
     * 封库后写入会抛 —— 抛在 finally 里会变成无人接管的 rejection,所以在这里收住,
     * 并留一条日志:这一条转录确实没落盘,不能假装它落了。
     */
    try {
      const latest = store.getHistory(req.sessionId)
      store.setHistory(req.sessionId, mergeLatestSubagentReceipts(agentSession.history, latest))
      store.setRunRecord(req.runId, req.sessionId, handle.status, startedAt, getHost().clock.now())
    } catch (error) {
      getHost().logger.warn(`[runtime] run ${req.runId} 的收尾写入没有落盘:${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** 测试专用:把单例清干净,让每个用例从同一个起点开始。 */
export function resetRuntimeForTest(): void {
  shutdownSessionTitles()
  void environments?.shutdown()
  environments = null
  for (const scope of workspaceMcps.values()) { void scope.manager.shutdown(); scope.release() }
  workspaceMcps.clear()
  interactions.clear()
  host = null
  router = null
  tools = null
  // 不 await shutdown:这个函数是同步的(beforeEach 里调),而留着的
  // manager 会攥着上一个用例的 ToolRegistry —— 那正是要断开的引用
  mcp = null
  mcpOnChange = null
  sessionOnChange = null
  childRunLauncher = null
  childSeq = 0
  seeded = false
  store.clearHistoriesForTest()
}
