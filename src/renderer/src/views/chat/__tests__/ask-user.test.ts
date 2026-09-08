import { describe, expect, it } from 'vitest'
import type { AskUserQuestion } from '../../../../../shared/agent/interaction'
import {
  choiceOptions, deriveAnswers, initialDraft, isComplete, nextUnanswered, otherValue, shouldAdvance,
  showsInput, toggle
} from '../ask-user'

const q = (over: Partial<AskUserQuestion> = {}): AskUserQuestion => ({
  header: '范围',
  question: '改哪里?',
  options: [{ label: 'A' }, { label: 'B', description: '第二个' }],
  multiSelect: false,
  allowFreeform: true,
  ...over
})

describe('AskUserQuestion · 三种题型的作答推导', () => {
  it('单选题只出一个答案,多选题按题面顺序出多个', () => {
    const single = q({ allowFreeform: false })
    const multi = q({ multiSelect: true, allowFreeform: false })
    expect(deriveAnswers([single], { picked: [['B']], typed: [''] })).toEqual([['B']])
    // 先点 B 再点 A,答案仍是 A、B —— 模型拿到的顺序和它自己给的选项顺序一致
    const values = toggle(choiceOptions(multi, '其它'), toggle(choiceOptions(multi, '其它'), [], 'B'), 'A')
    expect(deriveAnswers([multi], { picked: [values], typed: [''] })).toEqual([['A', 'B']])
  })

  it('纯问答题(没有选项)直接把输入框的内容当答案,并去掉首尾空白', () => {
    const free = q({ options: [] })
    expect(showsInput(free, [])).toBe(true)
    expect(deriveAnswers([free], { picked: [[]], typed: ['  写点什么  '] })).toEqual([['写点什么']])
  })

  it('★ 哨兵值不会漏进答案里', () => {
    // 漏出去的话模型会把 `__nextcowork_other__` 当成用户的真实选择照着做
    const question = q()
    const other = otherValue(question)
    const answers = deriveAnswers([question], { picked: [[other]], typed: ['自己写的'] })
    expect(answers).toEqual([['自己写的']])
    expect(JSON.stringify(answers)).not.toContain('nextcowork')
  })

  it('★ 哨兵要躲开同名的真实选项', () => {
    const question = q({ options: [{ label: '__nextcowork_other__' }] })
    expect(otherValue(question)).not.toBe('__nextcowork_other__')
    // 选中那个「正经的」同名选项,答案就该是它本身
    expect(deriveAnswers([question], { picked: [['__nextcowork_other__']], typed: [''] }))
      .toEqual([['__nextcowork_other__']])
  })

  it('选了「其它」但没写字 = 还没作答,提交按钮摁住', () => {
    const question = q()
    const other = otherValue(question)
    expect(showsInput(question, [other])).toBe(true)
    expect(isComplete(deriveAnswers([question], { picked: [[other]], typed: ['   '] }))).toBe(false)
    expect(isComplete(deriveAnswers([question], { picked: [[other]], typed: ['x'] }))).toBe(true)
  })

  it('多道题必须全部作答才算完整,且答案与题面一一对齐', () => {
    const questions = [q({ header: '一' }), q({ header: '二', options: [] })]
    const draft = initialDraft(questions)
    expect(draft.picked).toHaveLength(2)
    expect(isComplete(deriveAnswers(questions, { picked: [['A'], []], typed: ['', ''] }))).toBe(false)
    expect(deriveAnswers(questions, { picked: [['A'], []], typed: ['', '第二问的回答'] }))
      .toEqual([['A'], ['第二问的回答']])
  })

  it('不允许自由作答时不给「其它」这个选项', () => {
    expect(choiceOptions(q({ allowFreeform: false }), '其它').map((o) => o.label)).toEqual(['A', 'B'])
    expect(choiceOptions(q(), '其它').map((o) => o.label)).toEqual(['A', 'B', '其它'])
    expect(choiceOptions(q(), '其它')[1]?.description).toBe('第二个')
  })
})

describe('AskUserQuestion · 多题之间的走位', () => {
  it('从当前题往后找下一道没答的,到末尾会绕回开头', () => {
    // 用户跳着答:先答了第三题,「下一题」得把他带回前面漏掉的那道
    expect(nextUnanswered([[], [], ['C']], 2)).toBe(0)
    expect(nextUnanswered([['A'], [], []], 0)).toBe(1)
    expect(nextUnanswered([['A'], [], []], 1)).toBe(2)
  })

  it('全答完返回 null —— 主按钮据此从「下一题」变回「提交回答」', () => {
    expect(nextUnanswered([['A'], ['B']], 0)).toBeNull()
    expect(nextUnanswered([['A']], 0)).toBeNull()
  })

  it('★ 只有单选题选中真实选项才自动跳走', () => {
    const single = q()
    const multi = q({ multiSelect: true })
    expect(shouldAdvance(single, ['A'])).toBe(true)
    // 多选还要接着勾,跳走等于替用户提前收工
    expect(shouldAdvance(multi, ['A'])).toBe(false)
    // 选了「其它」:输入框刚冒出来,人还没写字
    expect(shouldAdvance(single, [otherValue(single)])).toBe(false)
    expect(shouldAdvance(single, [])).toBe(false)
  })
})
