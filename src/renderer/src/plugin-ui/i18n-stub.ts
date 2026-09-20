/**
 * `useI18n` 的**替身** —— 只在打 `nextcowork/ui` 这个包时顶替
 * `renderer/src/i18n`(由 `scripts/build-plugin-runtime.mjs` 里的解析插件换进来)。
 *
 * ## 为什么要替
 *
 * `components/ui/Dialog.tsx` 为了关闭按钮的无障碍名字用了一次 `t('common.close')`。
 * 真的把 `i18n/index.tsx` 打进来的话,插件视图会连带拿到那三千多行的全量文案表
 * ——一个只为了一个 aria-label 的 ~200KB,而且其中每一条都和插件无关。
 *
 * ## 为什么不是改 Dialog
 *
 * 给 Dialog 加一个 `closeLabel` prop 也能成,但那会让**宿主里 40 多处调用**
 * 多一个没人会传的参数,只为了服务一个它们不参与的构建。替身把代价留在了
 * 这个只有构建脚本会用到的文件里。
 *
 * ## 不认识的 key 怎么办
 *
 * **原样返回 key**,不返回空串。空串的症状是无障碍名字凭空消失(读屏软件念
 * 一个"按钮"),而返回 `common.close` 至少是看得见、搜得到的 —— 而且一眼就
 * 能看出该往下面这张表里补一行。
 */
const LABELS: Record<string, { zh: string; en: string }> = {
  'common.close': { zh: '关闭', en: 'Close' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.confirm': { zh: '确定', en: 'Confirm' }
}

/**
 * 视图用哪种语言。
 *
 * ★ 读 `<html lang>` —— 宿主的主题垫片会把它写上(和 `data-theme` 同一次)。
 * 读不到时按中文:这个应用的主要用户是中文用户,而猜错的代价只是一个
 * 关闭按钮的读屏文本。
 */
function locale(): 'zh' | 'en' {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang
  return lang.startsWith('en') ? 'en' : 'zh'
}

export function useI18n(): { t: (key: string) => string; locale: string } {
  return { t: translate, locale: locale() === 'en' ? 'en-US' : 'zh-CN' }
}

export function translate(key: string): string {
  return LABELS[key]?.[locale()] ?? key
}
