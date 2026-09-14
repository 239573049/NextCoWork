/**
 * 图表配色。
 *
 * ## 为什么全是 `color-mix`,而不是新增一组分类色 token
 *
 * 主题只有**一个** accent,而且深浅两套里它是反的(深色亮绿 `#36d285`,
 * 浅色墨绿 `#2d4739`)。`theme.css` 里 `bg-accent/10` 那段注释论证过同一件事:
 * 派生而不是新增 —— 换色器换掉 accent 时,整套梯度自己跟着走;新增的分类色
 * 则会在换色后和界面其余部分脱节,而且没有任何地方会报错。
 *
 * ★ 这些字符串直接进 SVG 的 `fill` / `stroke` 属性,不经过任何 JS 计算,
 * 所以不需要 `getComputedStyle` 把 token 解析成具体色值 —— 浏览器自己会算,
 * 主题一变就跟着变。一旦改成在 JS 里算色值,就得自己订阅主题变化,
 * 而漏订阅的表现是「切主题后图表颜色不动」,只有肉眼能发现。
 */

/** 热力图五档。第 0 档是「当天没有活动」,用槽色而不是极淡的 accent。 */
const HEAT_MIX = [0, 20, 42, 68, 100] as const

export function heatColor(level: 0 | 1 | 2 | 3 | 4): string {
  const mix = HEAT_MIX[level] ?? 0
  // 第 0 档不掺 accent:空格子是「没发生」,不是「发生得很少」
  if (mix === 0) return 'var(--color-tint)'
  return `color-mix(in srgb, var(--color-accent) ${mix}%, var(--color-tint))`
}

/**
 * 按序号取一档强度。用于环形图与费用条 —— 序列已按占比降序,
 * 所以**最大的一片最浓**,读图时不必来回对图例。
 *
 * 下界压在 24%:再淡就和空槽分不开了。
 */
export function seriesColor(index: number, total: number): string {
  if (total <= 1) return 'var(--color-accent)'
  const span = 100 - 24
  const mix = Math.round(100 - (span * Math.min(index, total - 1)) / (total - 1))
  return `color-mix(in srgb, var(--color-accent) ${mix}%, var(--color-tint))`
}

/** 一整条色阶,长度为 `total`。 */
export function seriesPalette(total: number): string[] {
  return Array.from({ length: Math.max(0, total) }, (_, i) => seriesColor(i, total))
}
