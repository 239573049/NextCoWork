/**
 * 会话目标（goal）的 UI 文案。
 *
 * ★ **只有用户可见的那一套在这里**。判定器的 system / user、续跑注入、kickoff、
 *   check-in 全部是英文常量，住在 `main/goal/prompt.ts` —— 它们进模型上下文，
 *   措辞是被调过的，翻译它们等于换掉一个判定器。
 *
 * ★ **不进这里的**（领域值，按 AGENTS.md 那条）：判定条件原文、判定器返回的
 *   `reason`、模型名、供应商名。那些是用户/模型产出的内容，不是 UI 文案 ——
 *   翻译它们等于篡改证据。所以下面凡是出现条件或理由的地方，都是以
 *   `{condition}` / `{reason}` 插值进去的**原文**。
 */
type Params = Record<string, string | number>

export const goalZh = {
  'composer.command.goal': '设一个完成条件，模型会一直做到它成立',
  'composer.command.goalClear': '清除当前目标',
  'composer.goal.hint': '条件应能从对话中的证据核验。/goal 查看，/goal clear 提前清除。',
  'goal.pill.detail': ({ condition, iterations, elapsed }: Params) => `${String(condition)} · 已评估 ${String(iterations)} 次 · ${String(elapsed)}`,
  'goal.panel.set': '设立目标',
  'goal.panel.replace': '替换目标',
  'goal.panel.copy': '复制条件',
  'goal.panel.placeholder': '例如：npm test 退出码为 0，且对话中包含运行结果。',
  'goal.panel.deferred': '后台子代理仍在运行，暂缓判定。',
  'goal.panel.checkinsPaused': '已达到三次空闲检查上限；发送下一条消息后恢复。',
  'goal.error.updateFailed': '未能更新目标，请重试。',
  'goal.error.copyFailed': '未能复制条件，请重试。',
  'goal.error.checkinFailed': '未能送达目标检查消息；可手动继续会话。',

  'goal.pill.label': '目标',
  'goal.pill.none': '没有目标',
  'goal.pill.clear': '清除目标',

  'goal.panel.title': '会话目标',
  'goal.panel.condition': '完成条件',
  'goal.panel.iterations': '已评估轮数',
  'goal.panel.lastCheck': '上次判定',
  'goal.panel.noCheckYet': '尚未评估',
  'goal.panel.elapsed': '已用时',
  'goal.panel.tokens': '累计 token',
  'goal.panel.stopEarly': '提前结束',
  'goal.panel.empty': '当前没有目标。用 /goal <完成条件> 设一个，/goal clear 清除。',

  'goal.card.set': '已设立目标',
  'goal.card.met': '目标已达成',
  'goal.card.impossible': '目标被判定为无法达成',
  'goal.card.cleared': '目标已清除',
  'goal.card.pending': '目标尚未达成，继续',
  'goal.card.reason': '判定理由',
  'goal.card.iterations': ({ count }: Params) => `第 ${String(count)} 次评估`,

  'goal.notice.current': ({ condition, iterations, reason }: Params) =>
    `目标：${String(condition)}\n已评估 ${String(iterations)} 轮 · 上次判定：${String(reason)}`,
  'goal.notice.cleared': '目标已清除。',
  'goal.notice.directSet': '这个目标是模型直接设立的。想停下来就用 /goal clear。',

  'goal.warn.idleStreak': ({ streak }: Params) =>
    `连续 ${String(streak)} 轮模型没有调用任何工具，已强制收尾。目标仍然挂着 —— 继续说一句就会接着跑，或者用 /goal clear 清掉它。`,
  'goal.warn.evaluatorFailed': '判定器这一轮没给出结论，本轮按正常收尾处理。详情见扩展 › 钩子里的诊断。',

  'goal.proposal.title': '模型想设一个完成条件',
  'goal.proposal.body': '同意之后，模型会一直做到这个条件成立为止（由一个独立的判定器来核）。',
  'goal.proposal.approve': '设为目标',
  'goal.proposal.decline': '不用',

  'goal.error.tooLong': ({ length }: Params) =>
    `完成条件太长了（${String(length)} 个字符，上限 4000）。它没有被设立 —— 截短之后就不是你写的那个目标了。`,
  'goal.error.empty': '完成条件是空的。它必须是一句判定器只看对话就能核的话。',
  'goal.error.planMode': '计划模式下不能由模型自提目标 —— 先把计划走完。',
  'goal.error.disabled': '模型自提目标已在设置里关闭。',
  'goal.error.busy': '已经有一个目标提议在等你决定了。',

  'settings.goal.evaluatorModel': '目标判定模型',
  'settings.goal.evaluatorModelHint': '留空 = 用这一轮本身的模型。判定器只读对话，不跑命令、不读文件。',
  'settings.goal.modelProposedGoals': '模型自提目标',
  'settings.goal.modelProposedGoals.auto': '自动（用户明说过的结果可直接设立）',
  'settings.goal.modelProposedGoals.alwaysAsk': '每次都问我',
  'settings.goal.modelProposedGoals.disabled': '关闭'
}

export const goalEn = {
  'composer.command.goal': 'Set a completion condition; keep working until it holds',
  'composer.command.goalClear': 'Clear the current goal',
  'composer.goal.hint': 'Use a condition verifiable from transcript evidence. /goal shows it; /goal clear removes it early.',
  'goal.pill.detail': ({ condition, iterations, elapsed }: Params) => `${String(condition)} · ${String(iterations)} evaluations · ${String(elapsed)}`,
  'goal.panel.set': 'Set goal',
  'goal.panel.replace': 'Replace goal',
  'goal.panel.copy': 'Copy condition',
  'goal.panel.placeholder': 'For example: npm test exits 0, with the test output recorded in the conversation.',
  'goal.panel.deferred': 'Background subagents are still running; evaluation is deferred.',
  'goal.panel.checkinsPaused': 'Three idle check-ins reached; send a message to resume them.',
  'goal.error.updateFailed': 'Could not update the goal. Please try again.',
  'goal.error.copyFailed': 'Could not copy the condition. Please try again.',
  'goal.error.checkinFailed': 'The goal check-in could not be delivered. You can continue the session manually.',

  'goal.pill.label': 'Goal',
  'goal.pill.none': 'No goal',
  'goal.pill.clear': 'Clear goal',

  'goal.panel.title': 'Session goal',
  'goal.panel.condition': 'Completion condition',
  'goal.panel.iterations': 'Evaluations',
  'goal.panel.lastCheck': 'Last verdict',
  'goal.panel.noCheckYet': 'Not evaluated yet',
  'goal.panel.elapsed': 'Elapsed',
  'goal.panel.tokens': 'Tokens',
  'goal.panel.stopEarly': 'Stop early',
  'goal.panel.empty': 'No goal set. Use /goal <condition> to set one, /goal clear to remove it.',

  'goal.card.set': 'Goal set',
  'goal.card.met': 'Goal met',
  'goal.card.impossible': 'Goal judged unachievable',
  'goal.card.cleared': 'Goal cleared',
  'goal.card.pending': 'Goal not met yet; continuing',
  'goal.card.reason': 'Verdict',
  'goal.card.iterations': ({ count }: Params) => `Evaluation ${String(count)}`,

  'goal.notice.current': ({ condition, iterations, reason }: Params) =>
    `Goal: ${String(condition)}\n${String(iterations)} evaluation(s) · last verdict: ${String(reason)}`,
  'goal.notice.cleared': 'Goal cleared.',
  'goal.notice.directSet': 'The model set this goal directly. Use /goal clear to stop it.',

  'goal.warn.idleStreak': ({ streak }: Params) =>
    `Stopped after ${String(streak)} turns in which the model requested no tools. The goal is still active — send a message to keep going, or clear it with /goal clear.`,
  'goal.warn.evaluatorFailed': 'The evaluator returned no verdict this turn, so the run finished normally. See the diagnostics under Extensions › Hooks.',

  'goal.proposal.title': 'The model wants to set a completion condition',
  'goal.proposal.body': 'If you approve, it keeps working until this condition holds, as judged by a separate evaluator.',
  'goal.proposal.approve': 'Set as goal',
  'goal.proposal.decline': 'No thanks',

  'goal.error.tooLong': ({ length }: Params) =>
    `The condition is too long (${String(length)} characters, 4000 max). Nothing was set — a truncated condition is not the goal you wrote.`,
  'goal.error.empty': 'The condition is empty. It has to be something an evaluator can check from the conversation alone.',
  'goal.error.planMode': 'The model cannot propose a goal in plan mode — finish the plan first.',
  'goal.error.disabled': 'Model-proposed goals are turned off in settings.',
  'goal.error.busy': 'A goal proposal is already awaiting your decision.',

  'settings.goal.evaluatorModel': 'Goal evaluator model',
  'settings.goal.evaluatorModelHint': "Empty = use the run's own model. The evaluator only reads the conversation; it cannot run commands or read files.",
  'settings.goal.modelProposedGoals': 'Model-proposed goals',
  'settings.goal.modelProposedGoals.auto': 'Auto (set directly when the user asked for it in so many words)',
  'settings.goal.modelProposedGoals.alwaysAsk': 'Always ask me',
  'settings.goal.modelProposedGoals.disabled': 'Off'
}
