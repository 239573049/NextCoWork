/**
 * 左列「启用的模型」的判断逻辑。
 *
 * ★ **参考图那一列的每一行是一个「供应商」,不是一个模型** —— 行标题是供应商名
 * (RoutinAI / NewMax Gateway),副标题才是它当前的主模型(`claude-fable-5-1` /
 * `doubao-seed-2.1-pro`)。右侧面板那张「模型优先级」列表才是这家底下的模型们。
 * 照字面把它做成模型列表,右侧面板就没有主语了。
 */
import type { ModelAlias, UpstreamProvider } from '../../../../../shared/domain/provider'
import { modelSelectionKey } from '../../../../../shared/domain/model-selection'

export interface ProviderEntry {
  provider: UpstreamProvider
  /** 这家提供的别名，保持 store 的优先级顺序。 */
  aliases: readonly ModelAlias[]
  /** 副标题显示的那个。没有别名时为 null —— 显示成「未配置模型」而不是空一行 */
  primaryAlias: string | null
  /**
   * ★ 语义是「**这家能提供当前的默认模型**」,不是「它排在第一位」。
   *
   * 两种情形:
   * - 用户**锁定了供应商**(`defaultModelProviderId` 有值)→ 只有那一家挂徽章。
   *   请求只会发给它,别家挂徽章就是假话。
   * - 没锁定 → **每一家都挂**。参考图把「默认」做成首行的徽章,是因为那边一个
   *   别名只有一个来源;我们的故障切换轴恰恰是同一别名多个供应商
   *   (`router.ts` 的候选链),这时只给第一家挂,等于宣称另外几家跟这次请求
   *   无关,而它们其实随时会接手。
   */
  isDefault: boolean
}

export function providerEntries(
  providers: readonly UpstreamProvider[],
  models: readonly ModelAlias[],
  defaultModel: string,
  defaultModelProviderId?: string
): ProviderEntry[] {
  return providers.map((provider) => {
    const aliases = models.filter((m) => m.providerId === provider.id)
    return {
      provider,
      aliases,
      primaryAlias: aliases[0]?.alias ?? null,
      // 空串 = 「跟随对话」,那时没有任何一家是默认的
      isDefault: defaultModel !== '' && aliases.some((m) => m.alias === defaultModel)
        && (defaultModelProviderId === undefined || provider.id === defaultModelProviderId)
    }
  })
}

/**
 * 「默认模型」/「默认子代理」/「审核模型」几个下拉框的选项。
 *
 * ★★ **一条绑定一个选项,不再按别名去重。** 别名的主键是 `(provider_id, alias)`,
 * 同一个别名可以挂在多家上 —— 而这几个设置项现在存的是**别名 + 供应商**一对,
 * 「哪一家」正是用户要选的东西(他选了 Codex 就不该被路由到 RoutinAI)。
 *
 * ★ 曾经必须按别名去重,是因为那时 `value` 就是裸别名:两个 `value` 相同的
 * `Select.Item` 都会认为自己被选中,各自把文本 portal 进触发器的 value 节点,
 * 于是那一格显示成 `gpt-6-astragpt-6-astra`(实测)。现在 `value` 是
 * `providerId/alias`,天然唯一,重复项本身不存在了 —— **不要把去重加回来**,
 * 加回来等于又把「选哪一家」这个选项从界面上抹掉。
 *
 * 别名只有一家提供时标签保持裸别名(不制造视觉噪音);多家撞名时才加供应商后缀,
 * 否则用户面对两条一模一样的文本仍然没法分辨。
 *
 * 保序:`listResolvedModels()` 已经按「供应商顺序 → priority → 别名」排好,这里不重排。
 */
export function modelOptions(
  models: readonly ModelAlias[],
  providers: readonly UpstreamProvider[] = []
): { value: string; label: string }[] {
  const shared = new Set<string>()
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.alias)) shared.add(model.alias)
    seen.add(model.alias)
  }
  return models.map((model) => {
    const providerName = providers.find((p) => p.id === model.providerId)?.name ?? model.providerId
    return {
      value: modelSelectionKey(model.providerId, model.alias),
      label: shared.has(model.alias) ? `${model.alias} · ${providerName}` : model.alias
    }
  })
}

/**
 * 头像里那个字。
 *
 * ★ 用 `[...name]` 而不是 `name[0]` —— emoji 和一部分汉字是代理对,
 * 按 UTF-16 取第 0 位会切出半个字符,渲染成一个 ▯。
 */
export function avatarInitial(name: string): string {
  const first = [...name.trim()][0]
  if (first === undefined) return '?'
  return first.toUpperCase()
}
