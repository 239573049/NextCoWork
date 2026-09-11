/**
 * 扩展面板（技能 / 命令 / 子代理 / 钩子）的文案。
 *
 * 单独一个文件而不是往 `index.tsx` 那三千行里塞 —— 照 `ssh.ts` / `editor.ts` 的先例。
 *
 * ★ `skills.*` 那一整套**不在这里**，它们还在 `index.tsx` 里原样留着：扩展面板只是
 * 把 Skill 管理收进了一个 Tab，那些文案本身一个字没变，搬过来只会制造一次无谓的大 diff。
 */
export const extensionsZh = {
  'ext.title': '扩展',
  'ext.back': '返回',
  'ext.tab.skills': '技能',
  'ext.tab.commands': '命令',
  'ext.tab.agents': '子代理',
  'ext.tab.hooks': '钩子',
  'ext.commands.empty': '还没有命令',
  'ext.commands.emptyHint': '命令是 .md 文件，放在 <appData>/commands/ 或工作区的 .next-cowork/commands/ 下；在对话框里敲 / 调用',
  'ext.agents.empty': '还没有子代理',
  'ext.agents.emptyHint': '子代理是 .md 文件，放在 <appData>/agents/ 或工作区的 .next-cowork/agents/ 下；模型通过 Task 工具派遣它们',
  'ext.hooks.empty': '还没有钩子',
  'ext.hooks.emptyHint': '钩子会在运行的固定时机执行一条本机命令，比如工具调用前后',
  'ext.comingSoon': '尚未接入'
}

export const extensionsEn = {
  'ext.title': 'Extensions',
  'ext.back': 'Back',
  'ext.tab.skills': 'Skills',
  'ext.tab.commands': 'Commands',
  'ext.tab.agents': 'Subagents',
  'ext.tab.hooks': 'Hooks',
  'ext.commands.empty': 'No commands yet',
  'ext.commands.emptyHint': 'Commands are .md files under <appData>/commands/ or the workspace .next-cowork/commands/; type / in the composer to invoke them',
  'ext.agents.empty': 'No subagents yet',
  'ext.agents.emptyHint': 'Subagents are .md files under <appData>/agents/ or the workspace .next-cowork/agents/; the model dispatches them via the Task tool',
  'ext.hooks.empty': 'No hooks yet',
  'ext.hooks.emptyHint': 'Hooks run a local command at fixed points of a run, such as before and after a tool call',
  'ext.comingSoon': 'Not wired up yet'
}
