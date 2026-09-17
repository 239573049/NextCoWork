/**
 * 「认得字段名、但这一版不实现」的贡献点清单。
 *
 * ## 为什么需要这么一个文件
 *
 * 计划里被推迟的那几样(聊天内嵌渲染、调试适配器、交互式终端)**必须在
 * 插件运行期给出可理解的失败**,而不是静默不生效。
 *
 * 静默不生效是插件系统最糟的失败方式:作者写了 `contributes.chatRenderers`,
 * 装上、启用、什么都没发生,而日志里一个字都没有。他会去怀疑自己的打包、
 * 自己的清单格式、自己的 JSON 有没有写错 —— 唯独不会想到「宿主根本没实现」。
 *
 * 所以这里的每一条都会在装载时变成插件详情页上的**一条诊断**,
 * 照 `kernel/skill/load.ts` 的「永不 throw、一切失败变 diagnostics」。
 *
 * ## 这份清单随版本**收缩**
 *
 * 实现一个就删一行。它不是「将来要做的事」的清单(那在计划文档里),
 * 是「现在会让作者困惑的事」的清单。
 */

export interface UnsupportedContribution {
  /** `contributes` 下的键名 */
  key: string
  /** 给作者看的原因 —— 说清「为什么没有」,而不只是「没有」 */
  reason: string
}

export const UNSUPPORTED_CONTRIBUTIONS: readonly UnsupportedContribution[] = [
  {
    key: 'chatRenderers',
    reason: 'Inline chat renderers are not implemented yet. Contribute a view or a custom editor instead.'
  },
  {
    key: 'debuggers',
    reason: 'Debug adapters are out of scope for this host. There is no planned date.'
  },
  {
    key: 'taskDefinitions',
    reason: 'Task providers are not implemented. Use contributes.tools plus process.exec.'
  },
  {
    key: 'notebooks',
    reason: 'Notebook contributions are out of scope for this host.'
  },
  {
    key: 'terminals',
    reason: 'Interactive terminals are not implemented: their input cannot pass the approval chain. Use process.exec for non-interactive commands.'
  },
  {
    key: 'languages',
    reason: 'Language contributions are not implemented; onLanguage activation does not exist either.'
  }
]

const BY_KEY = new Map(UNSUPPORTED_CONTRIBUTIONS.map((entry) => [entry.key, entry]))

/**
 * 认不出的贡献点 → 一条给作者看的诊断文本。
 *
 * ★ 连**这份表里也没有**的键同样要出诊断(只是措辞不同):那多半是一个拼写
 * 错误,而拼错 `contirbutes.commands` 的症状和「没实现」一模一样。
 */
export function explainUnsupported(key: string): string {
  const known = BY_KEY.get(key)
  if (known !== undefined) return known.reason
  return `Unknown contribution point "${key}". It is ignored. Check the spelling against the plugin API docs.`
}
