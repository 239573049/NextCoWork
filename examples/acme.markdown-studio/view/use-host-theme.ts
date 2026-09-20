/**
 * 跟随宿主的深浅色 —— 与 excalidraw 示例里那份同一立场:
 *
 * ★ 不读 prefers-color-scheme。用户可以在设置里把应用单独锁成浅色,
 *   那时系统是深色而应用不是 —— 以系统为准就把编辑器画反了。
 * ★ 初值同步取 `globalThis.__ncwTheme`,不是先给个默认值再等事件 ——
 *   否则深色下会先画一帧白底再跳过去,而那是打开 .md 的第一眼。
 * ★ 变化时监听宿主垫片派发的 `ncw:theme` 事件(它已经把 24 个 token
 *   写成了 --ncw-* 变量并同步了 data-theme)。
 */
import { useEffect, useState } from 'react'

export type Appearance = 'light' | 'dark'

export function useHostTheme(): Appearance {
  const [theme, setTheme] = useState<Appearance>(
    () => globalThis.__ncwTheme?.appearance ?? 'light'
  )
  useEffect(() => {
    const onTheme = (event: Event): void => {
      const detail = (event as CustomEvent<{ appearance?: string }>).detail
      setTheme(detail?.appearance === 'dark' ? 'dark' : 'light')
    }
    window.addEventListener('ncw:theme', onTheme)
    return () => { window.removeEventListener('ncw:theme', onTheme) }
  }, [])
  return theme
}
