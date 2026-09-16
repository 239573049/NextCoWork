/**
 * 当前**生效**的动效档位。
 *
 * ★ 和 `useAppearance` 是同一个手法:读 `<html>` 上 `applyProfile` 刚写下去的
 * `data-theme-motion`,而不是再去 settings 里算一遍。两个事实来源在切换的那一帧
 * 一定会对不上。
 *
 * ★★ **为什么 CSS 那边已经处理过了,这里还要再来一遍。**
 *
 * `theme.css` 里有这么一段:
 *
 *     :root[data-theme-motion='reduced'] *,
 *     :root[data-theme-motion='off'] * { animation-duration: 0ms !important; … }
 *
 * 它只管得住 **CSS transition / CSS animation**。Motion(Framer Motion)走的是
 * WAAPI 和 rAF —— 值是一帧一帧写进行内样式的,`animation-duration` 压根不参与,
 * `!important` 也就无从谈起。也就是说:**光靠那段 CSS,勾了「减弱动态效果」的用户
 * 仍然会看到 Motion 的全部动画**。所以凡是用 Motion 的地方都得从这里取档位。
 *
 * 同时并进系统级的 `prefers-reduced-motion` —— 用户可能没动应用内设置,
 * 但在系统里勾了。两者取更保守的那个。
 */
import { useSyncExternalStore } from 'react'

/** 与 `ThemeProfile['motion']['level']` 同构。这里不 import,免得渲染层去牵领域类型。 */
export type MotionLevel = 'standard' | 'soft' | 'reduced' | 'off'

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * ★ **`matchMedia` 不能假设存在。** jsdom 没有实现它(是它已知的空缺之一),
 * 而渲染层的组件测试就跑在 jsdom 里 —— 直接调用会让每一个渲染到转录区的
 * 测试文件当场抛 `window.matchMedia is not a function`。
 * 取不到就当「没勾减弱动态效果」,把判断交还给 `data-theme-motion`。
 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_QUERY).matches
}

function subscribe(onChange: () => void): () => void {
  /*
    ★ **`window.MutationObserver` 而不是裸的 `MutationObserver`。**

    渲染层的组件测试不跑在 vitest 的 jsdom environment 里,而是各自
    `new JSDOM(...)` 再 `vi.stubGlobal('window', dom.window)`(见
    `__tests__/subagent-report-row.test.ts`)。那种做法只把点名的那几个全局
    塞进去 —— `window` / `document` / `ResizeObserver` 有,`MutationObserver` 没有。
    于是裸的那个名字在测试里是 `undefined`,而 `window.` 上的一直都在。
    浏览器里两者本来就是同一个对象,写成 `window.` 不损失任何东西。
  */
  const ob = new window.MutationObserver(onChange)
  ob.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme-motion']
  })
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null
  mq?.addEventListener('change', onChange)
  return () => {
    ob.disconnect()
    mq?.removeEventListener('change', onChange)
  }
}

function snapshot(): MotionLevel {
  if (prefersReducedMotion()) return 'reduced'
  const level = document.documentElement.dataset['themeMotion']
  return level === 'soft' || level === 'reduced' || level === 'off' ? level : 'standard'
}

export function useMotionLevel(): MotionLevel {
  // 首屏那几帧属性还没写上去,按 `standard` 算 —— 和 `applyProfile` 的默认值一致
  return useSyncExternalStore(subscribe, snapshot, () => 'standard')
}

/**
 * 档位 → 时长乘数。`reduced` / `off` 给 0,调用点直接把 transition 时长乘上去
 * 就得到「瞬间到位」,不必在每处再写一遍 if。
 *
 * `soft` 给 1.25 而不是更小:这一档的意思是「慢一点、柔一点」(`theme.css` 里
 * 它把 CSS transition 拉到 180ms),不是「少一点」。
 */
export function motionScale(level: MotionLevel): number {
  return level === 'off' || level === 'reduced' ? 0 : level === 'soft' ? 1.25 : 1
}
