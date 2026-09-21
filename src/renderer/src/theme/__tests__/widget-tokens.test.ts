/**
 * 主题变量映射的单测。
 *
 * 这里钉的是**结构**,不是某几个色值 —— 色值随便改都行(它们来自用户的主题),
 * 但"info 族必须跟着 accent 走""边框必须是从文字色混出来的半透明"这类规则
 * 一旦被无意改掉,症状是"widget 里的链接和界面其余部分的颜色对不上",
 * 而那种错没人会当成 bug 报上来。
 */
import { describe, expect, it } from 'vitest'
import { WIDGET_SOURCE_VARS, widgetTokens, type WidgetSourceVars } from '../widget-tokens'

const LIGHT: WidgetSourceVars = {
  '--color-fg': '#181c19',
  '--color-fg-muted': '#72736f',
  '--color-fg-faint': '#96958f',
  '--color-accent': '#2d4739',
  '--color-danger': '#c4412c',
  '--color-surface': '#f6f4ef',
  '--color-surface-input': '#ffffff',
  '--color-canvas': '#faf9f5',
  '--color-accent-fg': '#ffffff',
  '--font-sans': 'system-ui, sans-serif',
  '--font-mono': 'ui-monospace, monospace',
  '--radius-card': '10px',
  '--radius-panel': '12px'
}

const DARK: WidgetSourceVars = {
  '--color-fg': '#ececec',
  '--color-fg-muted': '#959897',
  '--color-fg-faint': '#7b7d7c',
  '--color-accent': '#36d285',
  '--color-danger': '#d9614e',
  '--color-surface': '#232726',
  '--color-surface-input': '#2a2d2b',
  '--color-canvas': '#1e2020',
  '--color-accent-fg': '#0a2615'
}

describe('widgetTokens', () => {
  it('把应用 token 翻译成规范认得的名字', () => {
    const tokens = widgetTokens('light', LIGHT)
    expect(tokens['--color-text-primary']).toBe('#181c19')
    expect(tokens['--color-text-secondary']).toBe('#72736f')
    expect(tokens['--color-background-primary']).toBe('#ffffff')
    expect(tokens['--color-background-secondary']).toBe('#f6f4ef')
    expect(tokens['--p']).toBe('#181c19')
    expect(tokens['--bg2']).toBe('#f6f4ef')
  })

  /**
   * ★ info 族必须等于 accent:规范把 `--color-text-info` 用在"可点的/被强调的"
   * 地方(链接、推荐卡那道 2px 描边)。映射到别处的话,widget 里的链接
   * 会在换主题时留在原地 —— 而界面其余部分都跟着变了。
   */
  it('info 族跟着 accent 走', () => {
    for (const [appearance, source] of [['light', LIGHT], ['dark', DARK]] as const) {
      const tokens = widgetTokens(appearance, source)
      expect(tokens['--color-text-info']).toBe(source['--color-accent'])
      expect(tokens['--color-border-info']).toBe(source['--color-accent'])
      expect(tokens['--color-background-info']).toContain('color-mix')
    }
  })

  it('边框是从文字色混出来的三档透明度', () => {
    const tokens = widgetTokens('light', LIGHT)
    expect(tokens['--color-border-primary']).toBe('color-mix(in srgb, #181c19 40%, transparent)')
    expect(tokens['--color-border-secondary']).toBe('color-mix(in srgb, #181c19 30%, transparent)')
    expect(tokens['--color-border-tertiary']).toBe('color-mix(in srgb, #181c19 15%, transparent)')
  })

  /**
   * ★ 深浅两套必须给出不同的卡片面:浅色里卡片比底**亮**(白),深色里也比底亮
   * (但远不是白)。写成同一个值的话,深色主题下 widget 会变成一块刺眼的白板,
   * 而浅色下会糊在背景里 —— 两种都只在一种外观下能看出来。
   */
  it('深浅两套的卡片面不同,且都不是同一个极端值', () => {
    const light = widgetTokens('light', LIGHT)
    const dark = widgetTokens('dark', DARK)
    expect(light['--color-background-primary']).not.toBe(dark['--color-background-primary'])
    expect(dark['--color-background-primary']).not.toBe('#ffffff')
  })

  /** 取不到就退到兜底:变量名写错时不该给 iframe 灌一堆空值。 */
  it('缺变量时用兜底值,不产出空串', () => {
    const tokens = widgetTokens('dark', {})
    for (const [name, value] of Object.entries(tokens)) {
      expect(value, name).not.toBe('')
      expect(value, name).not.toContain('undefined')
    }
  })

  /**
   * ★ 600 / 700 **故意不定义**:规范只允许两个字重,定义了就等于邀请模型用它,
   * 而正文里写着那会让粗细在流式过程中跳一下(先按 400 画、收尾变 600)。
   */
  it('不定义 600 / 700 字重', () => {
    const tokens = widgetTokens('light', LIGHT)
    expect(tokens['--font-weight-medium']).toBe('500')
    expect(Object.keys(tokens)).not.toContain('--font-weight-semibold')
    expect(Object.keys(tokens)).not.toContain('--font-weight-bold')
  })

  it('源变量清单里的名字都带 --,免得和 token 名混起来', () => {
    for (const name of WIDGET_SOURCE_VARS) expect(name.startsWith('--')).toBe(true)
  })
})
