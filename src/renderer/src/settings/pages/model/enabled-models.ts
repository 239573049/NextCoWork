/**
 * 左列「启用的模型」的判断逻辑。
 *
 * ★ **参考图那一列的每一行是一个「供应商」,不是一个模型** —— 行标题是供应商名
 * (RoutinAI / NewMax Gateway),副标题才是它当前的主模型(`claude-fable-5-1` /
 * `doubao-seed-2.1-pro`)。右侧面板那张「模型优先级」列表才是这家底下的模型们。
 * 照字面把它做成模型列表,右侧面板就没有主语了。
 */
import type { ModelAlias, UpstreamProvider } from '../../../../../shared/domain/provider'

export interface ProviderEntry {
  provider: UpstreamProvider
  /** 这家提供的别名,保持 store 的顺序(将来是 `ModelAlias.order`) */
  aliases: readonly ModelAlias[]
  /** 副标题显示的那个。没有别名时为 null —— 显示成「未配置模型」而不是空一行 */
  primaryAlias: string | null
  /**
   * ★ 语义是「**这家能提供当前的默认模型**」,不是「它排在第一位」。
   *
   * 参考图把「默认」做成首行的徽章,是因为那边一个别名只有一个来源。
   * 我们的故障切换轴恰恰是**同一个别名、多个供应商**(`router.ts` 的候选链),
   * 所以能提供默认别名的可能有好几家 —— 那时**每一家都挂徽章**才是真话。
   * 只给第一家挂,等于宣称另外几家跟这次请求无关,而它们其实随时会接手。
   */
  isDefault: boolean
}

export function providerEntries(
  providers: readonly UpstreamProvider[],
  models: readonly ModelAlias[],
  defaultModel: string
): ProviderEntry[] {
  return providers.map((provider) => {
    const aliases = models.filter((m) => m.providerId === provider.id)
    return {
      provider,
      aliases,
      primaryAlias: aliases[0]?.alias ?? null,
      // 空串 = 「跟随对话」,那时没有任何一家是默认的
      isDefault: defaultModel !== '' && aliases.some((m) => m.alias === defaultModel)
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
