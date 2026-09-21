import type { AskUserOption, AskUserQuestion } from '../../../../shared/agent/interaction'

/**
 * 「等用户表态」那几个工具在**参数还在流**的时候能拿出来给人读的那一半。
 *
 * 需求:题面要在模型写参数的过程中就可见,而不是等工具开跑、待决面板出现才第一次露面 ——
 * 一道带四个选项的问题从第一个 token 到可作答之间往往隔着好几秒,那几秒里
 * 工具卡片上只有一行工具名,用户不知道自己马上要被问什么。
 *
 * ★ **这里产出的东西一律不可作答。** 可作答的题面只有一个来源:主进程
 * `InteractionGate` 的待决表(`InteractionPanel` 读它)。这边的值是从半截 JSON
 * 投影出来的,连 `interaction.id` 都不存在 —— 拿它渲染出的控件必须全部 disabled,
 * 否则用户会对着一道还没成立的题点下去,而那一下无处可交。
 *
 * ★ **拿不准就不画。** 字段没到、类型不对一律跳过,绝不猜内容。唯一补默认值的是
 * `multiSelect` / `allowFreeform` 两个布尔:它们缺省时内核那边
 * (`kernel/tool/builtin/interaction.ts` 的 zod `.default`)补的也正是 false / true,
 * 所以补齐后的题面与最终待决项一致 —— 不会出现「模型写完之后选项列表又变了一次」。
 *
 * ★ **纯函数,不碰 React。** 这里的分支只在「模型正写到一半」那几帧成立,
 * 留在组件里就只能靠盯屏幕验(AGENTS.md §9)。
 */

/** 一次表态在界面上能提前展示的内容。`null` = 这个工具没有可预览的入参。 */
export type InteractionPreview =
  | { kind: 'ask'; questions: AskUserQuestion[] }
  | { kind: 'goal'; condition: string; askUser: boolean }

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

function str(input: unknown, key: string): string {
  const value = field(input, key)
  return typeof value === 'string' ? value : ''
}

/** 布尔字段。**缺省值与内核 schema 的 `.default` 一致** —— 见文件头第二条 ★。 */
function bool(input: unknown, key: string, fallback: boolean): boolean {
  const value = field(input, key)
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 选项列表。没有 `label` 的条目直接丢:它在界面上是一行空白,
 * 而用户看不出那是「模型还没写完」还是「模型给了个空选项」。
 */
function previewOptions(raw: unknown): AskUserOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskUserOption[] = []
  for (const item of raw) {
    const label = str(item, 'label')
    if (label === '') continue
    const description = str(item, 'description')
    options.push({ label, ...(description === '' ? {} : { description }) })
  }
  return options
}

/**
 * 半截入参里**已经成形**的那几道题。
 *
 * 题面随流增长:数组会一道一道变长,每道题的 `options` 也会一项一项变长。
 * 全都照着当前值渲染即可 —— 这正是「实时看见模型在问什么」要的效果。
 */
export function previewQuestions(input: unknown): AskUserQuestion[] {
  const raw = field(input, 'questions')
  if (!Array.isArray(raw)) return []
  const questions: AskUserQuestion[] = []
  for (const item of raw) {
    const header = str(item, 'header')
    const question = str(item, 'question')
    // 对象刚开一个花括号时两个字段都还是空串。收下它画出来是一块空白,
    // 看着像渲染坏了 —— 等至少有一个字再说。
    if (header === '' && question === '') continue
    questions.push({
      header,
      question,
      options: previewOptions(field(item, 'options')),
      multiSelect: bool(item, 'multiSelect', false),
      allowFreeform: bool(item, 'allowFreeform', true)
    })
  }
  return questions
}

/**
 * 工具 → 预览投影。
 *
 * ★ 表里**没有 `ExitPlanMode`**,不是漏了:它的 schema 是空对象,计划正文在文件里、
 * 工具开跑之后才读,所以它在参数阶段一个字都拿不出来。让它落 `null`,
 * 卡片就不会自动展开一个永远空着的详情区(见 `parts.tsx` 的展开规则)。
 */
const PREVIEWS: Record<string, (input: unknown) => InteractionPreview | null> = {
  AskUserQuestion: (input) => {
    const questions = previewQuestions(input)
    return questions.length === 0 ? null : { kind: 'ask', questions }
  },
  ProposeGoal: (input) => {
    const condition = str(input, 'condition')
    return condition === ''
      ? null
      : { kind: 'goal', condition, askUser: bool(input, 'ask_user', true) }
  }
}

/** 查表。认不出的工具、还没长出内容的入参都返回 `null` —— 调用方据此不画。 */
export function previewOf(toolName: string, input: unknown): InteractionPreview | null {
  return PREVIEWS[toolName]?.(input) ?? null
}
