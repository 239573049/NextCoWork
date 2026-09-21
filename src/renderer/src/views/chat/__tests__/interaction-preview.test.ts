import { describe, expect, it } from 'vitest'
import { previewOf, previewQuestions } from '../interaction-preview'

/**
 * 这一组钉的是「模型写到一半」那几帧 —— 它们在界面上一闪而过,
 * 靠手点复现不了,而错了的表现全都是「不报错的怪样子」:
 * 空白题面、凭空多出来的选项、或者一个永远空着的详情区。
 */
describe('AskUserQuestion · 流式题面投影', () => {
  it('半截入参里已经成形的题照样能读,缺的字段不猜内容', () => {
    const half = { questions: [{ header: '范围', question: '改哪里' }] }
    expect(previewQuestions(half)).toEqual([
      // 两个布尔按内核 schema 的默认值补,补完与最终待决项一致
      { header: '范围', question: '改哪里', options: [], multiSelect: false, allowFreeform: true }
    ])
  })

  it('★ 刚开一个花括号的题不画 —— 空题面看着像渲染坏了', () => {
    expect(previewQuestions({ questions: [{}, { header: '' }] })).toEqual([])
    // 只要有一个字就收:这正是「实时看见模型在问什么」要的效果
    expect(previewQuestions({ questions: [{ header: '范' }] })).toHaveLength(1)
  })

  it('没有 label 的选项丢掉,description 缺省时不留空字段', () => {
    const [question] = previewQuestions({
      questions: [{ header: 'h', question: 'q', options: [{ label: 'A', description: '甲' }, { label: '' }, {}, 'x'] }]
    })
    expect(question?.options).toEqual([{ label: 'A', description: '甲' }])
  })

  it('布尔字段到了就按它,没到才用默认', () => {
    const [question] = previewQuestions({
      questions: [{ header: 'h', question: 'q', multiSelect: true, allowFreeform: false }]
    })
    expect(question?.multiSelect).toBe(true)
    expect(question?.allowFreeform).toBe(false)
  })

  it('入参还是一串无法解析的 JSON 前缀时,一道题都不画', () => {
    expect(previewQuestions('{"questions":[{"hea')).toEqual([])
    expect(previewQuestions(undefined)).toEqual([])
    expect(previewQuestions({ questions: 'soon' })).toEqual([])
  })
})

describe('previewOf · 哪些工具有可预览的入参', () => {
  it('AskUserQuestion 有题才给预览', () => {
    expect(previewOf('AskUserQuestion', { questions: [] })).toBeNull()
    expect(previewOf('AskUserQuestion', { questions: [{ header: 'h', question: 'q' }] })).toEqual({
      kind: 'ask',
      questions: [{ header: 'h', question: 'q', options: [], multiSelect: false, allowFreeform: true }]
    })
  })

  it('ProposeGoal 给条件原文,ask_user 缺省按 true', () => {
    expect(previewOf('ProposeGoal', { condition: 'npm test 退出码 0' })).toEqual({
      kind: 'goal',
      condition: 'npm test 退出码 0',
      askUser: true
    })
    expect(previewOf('ProposeGoal', { condition: 'x', ask_user: false })).toMatchObject({ askUser: false })
    expect(previewOf('ProposeGoal', {})).toBeNull()
  })

  it('★ ExitPlanMode 没有可预览的入参(schema 是空对象,计划正文在文件里)', () => {
    expect(previewOf('ExitPlanMode', {})).toBeNull()
  })

  it('认不出的工具一律 null —— 调用方据此不画,也不自动展开', () => {
    expect(previewOf('Read', { file_path: 'a.ts' })).toBeNull()
    expect(previewOf('', {})).toBeNull()
  })
})
