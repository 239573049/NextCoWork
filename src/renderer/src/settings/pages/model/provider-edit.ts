/**
 * 「翻 API 格式开关时,地址该跟着换吗」——这一个判断。
 *
 * 抽成 `.ts` 而不是留在 `ProviderPanel.tsx` 里,是因为 `vitest.config.ts` 是 node
 * 环境、`include` 只收 `.ts`:留在 `.tsx` 里写了测试也不会跑。
 *
 * ## 为什么非换不可
 *
 * 同一家厂商两个协议的**路径前缀往往不同**(调研实测:DeepInfra `…/v1/openai` ↔
 * `…/anthropic`、OpenRouter `…/api/v1` ↔ `…/api`、智谱 `…/api/paas/v4` ↔
 * `…/api/anthropic`、内置的 RoutinAI `…/v1` ↔ 裸域名)。地址不跟着换的话,
 * 用户翻一下开关,表单看着完全正常、请求 404 —— 而他不会想到是那个开关干的。
 *
 * ## 为什么不能无条件换
 *
 * ★ **用户改过的地址不许覆盖。** 判据是「当前地址是否还等于**旧协议**那条预设值」:
 * 相等 = 他没动过,换是安全的;不等 = 这是他自己填的(自建中转、私有部署),
 * 换掉就是把他的输入吃掉,而那比 404 更糟 —— 404 至少看得见。
 *
 * 认不出预设(自定义供应商)也一律保留原地址。**宁可少换,不可乱换**,
 * 和 `baseurl.ts` 那句「错误代价不对称」是同一条:少换用户看得见也改得动,
 * 换错了他会以为是我们的请求实现有问题。
 */
import { endpointFor, findPreset, type ProviderPreset } from '../../../../../shared/domain/presets'
import type { UpstreamProtocol, UpstreamProvider } from '../../../../../shared/domain/provider'

export interface ProtocolSwitch {
  /** 切过去之后该用的地址 */
  baseUrl: string
  /** 地址确实换了(界面据此提示一句,别让它静默变化) */
  changed: boolean
}

export function baseUrlForProtocol(
  current: { id: string; baseUrl: string; protocol: UpstreamProtocol },
  next: UpstreamProtocol
): ProtocolSwitch {
  const keep: ProtocolSwitch = { baseUrl: current.baseUrl, changed: false }
  if (next === current.protocol) return keep

  const preset = findPreset(current.id)
  if (preset === null) return keep

  const to = endpointFor(preset, next)
  if (to === null) return keep

  // 旧协议那条预设值。查不到就说明这个供应商当前用的协议本来就不在预设里,
  // 没有可比的基准 —— 那就不动
  const from = endpointFor(preset, current.protocol)
  if (from === null || from.baseUrl !== current.baseUrl) return keep

  return { baseUrl: to.baseUrl, changed: to.baseUrl !== current.baseUrl }
}

/**
 * 这个供应商在预设里有没有该协议的端点。
 *
 * 用来在开关旁边提示「这家没有 Responses 端点」——★ 而不是**禁掉**那个开关:
 * 预设表只是我们实测到的形状,厂商随时可能加,禁掉就等于拿一张快照锁死用户。
 * 提示了还要开,是他的选择。
 */
export function presetHasProtocol(providerId: string, protocol: UpstreamProtocol): boolean {
  const preset = findPreset(providerId)
  return preset !== null && endpointFor(preset, protocol) !== null
}

/**
 * 新建供应商时的优先级。
 *
 * 内置 RoutinAI 是 50,所以预设建出来的排在它后面 —— 内置那条是我们替用户选的,
 * 他自己挑的那家该压过它,但**优先级不是排序**:它决定故障切换先试谁。
 * (手工建的演示上游是 100,全表最低,谁都排在它前面。)同值时 `repo.listProviders` 用 id 兜底,
 * 顺序是确定的 —— 故障切换按这个顺序挑候选,「今天先切 A、明天先切 B」比切错还难查。
 */
export const PRESET_PRIORITY = 60

/**
 * 预设 → 一条真的供应商记录。
 *
 * ★★ **`id` 必须等于预设 id。** 这不是图省事:`baseUrlForProtocol` 和
 * `presetHasProtocol` 都靠 `findPreset(provider.id)` 找回端点表,id 一旦改成
 * 随机串或者带前缀,翻「API 格式」开关时地址就不会跟着换了 —— 而那正是
 * 这一整套结构存在的理由。同名冲突由调用点先查重挡住(见 `isPresetAdded`)。
 *
 * ★ 协议取 `endpoints[0]`,因为预设表里第一条就是该厂商的**主推形态**
 * (OpenAI 是 openai-chat、Anthropic 与 RoutinAI 是 anthropic)。不去猜
 * 「哪个更好」——用户翻一下开关就能换,而猜错的代价是他配完才发现走的不是那条。
 *
 * ★ **不填密钥**,`credentialRef` 给一个占位:主进程一律不采信渲染层传来的这个值,
 * 它会自己派生 `provider:<id>`(见 `main/ipc/provider.ts` 的 upsertProvider)。
 */
export function providerFromPreset(preset: ProviderPreset): UpstreamProvider | null {
  const first = preset.endpoints[0]
  if (first === undefined) return null
  return {
    id: preset.id,
    name: preset.name,
    protocol: first.protocol,
    baseUrl: first.baseUrl,
    credentialRef: `provider:${preset.id}`,
    priority: PRESET_PRIORITY,
    enabled: true
  }
}

/** 这家是不是已经建过了。目录里据此把「添加」换成「已添加」,而不是建出第二条 */
export function isPresetAdded(
  preset: ProviderPreset,
  existing: readonly { id: string }[]
): boolean {
  return existing.some((p) => p.id === preset.id)
}

/**
 * 从目录添加这家时,该顺手种进去的模型名。
 *
 * ★★ **判据是 `supportsModelList === false`,不是「是不是某一家」。**
 * 那个标记为 false 的供应商,「从服务商拉取模型列表」按钮是**灰的** ——
 * 不种的话,用户添加完得到的是一家零模型、且没有第二条路的供应商,一条死路。
 * (`ProviderCatalog.add()` 以前只建供应商、从不种别名,对拉得动列表的那些
 * 没问题,对这些就是死路。)
 *
 * ★★ **`supportsModelList` 为 true 的一律不种。** 那些的真实列表随时能拉,
 * 而 `suggestedModels` 是一张**会腐烂**的快照(本文件头写着:调研当场就实测到
 * 老别名 `deepseek-chat` / `deepseek-reasoner` 已经下线)。拿一张旧快照去覆盖
 * 一条通着的实时路径,是用过期数据换一次少点的鼠标 —— 不划算。
 *
 * 认不出协议对应的端点时按「拉不动」处理:宁可多种两个能删的名字,
 * 也不要给出一家点什么都没有的供应商。
 */
export function seedModelsForPreset(
  preset: ProviderPreset,
  protocol: UpstreamProtocol
): string[] {
  if (endpointFor(preset, protocol)?.supportsModelList === true) return []
  return [...preset.suggestedModels]
}
