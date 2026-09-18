import type { AgentError } from '../../../shared/agent/error'
import type { ActivityPhase } from '../../../shared/domain/activity'
import type { Translate } from './index'

/**
 * 状态行上那句会动的话 —— 按**此刻在干什么**分组的料。
 *
 * 起因是一次 run 里最没东西可看的那几十秒:一句「正在等待回复…」或「运行中」
 * 从第一秒到第四十秒一个像素都不变,读起来像卡住了,而不像在干活。
 * 轮换一个词不提供任何新信息,但它证明这一帧是刚画出来的;而**按相位分组**
 * 之后它还真多说了一件事 —— 眼下是在翻文件、在跑命令,还是在派帮手。
 *
 * ★ 分组的粒度跟着 `ActivityPhase` 走,不自己另立一套。相位怎么判的见那边。
 *
 * ★ 只当**纯装饰**用:真正的状态在 `data-status` 属性上,读屏念的是那句固定的
 * `chat.status.waitingResponse` / `chat.status.running`(见 StatusLine 里的 sr-only)。
 * 所以这里既不进 Messages 表、也不参与 ZH/EN 键一致性校验 —— 它不是要翻译的文案,
 * 是一串可以随便增删的料。两边不必一一对应,某一相位多几条少几条都行。
 *
 * ★ **每条都要短。** 这句话右边紧跟着 `· ↓1234 · 队列 2` 那串读数,
 * 词一长后面整排就跟着左右抖。中文压在 6 字以内,英文压在 14 字符以内。
 */
type Whimsy = readonly [string, ...string[]]

export const whimsyZh: Record<ActivityPhase, Whimsy> = {
  // 等首字节:纯粹的干等,什么都还没发生
  waiting: [
    '琢磨中…', '盘算中…', '酝酿中…', '推敲中…', '捣鼓中…', '掐指一算…',
    '打草稿…', '打腹稿…', '理思路…', '搭架子…', '翻资料…', '找灵感…',
    '转脑筋…', '绕圈圈…', '踱步中…', '熬汤中…', '咕嘟咕嘟…', '发酵中…',
    '磨刀中…', '憋大招…', '挠头中…', '眉头一皱…', '冥思苦想…', '搜肠刮肚…',
    '脑内开会…', '排列组合…', '掂量掂量…', '让我想想…'
  ],
  // 思考块在流:和干等不同,这时候是**看得见在想**,词跟着往「推演」上靠
  reasoning: [
    '顺着想…', '反着想…', '再想想…', '想深一层…', '推演中…', '权衡中…',
    '找漏洞…', '自我辩论…', '反复横跳…', '钻牛角尖…', '理因果…', '解扣中…'
  ],
  // 正文在流:已经开始写了
  writing: [
    '下笔中…', '码字中…', '打字中…', '组织语言…', '斟酌用词…', '一字一句…',
    '润色中…', '边写边想…', '落笔了…', '收尾中…'
  ],
  read: [
    '读文件…', '翻页中…', '扫读中…', '逐行看…', '一目十行…', '啃文件…',
    '目不转睛…', '翻开一看…', '对照着看…', '划重点…'
  ],
  search: [
    '大海捞针…', '顺藤摸瓜…', '按图索骥…', '翻箱倒柜…', '刨根问底…', '满仓库找…',
    '挨个翻…', '循迹中…', '找找看…', '地毯式搜…'
  ],
  mutate: [
    '动刀中…', '施工中…', '改稿中…', '拧螺丝…', '缝缝补补…', '修修改改…',
    '大兴土木…', '搬砖中…', '落笔改…', '收拾残局…'
  ],
  command: [
    '敲回车…', '开跑了…', '等回显…', '盯着输出…', '噼里啪啦…', '跑一趟…',
    '命令下去…', '等它跑完…', '咔咔咔…', '连敲带跑…'
  ],
  network: [
    '上网中…', '拉数据…', '等响应…', '蹲网页…', '翻网页…', '抓取中…',
    '连出去了…', '等对面…', '排队等网…', '拨号中…'
  ],
  orchestration: [
    '派活中…', '摇人中…', '点将中…', '分头行动…', '叫帮手…', '分工中…',
    '远程指挥…', '盯梢中…', '排兵布阵…', '等回话…'
  ],
  external: [
    '喊外援…', '对接中…', '借力中…', '走外线…', '联络中…', '接上了…',
    '跨界调用…', '递话中…', '搭桥中…'
  ],
  // 兜底:知道在跑,但说不出在跑什么(参数还在流、工具还没开跑)
  working: [
    '忙活中…', '开工中…', '动手中…', '撸起袖子…', '跑腿中…', '连轴转…',
    '马不停蹄…', '火力全开…', '开足马力…', '手脚并用…', '埋头苦干…', '一顿操作…',
    '三下五除二…', '哼哧哼哧…', '叮叮当当…', '收拾中…', '折腾中…', '加急处理…'
  ]
}

export const whimsyEn: Record<ActivityPhase, Whimsy> = {
  waiting: [
    'Pondering…', 'Percolating…', 'Noodling…', 'Ruminating…', 'Musing…', 'Brewing…',
    'Simmering…', 'Steeping…', 'Incubating…', 'Cogitating…', 'Puzzling…', 'Mulling…',
    'Marinating…', 'Tinkering…', 'Conjuring…', 'Untangling…', 'Scheming…', 'Plotting…',
    'Whirring…', 'Daydreaming…', 'Doodling…', 'Sketching…', 'Squinting…', 'Wondering…',
    'Weighing…', 'Chewing…', 'Pacing…', 'Humming…'
  ],
  reasoning: [
    'Reasoning…', 'Deducing…', 'Inferring…', 'Unpacking…', 'Backtracking…', 'Rechecking…',
    'Zooming in…', 'Arguing…', 'Doubting…', 'Connecting…'
  ],
  writing: [
    'Writing…', 'Drafting…', 'Typing…', 'Composing…', 'Phrasing…', 'Wording it…',
    'Penning…', 'Polishing…', 'Wrapping up…'
  ],
  read: [
    'Reading…', 'Skimming…', 'Scanning…', 'Perusing…', 'Leafing…', 'Poring over…',
    'Eyeballing…', 'Flipping…', 'Absorbing…'
  ],
  search: [
    'Searching…', 'Hunting…', 'Combing…', 'Rummaging…', 'Digging…', 'Sleuthing…',
    'Sniffing…', 'Trawling…', 'Prowling…'
  ],
  mutate: [
    'Editing…', 'Patching…', 'Rewiring…', 'Stitching…', 'Whittling…', 'Hammering…',
    'Chiseling…', 'Reshaping…', 'Tidying…', 'Retooling…'
  ],
  command: [
    'Running…', 'Executing…', 'Invoking…', 'Crunching…', 'Chugging…', 'Clacking…',
    'Piping…', 'Watching…', 'Churning…', 'Firing away…'
  ],
  network: [
    'Fetching…', 'Browsing…', 'Surfing…', 'Pinging…', 'Loading…', 'Downloading…',
    'Dialing out…', 'Awaiting…', 'Knocking…', 'Reeling…'
  ],
  orchestration: [
    'Delegating…', 'Dispatching…', 'Rallying…', 'Herding…', 'Deputizing…',
    'Marshalling…', 'Checking in…', 'Handing off…', 'Regrouping…'
  ],
  external: [
    'Calling out…', 'Bridging…', 'Relaying…', 'Plugging in…', 'Negotiating…',
    'Patching in…', 'Hailing…', 'Linking up…'
  ],
  working: [
    'Working…', 'Wrangling…', 'Hustling…', 'Cranking…', 'Grinding…', 'Wrenching…',
    'Shuffling…', 'Shoveling…', 'Hauling…', 'Barreling…', 'Bustling…', 'Juggling…',
    'Sprinting…', 'Clattering…', 'Assembling…', 'Splicing…'
  ]
}

export const agentZh = {
  'chat.status.running': '运行中',
  'chat.status.waitingResponse': '正在等待回复…',
  // 只说「正在重试」没用 —— 用户想知道的是为什么:上游繁忙可以等,配置错了等多久都没用
  'chat.status.retrying': '第 {attempt} 次重试：{reason}',
  'chat.status.providerSwitched': '已切换到「{to}」：{reason}',
  'chat.thinkingLevel.auto': '自动',
  'chat.thinkingOn': '开启',
  'models.supportedReasoningEfforts': '支持的思考强度',
  'chat.thinkingUnsupported': '此模型不支持思考设置',
  'chat.thinkingAlways': '此模型始终思考，无法调整或关闭',
  'chat.thinkingAutomatic': '自动 · 模型默认：{level}',
  'chat.thinkingLevel.off': '关闭',
  'chat.thinkingLevel.minimal': '极低',
  'chat.thinkingLevel.low': '低',
  'chat.thinkingLevel.medium': '中',
  'chat.thinkingLevel.high': '高',
  'chat.thinkingLevel.higher': '超高',
  'chat.thinkingLevel.max': '最高',
  'chat.thinkingLevelDescription': '思考强度 · {level}',
  'chat.taskUsage': '任务用量',
  'chat.taskUsageSummary': '输入 {input} · 输出 {output}',
  'chat.taskUsageInput': '输入 {count}',
  'chat.taskUsageOutput': '输出 {count}',
  'chat.taskUsageCacheRead': '缓存命中 {count}',
  'chat.taskUsageCacheCreate': '创建缓存 {count}',
  'chat.taskUsageCacheRate': '缓存命中率 {rate}',
  'chat.taskUsageTps': '平均 TPS {tps} tok/s',
  'chat.taskUsageCost': '花费 {amount}',
  'chat.conversationUsageInput': '会话输入 Token 总数（不含缓存）',
  'chat.conversationUsageCacheRead': '会话缓存读取总数',
  'chat.conversationUsageCacheWrite': '会话缓存写入总数',
  'chat.conversationUsageCacheRate': '会话缓存命中率（缓存读取 ÷ 输入总量）',
  'chat.conversationUsageOutput': '会话输出 Token 总数',
  'chat.conversationUsageLatestTps': '最近一轮平均 TPS',
  'chat.conversationUsageTpsValue': '{tps} tok/s',
  'chat.conversationUsageCost': '会话消耗额度总额',
  'chat.taskChecklist': '任务清单 · {done}/{total} 已完成',
  'chat.taskChecklistRunning': '任务正在执行',
  'chat.contextTooltip': '上下文 {used} / {window}',
  'chat.tool.group.reasoning': '{count} 段思考',
  'chat.tool.group.read': '读取了 {count} 个文件',
  'chat.tool.group.mutate': '修改了 {count} 个文件',
  'chat.tool.group.search': '检索了 {count} 次',
  'chat.tool.group.command': '执行了 {count} 条命令',
  'chat.tool.group.network': '访问了 {count} 个网络资源',
  'chat.tool.group.orchestration': '调度了 {count} 项',
  'chat.tool.group.external': '调用了 {count} 个外部工具',
  'chat.workspace.toolCount': '{count} 个工具',
  'chat.workspace.totalTime': '累计 {duration}',
  'chat.workspace.fileChanges': '{count} 个文件变更',
  'chat.run.elapsed': '用时 {duration}',
  'chat.run.process': '执行过程',
  'chat.turn.copy': '复制回复',
  'chat.turn.copied': '已复制',
  'chat.turn.copyFailed': '复制失败，请重试',
  'chat.turn.regenerate': '重新生成',
  'chat.turn.regenerateConfirm': '丢弃后续对话，再点确认',
  'chat.turn.export': '导出为 Markdown',
  'chat.turn.exported': '已导出',
  'chat.turn.exportFailed': '导出失败，请重试',
  'chat.turn.delete': '删除这一轮',
  'chat.turn.branch': '分支到新会话',
  'chat.turn.branched': '已分支',
  'chat.turn.branchFailed': '分支失败，请重试',
  'agent.interaction.permission': '允许执行 {tool}？',
  'agent.interaction.question': '需要你的回答',
  'agent.interaction.plan': '确认执行方案',
  'agent.interaction.changes': '此操作可能修改文件或执行命令，请确认下面的参数。',
  'agent.interaction.arguments': '工具参数（JSON）',
  'agent.interaction.editArguments': '修改参数后允许',
  'agent.interaction.keepOriginal': '使用原始参数',
  'agent.interaction.answer': '输入你的回答',
  'agent.interaction.feedback': '反馈意见（可选）',
  'agent.interaction.dismiss': '暂不回答',
  'agent.interaction.deny': '拒绝',
  'agent.interaction.allowOnce': '允许这一次',
  'agent.interaction.allowAlways': '以后都允许',
  'agent.interaction.allowAlwaysHint': '选「以后都允许」会把规则 {rule} 写入 .next-cowork/settings.local.json（仅本机生效）。',
  'agent.interaction.submit': '提交回答',
  // 多道题时按钮上带进度:两道题只答了一道时,按钮是灰的,不写清楚缺哪一道
  // 用户只会反复点它
  'agent.interaction.submitProgress': '提交回答（{done}/{total}）',
  'agent.interaction.other': '其它（自行填写）',
  // 多题时主按钮在「下一题」和「提交回答」之间切换 —— 见 `InteractionPanel` 里的注释
  'agent.interaction.nextQuestion': '下一题',
  'agent.interaction.answeredMark': '已答',
  'agent.interaction.multiSelect': '可多选',
  'agent.interaction.approvePlan': '批准方案',
  'agent.interaction.approveAndExecute': '批准并执行',
  'agent.interaction.executeCurrent': '在当前会话执行',
  'agent.interaction.executeNewSession': '新会话执行',
  'agent.interaction.sending': '正在提交…',
  'agent.interaction.failed': '未能提交，交互可能已结束。请检查运行状态后重试。',
  'agent.interaction.loadFailed': '无法读取待处理交互，点击重试。',
  'agent.interaction.invalidJson': '参数不是有效的 JSON，请修改后重试。',
  'agent.interaction.abandonPlan': '放弃计划',
  'agent.interaction.requestRevision': '要求修改',
  'agent.interaction.openPlan': '打开完整计划',
  'agent.interaction.openFullPlan': '在右侧打开完整计划',
  'agent.interaction.planSaveFailed': '无法保存计划修改，请在右侧编辑器中重试。',
  'agent.interaction.planFeedbackRequired': '请说明需要修改的内容。',
  'agent.interaction.planApprovedCurrent': '已批准 · 当前会话执行',
  'agent.interaction.planApprovedNew': '已批准 · 新会话执行',
  'agent.interaction.planRevisionRequested': '已要求修改',
  'agent.interaction.planRejected': '已放弃',
  'agent.interaction.copyPlan': '复制计划原文',
  'agent.interaction.planCopied': '已复制',
  'agent.interaction.copyFailed': '复制失败',
  'agent.interaction.exportPlan': '导出为 .md 文件',
  'agent.interaction.planExported': '已导出',
  'agent.interaction.exportFailed': '导出失败',
  'agent.interaction.requestRevisionRow': '要求修改，告诉它该怎么改…',
  'agent.interaction.sendRevision': '发送修改意见',
  'agent.interaction.cancelRevision': '取消',
  'agent.interaction.editArgumentsRow': '改完参数再允许…',
  'agent.interaction.keyboardHint': '数字键选择 · ↵ 执行',
  'agent.plan.executePrompt': '实施已批准的计划。',
  // {detail} 是解码器给出的具体原因(十几种),不带上的话这些原因在界面上无从区分
  'agent.error.invalidResponse': '上游返回的响应格式不完整或不符合协议，本轮已停止。（{detail}）',
  'agent.error.incompleteResponse': '上游连接在回复完成前断开，请重试。',
  'agent.error.upstreamTimeout': '供应商「{provider}」连续 {seconds} 秒未返回有效响应，请求已超时。已保留收到的内容，请重试或更换模型。',
  'agent.error.outputLimit': '回复达到模型的输出上限，已保留收到的内容。可以继续对话或提高输出上限。',
  'agent.error.imageInput': '无法读取本轮图片附件，请重新添加图片后重试。',
  'attachment.error.empty': '附件「{name}」是空文件，请重新选择。',
  'attachment.error.tooLarge': '附件「{name}」超过 {limit} MiB 上限，请选择更小的文件。',
  'attachment.error.unsupportedImage': '不支持图片格式「{mime}」，请改用 PNG、JPEG、GIF 或 WebP。',
  'attachment.error.invalidImageData': '图片数据无效，请重新添加原始图片文件。',
  'attachment.error.foreignSession': '图片附件不属于当前会话，请在当前会话重新添加。',
  'attachment.error.invalidLocation': '图片附件引用无效，请重新添加图片。',
  'attachment.error.unsafePath': '图片附件的路径超出了当前会话目录，请重新添加图片。',
  'attachment.error.invalidSize': '图片文件为空或超过 {limit} MiB 上限，请重新添加图片。',
  'attachment.error.storageUnavailable': '无法访问本机图片存储目录（{code}），请重启应用后重试。',
  'attachment.error.missing': '图片附件「{name}」已丢失，请重新添加。',
  'attachment.error.unreadable': '无法读取图片附件「{name}」（{code}），请检查文件权限或重新添加。',
  'attachment.error.incompleteRead': '图片附件「{name}」未读取完整或已发生变化，请重新添加。',
  'attachment.error.writeFailed': '无法保存附件「{name}」（{code}），请检查存储空间和文件权限。',
  'attachment.error.readFailed': '无法读取附件「{name}」（{code}），请重新选择文件。',
  'attachment.error.uploadFailed': '添加附件失败，请重新选择文件。',
  'agent.error.cacheUnsupported': '供应商「{provider}」拒绝了 Anthropic 提示缓存（{ttl}）：{detail}。缓存标记为必需，请调整缓存时长或更换兼容供应商。',
  'agent.error.cacheUnsupportedUnnamed': '当前供应商拒绝了 Anthropic 提示缓存（{ttl}）：{detail}。缓存标记为必需，请调整缓存时长或更换兼容供应商。',
  // 三条都点明「不会自动切到其它供应商」：用户的既有心智是「配了多家就会兜底」，
  // 不写这句，他会把「已停用」理解成「连兜底也挂了」，然后去查网络而不是去启用那一家。
  'agent.error.pinnedProviderMissing':
    '你选择的供应商已被删除，「{model}」不会自动切到其它供应商。请在模型菜单里重新选择。',
  'agent.error.pinnedProviderDisabled':
    '供应商「{provider}」已停用，「{model}」不会自动切到其它供应商。请启用它，或另选一个模型。',
  'agent.error.pinnedModelMissing': '供应商「{provider}」下已经没有可用的模型「{model}」，请重新选择。',
}

export const agentEn: Record<keyof typeof agentZh, string> = {
  'chat.status.running': 'Running',
  'chat.status.waitingResponse': 'Waiting for a response…',
  'chat.status.retrying': 'Retry {attempt}: {reason}',
  'chat.status.providerSwitched': 'Switched to "{to}": {reason}',
  'chat.thinkingLevel.auto': 'Auto',
  'chat.thinkingOn': 'On',
  'models.supportedReasoningEfforts': 'Supported reasoning efforts',
  'chat.thinkingUnsupported': 'This model has no thinking controls',
  'chat.thinkingAlways': 'This model always thinks; it cannot be adjusted or disabled',
  'chat.thinkingAutomatic': 'Auto · Model default: {level}',
  'chat.thinkingLevel.off': 'Off',
  'chat.thinkingLevel.minimal': 'Minimal',
  'chat.thinkingLevel.low': 'Low',
  'chat.thinkingLevel.medium': 'Medium',
  'chat.thinkingLevel.high': 'High',
  'chat.thinkingLevel.higher': 'Extra high',
  'chat.thinkingLevel.max': 'Maximum',
  'chat.thinkingLevelDescription': 'Thinking level · {level}',
  'chat.taskUsage': 'Task usage',
  'chat.taskUsageSummary': 'Input {input} · Output {output}',
  'chat.taskUsageInput': 'Input {count}',
  'chat.taskUsageOutput': 'Output {count}',
  'chat.taskUsageCacheRead': 'Cache hit {count}',
  'chat.taskUsageCacheCreate': 'Cache created {count}',
  'chat.taskUsageCacheRate': 'Cache hit rate {rate}',
  'chat.taskUsageTps': 'Avg TPS {tps} tok/s',
  'chat.taskUsageCost': 'Cost {amount}',
  'chat.conversationUsageInput': 'Total uncached conversation input tokens',
  'chat.conversationUsageCacheRead': 'Total conversation cache reads',
  'chat.conversationUsageCacheWrite': 'Total conversation cache writes',
  'chat.conversationUsageCacheRate': 'Conversation cache hit rate (cache reads ÷ total input)',
  'chat.conversationUsageOutput': 'Total conversation output tokens',
  'chat.conversationUsageLatestTps': 'Latest turn average TPS',
  'chat.conversationUsageTpsValue': '{tps} tok/s',
  'chat.conversationUsageCost': 'Total conversation cost',
  'chat.taskChecklist': 'Task checklist · {done}/{total} completed',
  'chat.taskChecklistRunning': 'Task in progress',
  'chat.contextTooltip': 'Context {used} / {window}',
  'chat.tool.group.reasoning': '{count} thinking segments',
  'chat.tool.group.read': '{count} files read',
  'chat.tool.group.mutate': '{count} files changed',
  'chat.tool.group.search': '{count} searches',
  'chat.tool.group.command': '{count} commands run',
  'chat.tool.group.network': '{count} network resources visited',
  'chat.tool.group.orchestration': '{count} tasks orchestrated',
  'chat.tool.group.external': '{count} external tools called',
  'chat.workspace.toolCount': '{count} tools',
  'chat.workspace.totalTime': '{duration} cumulative',
  'chat.workspace.fileChanges': '{count} file changes',
  'chat.run.elapsed': 'Took {duration}',
  'chat.run.process': 'Execution',
  'chat.turn.copy': 'Copy reply',
  'chat.turn.copied': 'Copied',
  'chat.turn.copyFailed': 'Copy failed. Try again',
  'chat.turn.regenerate': 'Regenerate',
  'chat.turn.regenerateConfirm': 'Discards everything after — click again',
  'chat.turn.export': 'Export as Markdown',
  'chat.turn.exported': 'Exported',
  'chat.turn.exportFailed': 'Export failed. Try again',
  'chat.turn.delete': 'Delete this turn',
  'chat.turn.branch': 'Branch to new chat',
  'chat.turn.branched': 'Branched',
  'chat.turn.branchFailed': 'Branch failed. Try again',
  'agent.interaction.permission': 'Allow {tool}?',
  'agent.interaction.question': 'Your answer is needed',
  'agent.interaction.plan': 'Review the plan',
  'agent.interaction.changes': 'This operation may change files or run commands. Review its arguments below.',
  'agent.interaction.arguments': 'Tool arguments (JSON)',
  'agent.interaction.editArguments': 'Edit arguments before allowing',
  'agent.interaction.keepOriginal': 'Use original arguments',
  'agent.interaction.answer': 'Enter your answer',
  'agent.interaction.feedback': 'Feedback (optional)',
  'agent.interaction.dismiss': 'Dismiss',
  'agent.interaction.deny': 'Deny',
  'agent.interaction.allowOnce': 'Allow once',
  'agent.interaction.allowAlways': 'Always allow',
  'agent.interaction.allowAlwaysHint': 'Always allow writes the rule {rule} to .next-cowork/settings.local.json (this machine only).',
  'agent.interaction.submit': 'Submit answer',
  'agent.interaction.submitProgress': 'Submit answers ({done}/{total})',
  'agent.interaction.other': 'Something else (type it)',
  'agent.interaction.nextQuestion': 'Next question',
  'agent.interaction.answeredMark': 'Answered',
  'agent.interaction.multiSelect': 'Choose any',
  'agent.interaction.approvePlan': 'Approve plan',
  'agent.interaction.approveAndExecute': 'Approve and execute',
  'agent.interaction.executeCurrent': 'Execute in this session',
  'agent.interaction.executeNewSession': 'Execute in new session',
  'agent.interaction.sending': 'Submitting…',
  'agent.interaction.failed': 'Unable to submit. This interaction may have ended. Check the run status and retry.',
  'agent.interaction.loadFailed': 'Unable to load pending interactions. Click to retry.',
  'agent.interaction.invalidJson': 'The arguments are not valid JSON. Edit them and retry.',
  'agent.interaction.abandonPlan': 'Abandon plan',
  'agent.interaction.requestRevision': 'Request changes',
  'agent.interaction.openPlan': 'Open the full plan',
  'agent.interaction.openFullPlan': 'Open full plan on the right',
  'agent.interaction.planSaveFailed': 'Unable to save plan changes. Retry in the editor on the right.',
  'agent.interaction.planFeedbackRequired': 'Describe what should change.',
  'agent.interaction.planApprovedCurrent': 'Approved · execute in this session',
  'agent.interaction.planApprovedNew': 'Approved · execute in a new session',
  'agent.interaction.planRevisionRequested': 'Changes requested',
  'agent.interaction.planRejected': 'Abandoned',
  'agent.interaction.copyPlan': 'Copy plan source',
  'agent.interaction.planCopied': 'Copied',
  'agent.interaction.copyFailed': 'Copy failed',
  'agent.interaction.exportPlan': 'Export as .md',
  'agent.interaction.planExported': 'Exported',
  'agent.interaction.exportFailed': 'Export failed',
  'agent.interaction.requestRevisionRow': 'Request changes — tell it what to do differently…',
  'agent.interaction.sendRevision': 'Send changes',
  'agent.interaction.cancelRevision': 'Cancel',
  'agent.interaction.editArgumentsRow': 'Edit the arguments, then allow…',
  'agent.interaction.keyboardHint': 'Number keys to choose · ↵ to run',
  'agent.plan.executePrompt': 'Implement the approved plan.',
  'agent.error.invalidResponse': 'The upstream response was incomplete or did not match the protocol. This run has stopped. ({detail})',
  'agent.error.incompleteResponse': 'The upstream connection closed before the reply finished. Please retry.',
  'agent.error.upstreamTimeout': 'Provider "{provider}" made no response progress for {seconds} seconds. The request timed out and received content has been saved. Retry or choose another model.',
  'agent.error.outputLimit': 'The reply reached the model output limit. Received content has been saved. Continue the conversation or increase the output limit.',
  'agent.error.imageInput': 'Unable to read an image attachment for this request. Attach the image again and retry.',
  'attachment.error.empty': 'Attachment "{name}" is empty. Select the file again.',
  'attachment.error.tooLarge': 'Attachment "{name}" exceeds the {limit} MiB limit. Select a smaller file.',
  'attachment.error.unsupportedImage': 'Image format "{mime}" is not supported. Use PNG, JPEG, GIF, or WebP.',
  'attachment.error.invalidImageData': 'The image data is invalid. Attach the original image file again.',
  'attachment.error.foreignSession': 'The image attachment belongs to a different session. Attach it again in this session.',
  'attachment.error.invalidLocation': 'The image attachment reference is invalid. Attach the image again.',
  'attachment.error.unsafePath': "The image attachment path is outside this session's directory. Attach the image again.",
  'attachment.error.invalidSize': 'The image file is empty or exceeds the {limit} MiB limit. Attach the image again.',
  'attachment.error.storageUnavailable': 'The local image storage directory is unavailable ({code}). Restart the app and retry.',
  'attachment.error.missing': 'Image attachment "{name}" is missing. Attach it again.',
  'attachment.error.unreadable': 'Cannot read image attachment "{name}" ({code}). Check file permissions or attach it again.',
  'attachment.error.incompleteRead': 'Image attachment "{name}" could not be read completely or has changed. Attach it again.',
  'attachment.error.writeFailed': 'Cannot save attachment "{name}" ({code}). Check available storage and file permissions.',
  'attachment.error.readFailed': 'Cannot read attachment "{name}" ({code}). Select the file again.',
  'attachment.error.uploadFailed': 'Could not add the attachment. Select the file again.',
  'agent.error.cacheUnsupported': 'Provider "{provider}" rejected Anthropic prompt caching ({ttl}): {detail}. Cache markers are required. Adjust the cache lifetime or choose a compatible provider.',
  'agent.error.cacheUnsupportedUnnamed': 'The current provider rejected Anthropic prompt caching ({ttl}): {detail}. Cache markers are required. Adjust the cache lifetime or choose a compatible provider.',
  'agent.error.pinnedProviderMissing':
    'The provider you selected has been deleted. “{model}” will not fall back to another provider. Pick a model again from the model menu.',
  'agent.error.pinnedProviderDisabled':
    'Provider “{provider}” is disabled. “{model}” will not fall back to another provider. Enable it, or pick a different model.',
  'agent.error.pinnedModelMissing':
    'Provider “{provider}” no longer offers the model “{model}”. Pick a model again.',
}

export function agentErrorText(error: AgentError, t: Translate): string {
  return error.messageKey === undefined ? error.message : t(error.messageKey, error.messageParams)
}
