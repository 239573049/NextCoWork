/**
 * 扩展面板（技能 / 命令 / 子代理 / 钩子）的文案。
 *
 * 单独一个文件而不是往 `index.tsx` 那三千行里塞 —— 照 `ssh.ts` / `editor.ts` 的先例。
 *
 * ★ `skills.*` 那一整套**不在这里**，它们还在 `index.tsx` 里原样留着：扩展面板只是
 * 把 Skill 管理收进了一个 Tab，那些文案本身一个字没变，搬过来只会制造一次无谓的大 diff。
 */

/**
 * 带参数的文案那一个入参类型。★ 必须显式标出来：这个文件没有 `Messages` 的
 * 上下文（它在 `index.tsx` 里），不标的话参数会被推断成 implicit any，
 * spread 进 `ZH` 时整张表都不再匹配 `Messages`。
 */
type Params = Record<string, string | number>

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
  'ext.comingSoon': '尚未接入',

  // ── 列表与工具条 ──
  'ext.searchPlaceholder': '搜索名字或描述',
  'ext.scopeFilter': '作用域',
  'ext.scope.all': '全部',
  'ext.scope.global': '全局',
  'ext.scope.project': '本工作区',
  'ext.scope.builtin': '内置',
  'ext.toggleLabel': ({ name }: Params) => `启用 ${String(name)}`,
  'ext.new': '新建',
  'ext.newTitle': '新建',
  'ext.create': '创建',
  'ext.namePlaceholder': '名字（字母、数字、连字符）',

  // ── 编辑器 ──
  'ext.save': '保存',
  'ext.delete': '删除',
  'ext.deleteTitle': ({ name }: Params) => `删除 ${String(name)}？`,
  'ext.deleteHint': '文件会从磁盘上删掉，这一步撤不回来。',
  'ext.field.description': '描述',
  'ext.field.descriptionHint': '弹层里那一行副标题；不写就取正文第一行',
  'ext.field.argumentHint': '参数提示',
  'ext.field.agentDescriptionHint': '模型靠它决定派不派活给这个子代理',
  'ext.field.tools': '工具',
  'ext.field.toolsHint': '留空 = 继承全部，例如 Read, Grep',
  'ext.field.model': '模型',
  'ext.field.modelHint': '留空 = 用默认子代理模型',
  'ext.field.permissionMode': '权限档位',
  'ext.field.inherit': '继承',

  // ── 错误与提示 ──
  'ext.error.loadFailed': '读不到列表',
  'ext.error.emptyBody': '正文不能为空 —— 正文就是它的全部内容',
  'ext.error.agentNeedsDescription': '子代理必须填描述，否则加载时整条会被作废',
  'ext.lossyWarning': ({ count }: Params) =>
    `这个文件里有 ${String(count)} 处本应用读不懂的语法（嵌套、块标量等），保存会丢掉它们`,
  'ext.confirmLossy': ({ list }: Params) => `保存会丢掉这些读不懂的内容：\n\n${String(list)}\n\n继续？`,

  // ── 钩子 ──
  'hooks.runNote': '钩子在这台机器上执行；远程工作区则在远端主机上执行',
  'hooks.anyTool': '匹配所有调用',
  'hooks.editTitle': '钩子',
  'hooks.dangerNote': '钩子会在你的机器上执行命令。只写你自己看得懂的那一条。',
  'hooks.field.template': '从模板开始',
  'hooks.template.pick': '（不用模板，自己写）',
  'hooks.template.danger-guard': '拦下危险的 Bash 命令',
  'hooks.template.protect-secrets': '保护 .env 和密钥文件',
  'hooks.template.notify-done': '一轮运行结束时弹系统通知',
  'hooks.template.inject-branch': '每次提问带上当前 git 分支',
  'hooks.template.format-after-write': '写完文件后跑格式化（命令需自己填）',
  'hooks.field.event': '时机',
  'hooks.field.matcher': '匹配（权限规则语法）',
  'hooks.field.matcherHint': '留空 = 每次都触发；例如 Bash 或 Write(src/*.ts)',
  'hooks.field.command': '命令',
  'hooks.field.timeout': '超时（秒）',
  'hooks.event.UserPromptSubmit': '提交提示词之前，可阻断',
  'hooks.event.PreToolUse': '工具调用之前，可阻断',
  'hooks.event.PostToolUse': '工具调用之后，只能追加反馈',
  'hooks.event.Notification': '弹出审批框之前，不等它',
  'hooks.event.Stop': '一轮运行收尾，不等它',
  'hooks.event.SubagentStop': '子代理收尾，不等它',
  'hooks.test': '试运行',
  'hooks.testing': '跑着…',
  'hooks.testNeedsWorkspace': '试运行需要先打开一个工作区',
  'hooks.testResult': ({ outcome, code, ms }: Params) => `结果：${String(outcome)} · 退出码 ${String(code)} · ${String(ms)}ms`,
  'hooks.error.emptyCommand': '命令不能为空',
  'hooks.error.badMatcher': '匹配写法不合法（参照权限规则：Tool 或 Tool(参数)）',
  'hooks.error.badTimeout': '超时必须是正数',
  'hooks.error.timeoutTooLong': '超时最长 600 秒',
  'hooks.warn.weakMatcher':
    '阻断型钩子配前缀匹配（:*）方向是反的：前缀规则带着一条 shell 接续符保护，它是给「放行」设计的，用在拦截上会让 `cmd && 别的` 绕过去。想拦整类调用就写裸工具名。'
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
  'ext.comingSoon': 'Not wired up yet',

  'ext.searchPlaceholder': 'Search name or description',
  'ext.scopeFilter': 'Scope',
  'ext.scope.all': 'All',
  'ext.scope.global': 'Global',
  'ext.scope.project': 'This workspace',
  'ext.scope.builtin': 'Built-in',
  'ext.toggleLabel': ({ name }: Params) => `Enable ${String(name)}`,
  'ext.new': 'New',
  'ext.newTitle': 'New',
  'ext.create': 'Create',
  'ext.namePlaceholder': 'Name (letters, digits, hyphens)',

  'ext.save': 'Save',
  'ext.delete': 'Delete',
  'ext.deleteTitle': ({ name }: Params) => `Delete ${String(name)}?`,
  'ext.deleteHint': 'The file is removed from disk. This cannot be undone.',
  'ext.field.description': 'Description',
  'ext.field.descriptionHint': 'Subtitle in the picker; falls back to the first line of the body',
  'ext.field.argumentHint': 'Argument hint',
  'ext.field.agentDescriptionHint': 'The model uses this to decide whether to dispatch this subagent',
  'ext.field.tools': 'Tools',
  'ext.field.toolsHint': 'Empty = inherit all, e.g. Read, Grep',
  'ext.field.model': 'Model',
  'ext.field.modelHint': 'Empty = use the default subagent model',
  'ext.field.permissionMode': 'Permission mode',
  'ext.field.inherit': 'Inherit',

  'ext.error.loadFailed': 'Could not load the list',
  'ext.error.emptyBody': 'The body cannot be empty — it is the whole content',
  'ext.error.agentNeedsDescription': 'A subagent needs a description, otherwise it is discarded on load',
  'ext.lossyWarning': ({ count }: Params) =>
    `This file has ${String(count)} construct(s) this app cannot parse (nesting, block scalars); saving drops them`,
  'ext.confirmLossy': ({ list }: Params) => `Saving will drop these unparsable parts:\n\n${String(list)}\n\nContinue?`,

  'hooks.runNote': 'Hooks run on this machine; on a remote workspace they run on the remote host',
  'hooks.anyTool': 'Matches every call',
  'hooks.editTitle': 'Hook',
  'hooks.dangerNote': 'Hooks run commands on your machine. Only write one you fully understand.',
  'hooks.field.template': 'Start from a template',
  'hooks.template.pick': '(no template, write my own)',
  'hooks.template.danger-guard': 'Block dangerous Bash commands',
  'hooks.template.protect-secrets': 'Protect .env and key files',
  'hooks.template.notify-done': 'System notification when a run finishes',
  'hooks.template.inject-branch': 'Attach the current git branch to every prompt',
  'hooks.template.format-after-write': 'Format after a write (fill in your own command)',
  'hooks.field.event': 'When',
  'hooks.field.matcher': 'Matcher (permission-rule syntax)',
  'hooks.field.matcherHint': 'Empty = every time; e.g. Bash or Write(src/*.ts)',
  'hooks.field.command': 'Command',
  'hooks.field.timeout': 'Timeout (seconds)',
  'hooks.event.UserPromptSubmit': 'Before the prompt is submitted; can block',
  'hooks.event.PreToolUse': 'Before a tool call; can block',
  'hooks.event.PostToolUse': 'After a tool call; can only append feedback',
  'hooks.event.Notification': 'Before the approval dialog; not awaited',
  'hooks.event.Stop': 'When a run finishes; not awaited',
  'hooks.event.SubagentStop': 'When a subagent finishes; not awaited',
  'hooks.test': 'Test run',
  'hooks.testing': 'Running…',
  'hooks.testNeedsWorkspace': 'A test run needs an open workspace',
  'hooks.testResult': ({ outcome, code, ms }: Params) => `Result: ${String(outcome)} · exit ${String(code)} · ${String(ms)}ms`,
  'hooks.error.emptyCommand': 'Command cannot be empty',
  'hooks.error.badMatcher': 'Invalid matcher (permission-rule syntax: Tool or Tool(specifier))',
  'hooks.error.badTimeout': 'Timeout must be a positive number',
  'hooks.error.timeoutTooLong': 'Timeout caps at 600 seconds',
  'hooks.warn.weakMatcher':
    'A prefix matcher (:*) points the wrong way on a blocking hook: prefix rules carry a shell-continuation guard designed for allowing, so used for blocking it lets `cmd && something` slip past. Use the bare tool name to catch the whole class.'
}
