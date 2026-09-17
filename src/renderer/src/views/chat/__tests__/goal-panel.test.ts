/**
 * 会话目标的三块界面:输入框上那颗药丸、目标面板、转录里那张状态卡。
 *
 * 纯函数覆盖不了的是这几件:某块 UI **在不在**、转发出去的是**哪一串字符**、
 * 按下去**调的是哪个回调**。而这里最容易悄悄坏掉的一条是**转发的完整性** ——
 * 条件是一句用户写的话,截短或改写之后仍然是一句「像样的条件」,界面上看不出
 * 任何异常,判定器却在对另一个目标打分。所以那条断言用的是 `toBe` 而不是
 * `toContain`。
 *
 * ★ 文案走 i18n、条件与判定理由**原样出现** —— AGENTS.md 里那两条在这里各钉一遍。
 *
 * ★ 这一份要真 jsdom 环境:目标面板里有受控 textarea,理由与
 * `interaction-panel.test.ts` 头上那段完全一样(手搓 JSDOM 会让 react-dom
 * 走 IE 时代的输入兜底,往 textarea 里打字当场 TypeError)。
 *
 * @vitest-environment jsdom
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentPart } from '../../../../../shared/agent/message'
import type { ActiveGoal } from '../../../../../shared/domain/goal'
import { GOAL_CONDITION_MAX } from '../../../../../shared/domain/goal'
import { I18nProvider, type Locale } from '../../../i18n'
import { copyText } from '../../../services/app'
import { GoalPanel, GoalPill } from '../GoalPanel'
import { GoalStatusCard } from '../GoalStatusCard'

vi.mock('../../../services/app', () => ({
  copyText: vi.fn(async () => {})
}))

/** 条件与理由是**领域值**:它们在下面每一条断言里都必须原样出现,不跟着语言变。 */
const CONDITION = '`bun test` 退出码为 0,且转录里有这次运行的输出'
const REASON = '转录里只跑了两条用例,没看到完整输出'

const goal = (overrides: Partial<ActiveGoal> = {}): ActiveGoal => ({
  id: 'goal-1',
  condition: CONDITION,
  origin: 'user',
  iterations: 0,
  setAt: 0,
  tokensAtStart: 0,
  checkinCount: 0,
  ...overrides
})

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.clearAllMocks()
})

async function mount(node: ReactNode, locale: Locale = 'zh-CN'): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(I18nProvider, { initialLocale: locale, children: node })))
  teardown = async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
  return container
}

/** 面板本体。★ 它 portal 到 `document.body`,所以**不能在 container 里找**。 */
const panel = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-testid="goal-panel"]')
  if (el === null) throw new Error('目标面板不在 —— 断言前先确认它渲染了')
  return el
}

/** 弹窗外壳。底部那排按钮不在 `goal-panel` 里面,文案断言要连它一起看。 */
const dialog = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[role="dialog"]')
  if (el === null) throw new Error('弹窗不在')
  return el
}

const field = (): HTMLTextAreaElement => {
  const el = panel().querySelector('textarea')
  if (el === null) throw new Error('条件输入框不在')
  return el
}

const alertText = (): string => panel().querySelector('[role="alert"]')?.textContent ?? ''

const button = (label: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (el === undefined) throw new Error(`找不到按钮:${label}`)
  return el
}

const byLabel = (label: string): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (el === null) throw new Error(`找不到 aria-label 为「${label}」的按钮`)
  return el
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** 往受控 textarea 里写字。必须绕开 React 装在实例上的值追踪器,否则它看不出变化。 */
const type = async (target: HTMLTextAreaElement, text: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('目标面板 · 只在有目标时才长出那几块', () => {
  it('没有目标:空态 + 只有「设立目标」,没有提前结束,也没有可复制的条件', async () => {
    await mount(createElement(GoalPanel, {
      open: true, onClose: vi.fn(), onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }))

    const text = dialog().textContent ?? ''
    expect(text).toContain('会话目标')
    expect(text).toContain('当前没有目标')
    expect(text).toContain('设立目标')
    expect(field().value).toBe('')
    // 「提前结束」和「复制条件」说的都是那个已经存在的目标 —— 没有目标时它们无处可指
    expect(text).not.toContain('提前结束')
    expect(text).not.toContain('复制条件')
  })

  it('有目标:条件原文进输入框,判定理由原样显示,按钮变成「替换目标」', async () => {
    await mount(createElement(GoalPanel, {
      open: true, goal: goal({ lastReason: REASON }), tokens: 12_345,
      onClose: vi.fn(), onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }))

    const body = panel().textContent ?? ''
    const all = dialog().textContent ?? ''
    expect(field().value).toBe(CONDITION)
    // 底部那排按钮不在这个 testid 里,它们属于弹窗外壳
    expect(all).toContain('替换目标')
    expect(all).toContain('提前结束')
    expect(body).toContain('复制条件')
    // 条件与理由是用户/模型产出的内容,不是 UI 文案 —— 翻译它们等于篡改证据
    expect(body).toContain(CONDITION)
    expect(body).toContain(REASON)
    expect(body).not.toContain('当前没有目标')
  })

  it('★ 一次都没评估过时说「尚未评估」,而不是一个看着像结论的 0', async () => {
    await mount(createElement(GoalPanel, {
      open: true, goal: goal({ iterations: 0, lastReason: '' }),
      onClose: vi.fn(), onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }))

    const values = [...panel().querySelectorAll('dd')].map((dd) => dd.textContent)
    expect(values).toHaveLength(4)
    expect(values[0]).toBe('尚未评估')
    // 理由那一格与轮数是两处独立渲染,漏一处就会出现「尚未评估 · 尚未评估」之外的空格
    expect(values[3]).toBe('尚未评估')
  })

  it('评估过之后两格各自显示真实读数', async () => {
    await mount(createElement(GoalPanel, {
      open: true, goal: goal({ iterations: 3, lastReason: REASON }),
      onClose: vi.fn(), onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }))

    const values = [...panel().querySelectorAll('dd')].map((dd) => dd.textContent)
    expect(values[0]).toBe('3')
    expect(values[3]).toBe(REASON)
  })
})

describe('目标面板 · 设立 / 清除 / 复制', () => {
  it('★ 设立时把条件原样转发,一个字都不截断', async () => {
    // ★ 参数要写上类型:`vi.fn(async () => …)` 会被推成零参,`calls[0][0]` 就编不过
    const onSet = vi.fn(async (_condition: string) => undefined)
    const onClose = vi.fn()
    await mount(createElement(GoalPanel, { open: true, onClose, onSet, onClear: vi.fn(async () => undefined) }))

    // 明显长于模型自提目标那条更严的上限(500)—— 截断成 500 的话这里会红
    const long = `${CONDITION}\n${'继续'.repeat(400)}`
    await type(field(), long)
    await click(button('设立目标'))

    expect(onSet).toHaveBeenCalledTimes(1)
    expect(onSet.mock.calls[0]?.[0]).toBe(long)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('★ 超过上限的条件被拒绝,不转发也不擅自截短', async () => {
    const onSet = vi.fn(async () => undefined)
    const onClose = vi.fn()
    await mount(createElement(GoalPanel, { open: true, onClose, onSet, onClear: vi.fn(async () => undefined) }))

    await type(field(), '字'.repeat(GOAL_CONDITION_MAX + 1))
    await click(button('设立目标'))

    expect(onSet).not.toHaveBeenCalled()
    // 弹窗不关:报错就在用户刚打完的那段话旁边,关掉的话他连错在哪儿都看不到
    expect(onClose).not.toHaveBeenCalled()
    expect(alertText()).toContain('完成条件太长了')
  })

  it('★ 只由不可见字符组成的条件同样是空的 —— 判定器收到空条件会永远判未达成', async () => {
    const onSet = vi.fn(async () => undefined)
    await mount(createElement(GoalPanel, {
      open: true, onClose: vi.fn(), onSet, onClear: vi.fn(async () => undefined)
    }))

    await type(field(), '\u200b\u200b\u200b')
    await click(button('设立目标'))

    expect(onSet).not.toHaveBeenCalled()
    expect(alertText()).toContain('完成条件是空的')
  })

  it('回调返回 false 时留在原地并报错,不假装成功', async () => {
    const onSet = vi.fn(async () => false)
    const onClose = vi.fn()
    await mount(createElement(GoalPanel, { open: true, onClose, onSet, onClear: vi.fn(async () => undefined) }))

    await type(field(), CONDITION)
    await click(button('设立目标'))

    expect(onClose).not.toHaveBeenCalled()
    expect(alertText()).toContain('未能更新目标')
  })

  it('★ 「提前结束」走的是清除回调,不是再设一次', async () => {
    const onSet = vi.fn(async () => undefined)
    const onClear = vi.fn(async () => undefined)
    const onClose = vi.fn()
    await mount(createElement(GoalPanel, {
      open: true, goal: goal({ lastReason: REASON }), onClose, onSet, onClear
    }))

    await click(button('提前结束'))

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onSet).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('★ 复制条件走 services 的 copyText,而不是 navigator.clipboard', async () => {
    await mount(createElement(GoalPanel, {
      open: true, goal: goal(), onClose: vi.fn(),
      onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }))

    await click(button('复制条件'))

    expect(copyText).toHaveBeenCalledWith(CONDITION)
  })
})

describe('目标面板 · 两种语言的文案', () => {
  it('en-US:面板自己的文案跟着变,条件原文不变', async () => {
    await mount(createElement(GoalPanel, {
      open: true, goal: goal({ lastReason: REASON }), onClose: vi.fn(),
      onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }), 'en-US')

    const text = dialog().textContent ?? ''
    expect(text).toContain('Session goal')
    expect(text).toContain('Replace goal')
    expect(text).toContain('Stop early')
    expect(text).toContain('Copy condition')
    expect(text).toContain('Not evaluated yet')
    expect(panel().textContent).toContain(CONDITION)
    expect(panel().textContent).toContain(REASON)
  })

  it('en-US:没有目标时是那套空态文案', async () => {
    await mount(createElement(GoalPanel, {
      open: true, onClose: vi.fn(), onSet: vi.fn(async () => undefined), onClear: vi.fn(async () => undefined)
    }), 'en-US')

    const text = dialog().textContent ?? ''
    expect(text).toContain('Session goal')
    expect(text).toContain('Set goal')
    expect(text).toContain('No goal set.')
    expect(text).not.toContain('会话目标')
  })
})

describe('目标药丸', () => {
  const pill = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-testid="goal-pill"]')
    if (el === null) throw new Error('药丸不在')
    return el
  }

  it('没有目标时显示「目标」,且只有一颗键 —— 没东西可清', async () => {
    await mount(createElement(GoalPill, { onOpen: vi.fn(), onClear: vi.fn() }))

    expect(pill().textContent).toBe('目标')
    expect(pill().querySelectorAll('button')).toHaveLength(1)
    byLabel('目标')
    expect(document.querySelector('button[aria-label="清除目标"]')).toBeNull()
  })

  it('★ 有目标时显示条件原文,打开与清除各走各的回调', async () => {
    const onOpen = vi.fn()
    const onClear = vi.fn()
    await mount(createElement(GoalPill, { goal: goal(), onOpen, onClear }))

    expect(pill().textContent).toContain(CONDITION)
    await click(byLabel('目标'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()

    await click(byLabel('清除目标'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('en-US:两颗键的可访问名也跟着换,条件原文不换', async () => {
    await mount(createElement(GoalPill, { goal: goal(), onOpen: vi.fn(), onClear: vi.fn() }), 'en-US')

    byLabel('Goal')
    byLabel('Clear goal')
    expect(pill().textContent).toContain(CONDITION)
    expect(document.querySelector('button[aria-label="清除目标"]')).toBeNull()
  })
})

describe('转录里的目标状态卡', () => {
  type GoalStatus = Extract<ContentPart, { type: 'goal_status' }>

  const status = (overrides: Partial<GoalStatus> = {}): GoalStatus => ({
    type: 'goal_status',
    met: false,
    condition: CONDITION,
    ...overrides
  })

  const card = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector<HTMLElement>('[data-testid="goal-status-card"]')
    if (el === null) throw new Error('状态卡不在')
    return el
  }

  const SHAPES: [string, Partial<GoalStatus>][] = [
    ['目标已达成', { met: true }],
    ['目标被判定为无法达成', { met: false, failed: true }],
    // ★ 已清除压过一切:一条刚被用户亲手清掉的目标不该报「未达成」
    ['目标已清除', { met: false, cleared: true }],
    ['已设立目标', { met: false, set: true }],
    ['目标尚未达成，继续', { met: false }]
  ]

  const SHAPES_EN: [string, Partial<GoalStatus>][] = [
    ['Goal met', { met: true }],
    ['Goal judged unachievable', { met: false, failed: true }],
    ['Goal cleared', { met: false, cleared: true }],
    ['Goal not met yet; continuing', { met: false }]
  ]

  it.each(SHAPES)('%s', async (label, overrides) => {
    const container = await mount(createElement(GoalStatusCard, { part: status(overrides) }))

    expect(card(container).textContent).toContain(label)
    expect(card(container).textContent).toContain(CONDITION)
  })

  it.each(SHAPES_EN)('en-US: %s', async (label, overrides) => {
    const container = await mount(createElement(GoalStatusCard, {
      part: status({ reason: REASON, ...overrides })
    }), 'en-US')

    const text = card(container).textContent ?? ''
    expect(text).toContain(label)
    // 换语言时只有周围那圈字段名变,条件与理由照抄
    expect(text).toContain(CONDITION)
    expect(text).toContain(REASON)
  })

  it('★ 模型直接设立的目标带一行「怎么停下来」的说明', async () => {
    const container = await mount(createElement(GoalStatusCard, {
      part: status({ set: true, origin: 'proposal_direct' })
    }))

    expect(card(container).textContent).toContain('这个目标是模型直接设立的。想停下来就用 /goal clear。')
  })

  it('用户自己设的目标不带那行说明 —— 它不是模型替他做的决定', async () => {
    const container = await mount(createElement(GoalStatusCard, {
      part: status({ set: true, origin: 'user' })
    }))

    expect(card(container).textContent).not.toContain('这个目标是模型直接设立的')
  })

  it('判定理由原样显示,并带上第几轮', async () => {
    const container = await mount(createElement(GoalStatusCard, {
      part: status({ met: false, reason: REASON, iterations: 2 })
    }))

    const text = card(container).textContent ?? ''
    expect(text).toContain('判定理由')
    expect(text).toContain(REASON)
    expect(text).toContain('第 2 次评估')
  })
})
