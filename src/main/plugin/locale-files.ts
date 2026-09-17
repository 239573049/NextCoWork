/**
 * 插件 l10n bundle 的文件名 —— 和渲染层的 `SUPPORTED_LOCALES` 一一对应。
 *
 * ★ **单独一个文件**,是因为主进程不能 import 渲染层的 `i18n/index.tsx`
 * (那是一个带 JSX、带 React Context 的模块)。但「支持哪几种语言」这件事
 * 必须只有一个出处 —— 所以这里有一条测试钉住两张表一致:加一种语言却忘了
 * 在这里加文件名,插件的那种语言就会永远缺失,而装载时一个字都不会报。
 */
export const SUPPORTED_LOCALE_FILES = ['zh-CN.json', 'en-US.json'] as const

export type PluginLocaleFile = (typeof SUPPORTED_LOCALE_FILES)[number]

/** `zh-CN.json` → `zh-CN` */
export function localeOfFile(file: string): string {
  return file.replace(/\.json$/, '')
}
