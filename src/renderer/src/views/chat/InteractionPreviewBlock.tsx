import type { ReactNode } from 'react'
import { AskUserPreviewCard, GoalProposalPreviewCard } from './InteractionPanel'
import { previewOf } from './interaction-preview'

/**
 * 工具卡片里那份**只读的表态卡** —— `AskUserQuestion` / `ProposeGoal` 在参数还在流时
 * 就先摆出来的那一张。
 *
 * 需求:让用户在模型写参数的那几秒里就读到自己马上要被问什么,而不是等待决面板
 * 弹出来才第一次看见。
 *
 * ★ **这个文件只分派,不画任何版式。** 卡片本体就是 `InteractionPanel` 里那两张
 * 可作答的卡的只读态(同一个 `CardShell` / `QuestionTabs` / `QuestionBlock`)。
 * 另画一套的代价有两条,都真实发生过:题面从预览换成可作答的那一瞬间会跳一下;
 * 以及两套版式此后各自演化,改一处漏一处。
 * 投影规则(哪些字段算数、缺省怎么补)全在 `./interaction-preview`。
 */
export function InteractionPreviewBlock({ toolName, input, live }: {
  /** 转录里的工具名(externalName)。认不出来就不画。 */
  toolName: string | undefined
  /** 已经投影过的入参:流式中是半截 JSON 解析出的部分对象,跑完是内核严格解析的那份。 */
  input: unknown
  /**
   * 这次调用还没有结果 —— 也就是「题面还在写」或「下面那张卡正等着答」。
   *
   * ★ 跑完之后**不再摆预览**:历史转录里再摆一张写着「可作答的卡片在下方」的卡是假的,
   * 那张卡早就答完没了;那时详情区该给的是结果块里「用户当时选了什么」。
   */
  live: boolean
}): ReactNode {
  const preview = toolName === undefined || !live ? null : previewOf(toolName, input)
  if (preview === null) return null
  return (
    <div data-testid="interaction-preview" data-preview-kind={preview.kind}>
      {preview.kind === 'ask'
        ? <AskUserPreviewCard questions={preview.questions} />
        : <GoalProposalPreviewCard condition={preview.condition} />}
    </div>
  )
}
