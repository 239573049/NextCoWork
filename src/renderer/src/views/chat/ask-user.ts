import type { AskUserOption, AskUserQuestion } from '../../../../shared/agent/interaction'

/**
 * `AskUserQuestion` 那张卡的**回答推导**,与 React 无关的那一半。
 *
 * 抽出来是因为这里的规则不止一条(哨兵、单选/多选、纯问答、答完没答完),
 * 而它们全都只在「用户点了几下之后」才显形 —— 留在组件里就只能靠手点来验。
 */

/** 一道题在界面上的作答状态。两份分开存,理由见 `deriveAnswers`。 */
export interface AskUserDraft {
  /** 选中的选项值(单选题也是数组,长度 0 或 1) */
  picked: string[][]
  /** 「其它」输入框里的字,或纯问答题的正文 */
  typed: string[]
}

export function initialDraft(questions: readonly AskUserQuestion[]): AskUserDraft {
  return { picked: questions.map(() => []), typed: questions.map(() => '') }
}

/**
 * ★ 「其它」是**混在选项里的一个哨兵**,不是选项之外的另一个控件。
 *
 * 试过把自由输入框常驻在选项下面:那样单选题会同时存在两个互相矛盾的回答来源
 * (选了 A、又在框里写了 B),提交时只能猜一个,而用户看不出被猜的是哪个。
 * 变成一个选项之后,「选了其它」和「选了 A」落在同一套单选语义里互斥,不用猜。
 *
 * 值本身要躲开真实选项 —— 模型完全可能给出一个正经的、就叫「其它」的选项。
 * 这个躲法和 `ui/Select` 里给空串找替身是同一招。
 */
export function otherValue(question: AskUserQuestion): string {
  let value = '__nextcowork_other__'
  while (question.options.some((option) => option.label === value)) value = `_${value}`
  return value
}

/** 界面上真正要渲染的选项 = 模型给的那些 + (允许自由作答时)一个「其它」。 */
export function choiceOptions(question: AskUserQuestion, otherLabel: string): {
  value: string
  label: string
  description?: string
}[] {
  const fromModel = question.options.map((option: AskUserOption) => ({
    value: option.label,
    label: option.label,
    description: option.description
  }))
  return question.allowFreeform
    ? [...fromModel, { value: otherValue(question), label: otherLabel }]
    : fromModel
}

/** 这道题该不该显示输入框:纯问答题一直显示,有选项的题要等「其它」被选中。 */
export function showsInput(question: AskUserQuestion, picked: readonly string[]): boolean {
  return question.options.length === 0 || picked.includes(otherValue(question))
}

/**
 * 把作答状态折成回给内核的答案:每道题一组字符串,顺序与 `questions` 对齐。
 *
 * ★ 哨兵本身**绝不能出现在答案里** —— 它是界面内部的值,模型读到
 * `__nextcowork_other__` 只会当成一个真答案,然后煞有介事地照着它往下做。
 *
 * 空字符串的「其它」不算作答,所以这里返回空数组:`isComplete` 靠它把提交按钮
 * 摁住,用户就不会在只勾了「其它」却没写字的情况下把一个空答案发出去。
 */
export function deriveAnswers(questions: readonly AskUserQuestion[], draft: AskUserDraft): string[][] {
  return questions.map((question, index) => {
    const free = (draft.typed[index] ?? '').trim()
    if (question.options.length === 0) return free === '' ? [] : [free]
    const other = otherValue(question)
    const chosen = draft.picked[index] ?? []
    return [
      ...chosen.filter((value) => value !== other),
      ...(chosen.includes(other) && free !== '' ? [free] : [])
    ]
  })
}

/** 每道题都得有回答 —— 内核那侧也是这么判的,少一道就整份退回。 */
export function isComplete(answers: readonly string[][]): boolean {
  return answers.every((answer) => answer.length > 0)
}

/** 多选题里勾/取消一项,结果始终按题面顺序排,不按点击先后。 */
export function toggle(options: readonly { value: string }[], values: readonly string[], value: string): string[] {
  const next = values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value]
  return options.filter((option) => next.includes(option.value)).map((option) => option.value)
}

/**
 * 下一道**还没答**的题在哪。全答完了返回 null —— 这时按钮该变成「提交回答」。
 *
 * 从 `from` 的下一道开始往后找,找到末尾再从头绕一圈:用户可能是跳着答的
 * (先点了第三题的选项),这时「下一题」应该带他回到前面漏掉的那道,
 * 而不是停在末尾说不出话。
 */
export function nextUnanswered(answers: readonly string[][], from: number): number | null {
  for (let step = 1; step <= answers.length; step++) {
    const index = (from + step) % answers.length
    if ((answers[index] ?? []).length === 0) return index
  }
  return null
}

/**
 * 选完一项之后该不该自动跳到下一道题。
 *
 * 只在**单选题选中一个真实选项**时跳:多选题还要继续勾,跳走等于替用户提前收工;
 * 选中「其它」更不能跳 —— 输入框刚冒出来,人还没来得及写字。
 */
export function shouldAdvance(question: AskUserQuestion, picked: readonly string[]): boolean {
  return !question.multiSelect && picked.length === 1 && picked[0] !== otherValue(question)
}
