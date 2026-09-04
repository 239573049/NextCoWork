/**
 * 当前**生效**的深浅。
 *
 * ★ **读的是 `<html>` 上的 `data-theme`,也就是 `applyTheme` 刚写下去的那一份。**
 * 于是它不可能和界面上真正的颜色对不上 —— 两者是同一个值。
 *
 * 为什么不从 `settings.theme` 现算:那是三态的,`system` 要解析,而解析结果
 * 只有主进程的 `nativeTheme` 知道(它经 `theme:changed` 下发)。在渲染层再拿
 * `prefers-color-scheme` 算一遍就是第二个事实来源,而它和主进程那份**会**在
 * 跟随系统切换的那一瞬间对不上 —— 表现是设置页里的色板比界面慢半拍。
 *
 * 只有「需要预览某套主题长什么样」的地方要它(设置页的色板圆点)。
 * 真正上色的是 `apply.ts`,不是这里。
 */
import { useSyncExternalStore } from 'react'
import type { ResolvedTheme } from '../../../shared/domain/settings'

function subscribe(onChange: () => void): () => void {
  const ob = new MutationObserver(onChange)
  ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => ob.disconnect()
}

/**
 * 首屏那几帧 `data-theme` 还没写上去(要等一次 IPC 往返),此时按深色算 ——
 * `theme.css` 里 `@theme` 那套默认值就是深色,和它保持一致。
 */
function snapshot(): ResolvedTheme {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

export function useAppearance(): ResolvedTheme {
  return useSyncExternalStore(subscribe, snapshot)
}
