import { describe, expect, it } from 'vitest'
import {
  GOAL_CONDITION_MAX,
  isGoalClearWord,
  normalizeGoalCondition,
  parseGoalCommand,
  parseGoalVerdict
} from '../goal'

describe('normalizeGoalCondition', () => {
  it('去掉首尾空白', () => {
    expect(normalizeGoalCondition('  让测试全绿  ')).toBe('让测试全绿')
  })

  it('★ 零宽与控制字符要剥掉 —— 否则「看起来写了东西」的空条件会被设立', () => {
    expect(normalizeGoalCondition('\u200b\u200b  \ufeff')).toBe('')
    expect(normalizeGoalCondition('\u0000\u001f')).toBe('')
  })

  it('条件正文里的普通空格不动', () => {
    expect(normalizeGoalCondition('bun test 退出码为 0')).toBe('bun test 退出码为 0')
  })
})

describe('清除词', () => {
  it.each(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])('%s 是清除词', (word) => {
    expect(isGoalClearWord(word)).toBe(true)
  })

  it('大小写不敏感，首尾空白不影响', () => {
    expect(isGoalClearWord('  CLEAR ')).toBe(true)
  })

  it('不是整条参数就不算 —— 「stop the server」是一个条件', () => {
    expect(isGoalClearWord('stop the server')).toBe(false)
  })
})

describe('parseGoalCommand', () => {
  it('空参数 = 打开面板', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'show' })
    expect(parseGoalCommand('   ')).toEqual({ kind: 'show' })
  })

  it('清除词 = 清除', () => {
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' })
  })

  it('普通参数 = 设立（已规范化）', () => {
    expect(parseGoalCommand('  让 bun test 全绿 ')).toEqual({ kind: 'set', condition: '让 bun test 全绿' })
  })

  it('★ 超长拒绝并给出实际长度 —— 不截断，截断后的条件用户没同意过', () => {
    const long = 'x'.repeat(GOAL_CONDITION_MAX + 5)
    expect(parseGoalCommand(long)).toEqual({
      kind: 'invalid',
      reason: 'too_long',
      length: GOAL_CONDITION_MAX + 5
    })
  })

  it('恰好等于上限时放行', () => {
    expect(parseGoalCommand('x'.repeat(GOAL_CONDITION_MAX)).kind).toBe('set')
  })
})

describe('parseGoalVerdict', () => {
  it('ok:true → met', () => {
    expect(parseGoalVerdict('{"ok":true,"reason":"tests pass"}')).toEqual({ kind: 'met', reason: 'tests pass' })
  })

  it('ok:false → not_met', () => {
    expect(parseGoalVerdict('{"ok":false,"reason":"still red"}')).toEqual({ kind: 'not_met', reason: 'still red' })
  })

  it('ok:false + impossible → impossible', () => {
    expect(parseGoalVerdict('{"ok":false,"impossible":true,"reason":"no such file"}'))
      .toEqual({ kind: 'impossible', reason: 'no such file' })
  })

  it('剥 ```json 围栏', () => {
    expect(parseGoalVerdict('```json\n{"ok":true,"reason":"done"}\n```').kind).toBe('met')
  })

  it('前后带解释文字时取第一个 { 到最后一个 }', () => {
    expect(parseGoalVerdict('Sure! {"ok":false,"reason":"nope"} hope that helps').kind).toBe('not_met')
  })

  it('缺 reason 时补空串，不算解析失败', () => {
    expect(parseGoalVerdict('{"ok":true}')).toEqual({ kind: 'met', reason: '' })
  })

  it('★ 垃圾输出是 skipped 不是 not_met —— 工具的故障不该算在用户的目标头上', () => {
    expect(parseGoalVerdict('I think so?')).toEqual({ kind: 'skipped', reason: 'error' })
    expect(parseGoalVerdict('')).toEqual({ kind: 'skipped', reason: 'error' })
    expect(parseGoalVerdict('{"ok":"yes"}')).toEqual({ kind: 'skipped', reason: 'error' })
    expect(parseGoalVerdict('{}')).toEqual({ kind: 'skipped', reason: 'error' })
  })

  it('★ 一个 JSON 数组也算读不懂 —— 契约是对象', () => {
    expect(parseGoalVerdict('[true]')).toEqual({ kind: 'skipped', reason: 'error' })
  })
})
