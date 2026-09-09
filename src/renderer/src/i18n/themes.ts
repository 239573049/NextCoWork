export const themesZh = {
  'themeStudio.builtin.color.random': '随机',
  'themeStudio.builtin.color.ink-green': '墨绿',
  'themeStudio.builtin.color.celadon': '霁青',
  'themeStudio.builtin.color.claude': 'Claude',
  'themeStudio.builtin.color.opulent': '奢华',
  'themeStudio.builtin.color.minimal': '极简',
  'themeStudio.builtin.color.custom': '自定义',
  'themeStudio.builtin.image.misty-forest': '雾林深境',
  'themeStudio.builtin.image.clear-sky': '晴穹蓝构',
  'themeStudio.builtin.image.terracotta': '陶土叠影',
  'themeStudio.builtin.image.soft-bloom': '雾花柔光',
  'themeStudio.builtin.image.silver-facet': '银白折面',
  'themeStudio.builtin.image.jade-wave': '碧波弧影'
}

export const themesEn: Record<keyof typeof themesZh, string> = {
  'themeStudio.builtin.color.random': 'Random',
  'themeStudio.builtin.color.ink-green': 'Ink green',
  'themeStudio.builtin.color.celadon': 'Celadon',
  'themeStudio.builtin.color.claude': 'Claude',
  'themeStudio.builtin.color.opulent': 'Opulent',
  'themeStudio.builtin.color.minimal': 'Minimal',
  'themeStudio.builtin.color.custom': 'Custom',
  'themeStudio.builtin.image.misty-forest': 'Misty forest',
  'themeStudio.builtin.image.clear-sky': 'Clear sky',
  'themeStudio.builtin.image.terracotta': 'Terracotta',
  'themeStudio.builtin.image.soft-bloom': 'Soft bloom',
  'themeStudio.builtin.image.silver-facet': 'Silver facet',
  'themeStudio.builtin.image.jade-wave': 'Jade wave'
}

/** Unknown/newer theme IDs fall back to their stored names. User names never pass through this map. */
export function builtinThemeNameKey(kind: 'color' | 'image', id: string): keyof typeof themesZh | null {
  const key = `themeStudio.builtin.${kind}.${id}`
  return Object.hasOwn(themesZh, key) ? key as keyof typeof themesZh : null
}
