/**
 * 上游供应商与模型别名。读 + 写(步骤 4 的写入面)。`test` 仍是 todo ——
 * 真发一次请求要先有 OpenAI 那两套编解码(步骤 13),否则对非 Anthropic 协议
 * 必然失败,那不是「连不通」而是「我们还没实现」,报给用户是误导。
 *
 * 单独实现这两条,是因为它们是**输入框那颗模型选择器的唯一数据源**:
 * 没有它们,发送行上那颗药丸只能写死一个字符串,而「当前用的是哪个上游、
 * 它支不支持思考」这件事在界面上就永远是假的。
 *
 * 走 `store` 而不是 `getRouter().listModels()`:后者会在别名表之上再叠一层
 * 健康与候选集筛选(方案 §5.3),而下拉框要显示的是**用户配过的全部模型**,
 * 不是「此刻健康的那些」。一个正在冷却的 provider 不该从下拉框里消失 ——
 * 它应该显示出来并标成不可用,否则用户会以为自己的配置丢了。
 *
 * ★ 但 seed 必须先跑。`runtime.getRouter()` 是 seed 的触发点之一,而首屏
 * 拉模型列表时可能还没有任何 run 跑过 —— 于是这里显式调用 `ensureSeeded()`,
 * 否则全新安装点开下拉框是空的,而内置上游明明已经在设置里被指成默认模型了。
 */
import type { AppSettingsPatch } from '../../shared/domain/settings'
import type {
  AnthropicCacheTtl,
  CredentialInfo,
  FetchedModel,
  ModelAlias,
  ProviderProtocolOptions,
  UpstreamProvider
} from '../../shared/domain/provider'
import {
  IMPORTED_ALIAS_DEFAULTS,
  normalizeAnthropicCacheTtl,
  PROTOCOL_LABEL
} from '../../shared/domain/provider'
import { removeCredential } from '../db/repo'
import {
  modelListErrorMessage,
  modelListRequest,
  parseModelList
} from '../kernel/upstream/model-list'
import { ensureSeeded, getHost } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'

export function listProviders(): UpstreamProvider[] {
  ensureSeeded()
  return store.listProviders()
}

/**
 * `providerId` 省略 = 全部别名。
 *
 * 排序照 provider 的 priority(`listProviders` 已经排好),同一 provider 内
 * 保持配置顺序 —— 下拉框的顺序是用户资产,不该按字典序重排成他不认识的样子。
 */
export function listModels(providerId?: string): ModelAlias[] {
  ensureSeeded()
  const rank = new Map(store.listProviders().map((p, i) => [p.id, i]))
  return store
    .listAliases()
    .filter((a) => providerId === undefined || a.providerId === providerId)
    .sort((a, b) => (rank.get(a.providerId) ?? 1e9) - (rank.get(b.providerId) ?? 1e9))
}

/** Update one configured model while preserving provider/alias identity. */
export function updateModel(input: ModelAlias): ModelAlias {
  ensureSeeded()
  const existing = store.listAliases().find(
    (m) => m.providerId === input.providerId && m.alias === input.alias
  )
  if (existing === undefined) throw new Error(`模型不存在: ${input.alias}`)
  const normalized: ModelAlias = {
    ...existing,
    ...input,
    providerId: existing.providerId,
    alias: existing.alias,
    upstreamModel: existing.upstreamModel,
    enabled: input.enabled !== false,
    capabilities: { ...existing.capabilities, ...input.capabilities },
    thinkingConfig: input.thinkingConfig ?? existing.thinkingConfig,
    requestAdapter: input.requestAdapter ?? existing.requestAdapter
  }
  store.putAlias(normalized)
  broadcast()
  return normalized
}

export function removeModel(providerId: string, alias: string): void {
  ensureSeeded()
  store.removeAlias(providerId, alias)
  repointDanglingDefaults()
  broadcast()
}

// ═══════════════════════════════════════════════════════════════
// 写入面(步骤 4)
// ═══════════════════════════════════════════════════════════════

function broadcast(): void {
  windows.emitToAll('provider:changed', {
    providers: store.listProviders(),
    models: store.listAliases()
  })
}

/**
 * 上游地址的校验。**放在主进程而不是只放在表单里** —— 渲染层的校验是给人看的
 * 提示,不是防线;频道本身可以被直接调用(协议 §3 规则 6 同一个理由)。
 *
 * ★ **只放行 http / https。** 不做白名单也不做黑名单,但 `file:` / `data:`
 * 这类必须挡:baseUrl 会被 `joinUpstreamUrl` 拼进 `net.fetch`,一个
 * `file:///etc/passwd` 的 baseUrl 等于把任意文件读取权交给渲染层,
 * 而这正是 `path-guard.ts` 在文件工具那一侧拦了半天的东西。
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('API 地址不能为空')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    throw new Error(`API 地址不是一个合法的 URL:${trimmed}`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`API 地址只能是 http 或 https,收到 ${u.protocol}`)
  }
  return trimmed
}

/** provider 的密钥引用。渲染层永远拿不到也永远指定不了 —— 见 upsertProvider */
function refFor(id: string): string {
  return `provider:${id}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isAnthropicCacheTtl(value: unknown): value is AnthropicCacheTtl {
  return value === 'off' || value === '5m' || value === '1h'
}

/** Merge protocol options without letting legacy renderer updates erase them. */
function mergeProtocolOptions(
  existing: ProviderProtocolOptions | undefined,
  incoming: unknown
): ProviderProtocolOptions | undefined {
  if (incoming === undefined) return existing
  const next = record(incoming)
  if (next === undefined) throw new Error('protocolOptions 必须是一个对象')

  const old = record(existing) ?? {}
  const merged: Record<string, unknown> = { ...old, ...next }
  if (Object.hasOwn(next, 'anthropic')) {
    const raw = next['anthropic']
    if (raw === undefined) {
      if (old['anthropic'] === undefined) delete merged['anthropic']
      else merged['anthropic'] = old['anthropic']
    } else {
      const anthropic = record(raw)
      if (anthropic === undefined) throw new Error('protocolOptions.anthropic 必须是一个对象')
      if (Object.hasOwn(anthropic, 'cacheTtl') && !isAnthropicCacheTtl(anthropic['cacheTtl'])) {
        throw new Error('Anthropic 缓存时长必须是 off、5m 或 1h')
      }
      const oldAnthropic = record(old['anthropic']) ?? {}
      merged['anthropic'] = {
        ...oldAnthropic,
        ...anthropic,
        cacheTtl: normalizeAnthropicCacheTtl(anthropic['cacheTtl'] ?? oldAnthropic['cacheTtl'])
      }
    }
  }
  return Object.keys(merged).length === 0 ? undefined : (merged as ProviderProtocolOptions)
}

/**
 * 新建或更新一个上游供应商。
 *
 * ★★ **`credentialRef` 一律不采信渲染层传来的值。**
 * 它是入参 `UpstreamProvider` 的一个字段,所以渲染层**能**填 —— 但填了就意味着
 * 「供应商 A 可以指向供应商 B 的密钥」,而密钥是只写不读的(方案 §9),
 * 渲染层本来就不该知道也不该决定这件事。所以:
 * - 已存在的:**保留库里那条的 ref**(改名换地址不该弄丢已经存好的 key);
 * - 新建的:主进程自己派生 `provider:<id>`。
 *
 * 内置上游的 ref 因此也稳得住 —— 它建表时用的是别的前缀,改地址不会把它冲掉。
 */
export function upsertProvider(input: UpstreamProvider): UpstreamProvider {
  ensureSeeded()
  const id = input.id.trim()
  if (id === '') throw new Error('供应商 id 不能为空')
  const name = input.name.trim()
  if (name === '') throw new Error('供应商名称不能为空')
  // 合法协议 = `PROTOCOL_LABEL` 的键。不另立一个 UPSTREAM_PROTOCOLS 数组:
  // 两份全集迟早漂开,而漏掉的那个协议会在这里被当成非法值拒掉
  if (!Object.hasOwn(PROTOCOL_LABEL, input.protocol)) {
    throw new Error(`未知的上游协议:${String(input.protocol)}`)
  }

  const existing = store.listProviders().find((p) => p.id === id)
  const protocolOptions = mergeProtocolOptions(existing?.protocolOptions, input.protocolOptions)
  const saved = store.putProvider({
    id,
    name,
    protocol: input.protocol,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    credentialRef: existing?.credentialRef ?? refFor(id),
    priority: Number.isFinite(input.priority) ? input.priority : 50,
    enabled: input.enabled,
    ...(protocolOptions === undefined ? {} : { protocolOptions })
  })
  broadcast()
  return saved
}

/**
 * 删掉一个供应商,连同它的别名。
 *
 * ★ 密钥**一起删**。留着的话下次有人建一个同 id 的供应商,会静默继承上一个的 key ——
 * 用户以为自己在配一个全新的上游,实际用的是早就该失效的凭证。
 */
export function removeProvider(id: string): void {
  ensureSeeded()
  const target = store.listProviders().find((p) => p.id === id)
  if (target === undefined) return
  for (const a of store.listAliases().filter((a) => a.providerId === id)) {
    store.removeAlias(a.providerId, a.alias)
  }
  store.removeProvider(id)
  /**
   * ★ 走 `db/repo` 的 removeCredential,**不是** `secrets.set(ref, '')`。
   * 后者会先过 `isEncryptionAvailable()`,在没有系统密钥环的机器上直接抛错 ——
   * 于是「删掉一个供应商」这件本该总能成功的事,会在那类机器上失败。
   * 删密文不需要加密能力。
   */
  removeCredential(target.credentialRef)
  repointDanglingDefaults()
  broadcast()
}

/**
 * 删掉供应商之后,把指向已消失别名的两个设置项接回来。
 *
 * ★★ **这必须在主进程做,不能留给设置页。** `defaultModel` 是一个 alias 字符串
 * (方案 §1.4 明确保留这个形状),删掉它所属的供应商之后它就悬空了 —— 而悬空的
 * 表现不是一句报错,是**下一次发送在路由器里找不到候选**。用户刚做的事(删一个
 * 不用的供应商)和看到的现象(对话发不出去)之间没有任何可见的联系。
 *
 * 放在 `removeProvider` 里而不是渲染层,是因为渲染层不是唯一的调用点,而
 * 「删完之后设置仍然自洽」是这条写入本身的一部分,不是界面的责任。
 *
 * 接到**剩下的第一条别名**(`listModels` 已按 provider 的 priority 排好),
 * 一条都不剩就置空 —— `defaultModel: ''` 是合法值,界面显示「跟随对话」。
 *
 * ★ 改完要自己发 `settings:changed`。`store.updateSettings` **不广播** ——
 * 广播在 `ipc/settings.ts` 那个 handler 里,而这条写入不走它。少了这一句,
 * 库里已经接好了、而设置页和输入框那颗药丸还显示着删掉的那个别名。
 */
function repointDanglingDefaults(): void {
  const alive = new Set(store.listAliases().map((a) => a.alias))
  const before = store.getSettings()
  const patch: AppSettingsPatch = {}

  if (before.defaultModel !== '' && !alive.has(before.defaultModel)) {
    patch.defaultModel = listModels()[0]?.alias ?? ''
  }
  // 子代理模型的空串是「跟随主对话」,本来就是合法的,所以悬空时置空即可
  if (before.subagent.model !== '' && !alive.has(before.subagent.model)) {
    patch.subagent = { model: '' }
  }
  if (Object.keys(patch).length === 0) return

  windows.emitToAll('settings:changed', store.updateSettings(patch))
}

/**
 * 从上游拉「这家有哪些模型」。参考图那颗「从服务商拉取模型列表」。
 *
 * 三处协议差异(路径 / 鉴权头 / 分页)全在 `kernel/upstream/model-list.ts` 里,
 * 那边是纯函数、有测试。这里只负责**取密钥、发请求、把失败翻译成人话**。
 *
 * ★ **不照预设表的 `supportsModelList` 拒绝。** 那个标记是我们某一天实测到的
 * 形状,而用户可能已经把地址改成了自己的中转 —— 照一张快照拒绝,等于让一个
 * 明明能用的端点永远拉不了,且没有任何绕过办法。置灰按钮是**界面**的事
 * (那里还能看见地址有没有被改过),这里试了再说。
 *
 * ★ 没有密钥时**不是直接失败**:预设表里 `modelListPublic` 的那几家
 * (OpenRouter / DeepInfra 实测 200)免鉴权就能拉,于是「key 还没填先看看
 * 有哪些模型」这条路是通的。带不带头的判断在 `modelListRequest` 里。
 */
export async function fetchModels(providerId: string): Promise<FetchedModel[]> {
  ensureSeeded()
  const p = store.listProviders().find((x) => x.id === providerId)
  if (p === undefined) throw new Error(`没有这个供应商:${providerId}`)

  const apiKey = await getHost().secrets.get(p.credentialRef)
  const { url, headers } = modelListRequest(p.protocol, p.baseUrl, apiKey === '' ? null : apiKey)

  let res: Response
  try {
    /*
      ★ 必须有超时。没有的话,一个不回包的地址(打错的域名、被墙的主机)会让
      导入弹窗一直转下去 —— 用户唯一的出路是关掉应用。20 秒足够慢网络拉一页,
      又短到不至于让人以为卡死了。
    */
    res = await getHost().fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? '超时(20 秒)' : String(e)
    // cause 留着原始的 fetch 错误:上面那句是给用户看的,而 ECONNREFUSED / 证书失败
    // 这类真正的区别只在原始异常里
    throw new Error(`连不上 ${url} —— ${reason}`, { cause: e })
  }

  if (!res.ok) {
    // ★ body 必须读完,否则连接不会被释放(和 `router.ts` 那处同一个理由)
    const text = await res.text().catch(() => '')
    throw new Error(modelListErrorMessage(res.status, text))
  }

  const payload: unknown = await res.json().catch(() => null)
  const models = parseModelList(p.protocol, payload)
  if (models.length === 0) {
    // 200 但一条都解不出来 —— 报清楚这是「解析不出」而不是「这家没有模型」
    throw new Error(`${url} 返回了 200,但响应里没有能识别的模型列表`)
  }
  return models
}

/**
 * 整表替换这家的模型别名 —— 导入弹窗点「更新列表」时走这条。
 *
 * ★★ **替换语义**:调用完之后这家的别名 = `models` 里那些,一个不多一个不少。
 * 参考图那句「取消勾选会从当前列表删除」就是它。
 *
 * ★ **已有的那条整行留着,只按 `upstreamModel` 认。** 用户可能给它改过别名、
 * 调过上下文窗口(将来那个编辑入口通了之后)—— 重新导入一次就把这些冲掉,
 * 等于每次点「拉取」都在悄悄重置他的配置。所以匹配用 `upstreamModel`,
 * 命中就原样保留,只有**新的**才套 `IMPORTED_ALIAS_DEFAULTS`。
 *
 * ★ 末尾必须 `repointDanglingDefaults()`:取消勾选掉的那个可能正是
 * `settings.defaultModel`,而它悬空的表现不是报错,是**下一次发送在路由器里
 * 找不到候选**(理由见那个函数的文件头)。
 */
export function setAliases(providerId: string, models: readonly string[]): ModelAlias[] {
  ensureSeeded()
  const p = store.listProviders().find((x) => x.id === providerId)
  if (p === undefined) throw new Error(`没有这个供应商:${providerId}`)

  // 去重后再判上限:重复项是渲染层的 bug,不该变成一句「超过 20 个」的假报错
  const wanted: string[] = []
  const seen = new Set<string>()
  for (const raw of models) {
    const m = raw.trim()
    if (m === '' || seen.has(m)) continue
    seen.add(m)
    wanted.push(m)
  }
  // 模型管理控制台支持完整的供应商目录，不再限制为 20 条。

  const before = store.listAliases().filter((a) => a.providerId === providerId)
  const keep = new Map<string, ModelAlias>()
  for (const a of before) if (!keep.has(a.upstreamModel)) keep.set(a.upstreamModel, a)

  for (const a of before) {
    if (!seen.has(a.upstreamModel) || keep.get(a.upstreamModel) !== a) {
      store.removeAlias(providerId, a.alias)
    }
  }
  for (const m of wanted) {
    const existing = keep.get(m)
    // ★ 别名默认等于上游模型名(和 seed 那条一致)。这里不加任何前缀/后缀 ——
    // 别名是用户在药丸和 `defaultModel` 里看见的字符串,加工过就对不上他在上游文档里读到的名字
    store.putAlias(
      existing ?? { ...IMPORTED_ALIAS_DEFAULTS, alias: m, providerId, upstreamModel: m }
    )
  }

  repointDanglingDefaults()
  broadcast()
  return listModels(providerId)
}

function infoFor(plaintext: string | null): CredentialInfo {
  const available = getHost().secrets.available()
  if (plaintext === null || plaintext === '') {
    return { hasKey: false, last4: null, encryptionAvailable: available }
  }
  // ★ 只回后四位。整串明文到这里就止步了 —— 「只写不读」就是这一行
  return { hasKey: true, last4: plaintext.slice(-4), encryptionAvailable: available }
}

/** 存一把密钥。`isEncryptionAvailable() === false` 时 host 会抛错拒绝,不做明文降级 */
export async function setCredential(providerId: string, apiKey: string): Promise<CredentialInfo> {
  ensureSeeded()
  const p = store.listProviders().find((x) => x.id === providerId)
  if (p === undefined) throw new Error(`没有这个供应商:${providerId}`)
  const key = apiKey.trim()
  if (key === '') throw new Error('密钥不能为空')
  await getHost().secrets.set(p.credentialRef, key)
  return infoFor(key)
}

export async function getCredentialInfo(providerId: string): Promise<CredentialInfo> {
  ensureSeeded()
  const p = store.listProviders().find((x) => x.id === providerId)
  if (p === undefined) throw new Error(`没有这个供应商:${providerId}`)
  return infoFor(await getHost().secrets.get(p.credentialRef))
}
