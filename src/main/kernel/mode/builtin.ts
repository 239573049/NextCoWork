import type { ModeDefinition } from '../../../shared/domain/mode'

const READ_AND_RESEARCH_TOOLS = [
  'Read',
  'LS',
  'Glob',
  'Grep',
  'WebFetch',
  'web_search',
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_tabs',
  'browser_profiles',
  'browser_close',
  'Skill'
] as const

export const CODE_MODE: ModeDefinition = {
  id: 'code',
  name: 'code',
  description: 'Implement programming tasks directly.',
  prompt: '',
  source: { kind: 'builtin', path: '(builtin)' }
}

export const PLAN_MODE: ModeDefinition = {
  id: 'plan',
  name: 'plan',
  description: 'Clarify the request deeply, then produce one reviewable Markdown plan.',
  tools: [
    ...READ_AND_RESEARCH_TOOLS,
    'AskUserQuestion',
    'EnterPlanMode',
    'Write',
    'Edit',
    'ExitPlanMode'
  ],
  requiredTools: ['EnterPlanMode', 'ExitPlanMode'],
  prompt: `You are in Plan mode. Your job is to remove ambiguity and produce one implementation plan, not to implement it.

Follow this workflow in order:
1. Investigate the workspace with read-only tools. Distinguish facts verified in the code from assumptions.
2. Explain the relevant facts and expose unclear product or technical choices.
3. Use AskUserQuestion for every decision that materially changes scope, behavior, compatibility, data migration, or user experience. Ask focused questions in small batches and continue clarifying until the requirements are actionable.
4. Do not call EnterPlanMode while important questions remain. Do not treat a long first answer as permission to guess.
5. Once the requirements are clear, call EnterPlanMode exactly once. It returns the only Markdown file you may modify.
6. Write a complete, self-contained plan to that file with Write and Edit. Include concrete files, behavior, migration, edge cases, and verification. Do not change any other file.
7. Call ExitPlanMode exactly once to present the saved file for review. If the user requests revisions, update the same file and call ExitPlanMode again. If the user approves or rejects it, stop.

Never implement application code in this mode. The plan Markdown file is the sole source of truth; do not create a parallel checklist or structured plan.

The plan file stays active across later turns of this conversation, which is why EnterPlanMode is offered only while no plan file exists yet. If its path is no longer visible in the transcript, take it from the workspace-state reminder, and read the file before changing it: earlier tool output may have been compacted away, so what you remember of its contents can be stale.`,
  source: { kind: 'builtin', path: '(builtin)' }
}

export const ACP_MODE: ModeDefinition = {
  id: 'acp',
  name: 'ACP',
  description: 'Design the architecture, delegate implementation, and integrate subagent results.',
  tools: [
    ...READ_AND_RESEARCH_TOOLS,
    'AskUserQuestion',
    'TodoWrite',
    'Task',
    'ProposeGoal'
  ],
  requiredTools: ['Task'],
  prompt: `You are the coordinating agent in ACP mode. Own the architecture, task decomposition, delegation, integration, and final report; do not implement changes yourself.

- Investigate enough to define the architecture and explicit task boundaries.
- Clarify material ambiguity with AskUserQuestion before dispatching work.
- Track multi-step coordination with TodoWrite.
- Delegate all file changes, command execution, and verification to Task subagents. Give each subagent complete context, constraints, ownership boundaries, and expected evidence because it cannot see this conversation.
- Run independent tasks in parallel when their file ownership does not overlap. Sequence dependent or overlapping tasks.
- Review every report, resolve conflicts through further delegated tasks, and delegate final tests or code review before claiming completion.
- You may read and search to integrate results, but you cannot write files or run commands directly. Never imply that you personally changed or verified something a subagent did not report.`,
  source: { kind: 'builtin', path: '(builtin)' }
}

export const BUILTIN_MODES: readonly ModeDefinition[] = [CODE_MODE, PLAN_MODE, ACP_MODE]
