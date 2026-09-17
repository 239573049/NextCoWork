/**
 * 目标机制的全部文案常量。
 *
 * ## 为什么这一份是英文，而 UI 那一份全走 i18n
 *
 * 这里的每一条都是**进模型上下文**的：判定器的 system / user、续跑注入、kickoff、
 * check-in。它们的行为是被调过的 —— `"insufficient evidence in transcript"`
 * 这句话在英文 prompt 里的权重，换成中文就是另一个判定器。项目既有做法也一致
 * （`agent-session.ts` 的压缩摘要指令、`BASE_PROMPT` 都是英文）。
 *
 * 用户可见的那一套（药丸、状态行、卡片、通知、错误）**全部**走
 * `renderer/src/i18n/`，一个字都不在这里。
 *
 * ★ 纯常量 + 纯函数，零 IO —— 判定的正确性几乎全在措辞上，所以这一份要能逐行单测。
 */

/**
 * 判定器的 system（`Stop` 专用）。
 *
 * ★ 逐字来自 Claude Code 2.1.259。改动它等于改判定器的行为，不要顺手润色。
 */
export const GOAL_EVALUATOR_SYSTEM = [
  'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.',
  'Your response must be a JSON object with one of these shapes:',
  '- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}',
  '- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}',
  '- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}',
  'Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.',
  'Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant\'s self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".'
].join('\n')

/** 判定器的 user（`Stop` 专用）。转录正文拼在它**前面**。 */
export function goalEvaluatorQuestion(condition: string): string {
  return [
    'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.',
    `Condition: ${condition}`
  ].join('\n')
}

/**
 * 转录被预算裁掉一段时补的那条前缀。
 *
 * ★★ 这不是客套话，它是**判定正确性的一部分**。不写的话，被裁掉的那段历史会让
 *   判定器把「我看不到」读成「没发生过」，于是稳定地误判未达成 —— 而那正好是
 *   一个长会话最容易触发的路径。逐字来自 CC。
 */
export function truncatedTranscriptPrefix(omitted: number): string {
  return `[Earlier conversation truncated to fit the hook evaluator's context window — ${String(omitted)} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`
}

/**
 * 续跑注入的前缀。
 *
 * ★ 它同时是**格式**也是**锚点**：诊断和「这条是我们自己注入的」都按它认。
 *   所以保持英文、并且只在这里出现一次 —— 别处不要硬编码这个字面量。
 */
export const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:'

/** 判未达成时发给主模型的那条 internal 消息。格式与 CC 一致。 */
export function goalContinuationMessage(condition: string, reason: string): string {
  return `${STOP_HOOK_FEEDBACK_PREFIX}\n[${condition}]: ${reason}`
}

/** 目标生效时发给主模型的那条 internal 消息。 */
export function goalKickoffMessage(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run /goal clear after success; that's only for clearing a goal early.`
}

/** check-in 里列出的一个后台任务。`«»` 是 CC 用来包住条件原文的定界符，保留。 */
export interface BackgroundTaskLine {
  taskId: string
  type: string
  description: string
}

/** 空闲唤醒到顶时追加的两句（CC 原文，产品自称已替换）。 */
const IDLE_SUMMARY_SUFFIX = ' · idle check-ins paused until your next message'
const IDLE_BODY_SUFFIX =
  " NextCoWork won't wake this session for another check-in until the user sends a message, so say clearly where things stand."

/**
 * 后台推迟的 check-in 正文。
 *
 * 两种分支照搬 CC：后台还在跑 → 让模型去看它们的进度；后台已经不在了 → 直接继续。
 */
export function goalCheckinMessage(input: {
  condition: string
  deferredMinutes: number
  tasks: readonly BackgroundTaskLine[]
  /** 这是空闲唤醒的最后一次 —— 追加「不再自动唤醒」那两句。 */
  final: boolean
}): string {
  const minutes = String(Math.max(1, Math.round(input.deferredMinutes)))
  if (input.tasks.length > 0) {
    const summary = `Goal check-in: «${input.condition}» is still active, and evaluation has been deferred for ${minutes} min because background work is still running:`
    const list = input.tasks.map((task) => `- ${task.taskId} · ${task.type} · ${task.description}`).join('\n')
    const body =
      'Check on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.'
    return [
      input.final ? `${summary}${IDLE_SUMMARY_SUFFIX}` : summary,
      list,
      '',
      input.final ? `${body}${IDLE_BODY_SUFFIX}` : body
    ].join('\n')
  }
  const summary = `Goal check-in: «${input.condition}» is still active.`
  const body = `Its evaluation was deferred for ${minutes} min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal.`
  return input.final ? `${summary}${IDLE_SUMMARY_SUFFIX}\n${body}${IDLE_BODY_SUFFIX}` : `${summary}\n${body}`
}

/**
 * 转录 → 判定器读的那段纯文本。
 *
 * ★ 只保留判定用得上的四类内容。`thinking` **不进**：它是模型的草稿，
 *   一段「我觉得应该已经好了」会被判定器当成证据，而那恰恰是最不该采信的证据。
 */
export function renderTranscriptLine(role: string, body: string): string {
  return `${role}: ${body}`
}
