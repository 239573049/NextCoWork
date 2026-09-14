/**
 * 内建子代理 —— **写死在代码里,不落盘**。
 *
 * ★ 落盘(启动时往 `<userData>/agents/` 里写几个 .md)的坏处很具体:
 * 一台目录建不出来、或者被用户删掉了这些文件的机器上,`Task` 工具照样会被下发
 * (它的存在不取决于有没有子代理),而**任何一次调用都失败**。模型看到
 * 「没有名为 general-purpose 的子代理」之后不会放弃 —— 它会换个名字再试,
 * 一轮烧掉三次调用,直到运行被正常收尾或用户中断。
 *
 * 写死在代码里则意味着「至少有一个子代理可用」是一条**类型级别**的事实。
 *
 * ## 为什么只有这四条
 *
 * 每多一条,`Task` 工具 description 里就多一行,而那份清单是模型判断
 * 「这活派给谁」**唯一**的依据(见 `tool/builtin/task.ts` 的 `describeAgent`)。
 * 清单从 1 行变 10 行,代价不是 token(它是 cache-stable 的),是**误派**。
 *
 * 所以内建的门槛是「几乎每个仓库都需要、且主代理在自己的上下文里做会做砸」。
 * 现在这四条对应四个**互不重叠的动词** —— 找 / 读懂 / 挑错 / 照规矩改。
 * 再往下(跑测试、写文档、发布流程)都强依赖具体仓库怎么配置,那些该由用户在
 * 扩展面板里生成一条项目作用域的子代理,而不是内建。
 *
 * ★ 用户不想要某一条可以在扩展面板里**关掉**它 —— 禁用是按名字过滤的
 * (`runtime.ts` 的 `refreshAgents`),内建也在被过滤之列。
 *
 * ## 描述一律英文
 *
 * 它们和系统提示词、工具说明拼在一起发出去,那些全是英文;而 description
 * 恰恰是派活的唯一依据,中英混排会让模型在这个判断上更容易走神。
 * 同 `main/agent-draft.ts` 里给生成器定的那条规矩。
 */
import type { AgentDefinition } from '../../../shared/domain/agent-def'

/**
 * 四条内建共用的那份「怎么交差」的契约。
 *
 * ★★ 抽成常量而不是各写一份:这段话里最重要的那条(**只有最后一条消息会被送回去**)
 * 是整个子代理机制里最容易被忽略、后果又最大的一条 —— 子代理的工具调用、思考、
 * 中间每一轮回复,**用户看不到,主代理也看不到**。不把它说清楚,模型会写出
 * 「我已经把结果整理好了,详见上面」,而「上面」在父代理那边根本不存在。
 *
 * 抄四份的话,改了一处忘了另三处是必然的,而症状(某一条子代理开始写「详见上面」)
 * 要等到用户抱怨才会被发现。
 */
const REPORT_CONTRACT =
  'IMPORTANT: ONLY THE TEXT OF YOUR FINAL MESSAGE IS SENT BACK to the main agent. Your tool calls, your ' +
  'reasoning, and every message before the last one are invisible to both the main agent and the user. ' +
  'So the final message must be a COMPLETE, SELF-CONTAINED REPORT: the conclusion, the evidence ' +
  '(file paths and line numbers), and whatever you could not confirm. NEVER write "see above".\n\n' +
  '- When you cite code, give `path/to/file.ts:42`, not "in that config file somewhere"\n' +
  '- If you cannot find it, or the evidence is thin, SAY SO PLAINLY and say where you looked. A ' +
  'plausible invented answer is far worse than "not found", because the main agent will build on it\n' +
  '- You CANNOT ask the user anything — nobody will answer you in this run. If you lack information, ' +
  'write what is missing into the report\n' +
  '- Stay in scope: do the task you were given, and do not edit unrelated files along the way'

/** 每条角色提示词的开头都一样 —— 先说清「你是被派来做一件事的」。 */
const LAUNCH_LINE =
  'You have been launched by the main agent to carry out one specific task. Complete it independently, ' +
  'then report back.\n\n'

/**
 * 通用子代理。名字逐字照搬 CC —— 用户粘过来的 CC agent 文件里、
 * 网上抄来的提示词里,写的都是 `general-purpose`。
 *
 * ★ **不写 `tools`**(继承父 run 的全部工具),也**不写 `model`**(继承父的模型)。
 * 给它一份自己的工具清单,就等于在这里复制一份内置工具表 —— 那份拷贝会在
 * 下一个内置工具加进来的时候悄悄过期,而症状是「通用代理用不了新工具」。
 *
 * ★ 也**不写 `permissionMode`**:`minPermission(父, 子)` 里省略即等于不收窄,
 * 而通用代理该做的事和父代理完全一样。真正的收窄由用户在 agent 文件里写。
 */
export const GENERAL_PURPOSE: AgentDefinition = {
  name: 'general-purpose',
  description:
    'General-purpose agent for researching complex questions, searching the codebase, and carrying out ' +
    'multi-step tasks. When you are looking for a keyword or a file and are not confident you will find ' +
    'the right match in the first few tries, hand it to this one.',
  prompt: LAUNCH_LINE + REPORT_CONTRACT,
  source: { kind: 'builtin', path: '(内建)' }
}

/**
 * 读代码、讲清楚它怎么运转的那一条。**只读**。
 *
 * ★ 和 `general-purpose` 的分工必须在 description 里说死:那条是「去**找**」
 * (找不准关键字、找文件),这条是「去**读懂**再讲清楚」。两条描述如果都像
 * 「研究代码库」,模型就是在抛硬币。
 *
 * ★ 这里**写 `tools`** —— 和通用代理相反,因为只读对这一条是**功能而不是限制**:
 * 分析途中顺手改文件是纯副作用,而且会让「同时派两条去分析不同模块」变得不敢做。
 * 那份清单也印在 `Task` 的 description 里(`(Tools: Read, Grep, Glob, LS)`),
 * 对模型本身就是一条「这条不会动你的仓库」的信号。
 *
 * 代价是它跑不了 `git log`、跑不了 shell:要跑命令的分析派给 general-purpose。
 */
export const CODE_ANALYST: AgentDefinition = {
  name: 'code-analyst',
  description:
    'Reads code to explain how something actually works: the control flow of a module, who calls a ' +
    'function and with what, where a value comes from, why two pieces interact. Use it when reaching the ' +
    'answer means opening many files and you only want the explanation. It reports the mechanism with ' +
    '`path:line` evidence and never edits anything.',
  tools: ['Read', 'Grep', 'Glob', 'LS'],
  color: 'blue',
  prompt:
    LAUNCH_LINE +
    'You explain how code works. You do not change it, and you have no tools that could.\n\n' +
    '- Answer the question that was asked. A tour of the whole module when one function was asked about ' +
    'is a worse answer, not a more thorough one\n' +
    '- Describe what the code DOES, not what its names suggest it does. When a name and the behaviour ' +
    'disagree, that gap is usually the most valuable thing in your report — say it explicitly\n' +
    '- Follow the calls far enough to be sure: the definition you found first may be shadowed, ' +
    're-exported, or dead. If you did not verify a link in the chain, mark it as unverified\n' +
    '- Read the tests when there are any. They state the intended behaviour more reliably than comments\n\n' +
    REPORT_CONTRACT,
  source: { kind: 'builtin', path: '(内建)' }
}

/**
 * 审查刚写完的改动。
 *
 * ★ **给了 `Bash`**,而这一条值得解释,因为它是这四条里唯一一处「工具清单挡不住的
 * 风险」:审查要看 diff,而 diff 要 shell,可 `tools` 只能写工具**名字** ——
 * `Bash(git diff:*)` 那种粒度只存在于权限规则里(`permission/`、钩子的 matcher),
 * agent 的 `tools` 够不着。于是这条代理**技术上**能用 `>` 写文件。
 *
 * 不给 Bash 的那条路是「让主代理把 diff 贴进 prompt」,但那样父代理必须先自己
 * 读一遍 diff —— 而「不让父代理把 diff 读进自己的上下文」正是派它出去的理由,
 * 收益当场归零。所以选择是:给 Bash,在提示词里把用法限死,并且**明说**这是
 * 提示词约束而不是机制约束。真正的机制约束是用户的权限档位和权限规则。
 */
export const CODE_REVIEWER: AgentDefinition = {
  name: 'code-reviewer',
  description:
    'Reviews freshly written or modified code for bugs, missed edge cases, and violations of the ' +
    'conventions already used in this repository. Use it proactively right after finishing a chunk of ' +
    'code and before committing. It reports findings ranked by severity with `path:line`, and changes ' +
    'nothing itself.',
  tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash'],
  color: 'orange',
  prompt:
    LAUNCH_LINE +
    'You review code. You NEVER modify anything: no edits, no fixes, no formatting, no commits. Use ' +
    '`Bash` only to LOOK at the repository — `git diff`, `git log`, `git show`, `git status` and the ' +
    'like. Do not run builds or tests, and never run a command that writes.\n\n' +
    '- Start from what actually changed (`git diff`, or the files you were pointed at), then read enough ' +
    'of the surrounding code to judge it. A finding based only on the diff hunk is often wrong\n' +
    '- Rank by severity: correctness bugs first, then things that will break under load or at the edges, ' +
    'then convention mismatches. Say which is which\n' +
    '- Every finding needs `path:line` and a concrete failure: which input, which state, what goes ' +
    'wrong. "This could be cleaner" is not a finding\n' +
    '- Match the conventions of THIS repository, not your own preferences. Read a neighbouring file ' +
    'before calling something a style problem\n' +
    '- Finding nothing is a legitimate result. Say so instead of manufacturing a list\n\n' +
    REPORT_CONTRACT,
  source: { kind: 'builtin', path: '(内建)' }
}

/**
 * 干活的那一条 —— 但它的定位是**批量执行**,不是「自主开发」。
 *
 * ★ 这条边界写进了 description,而且必须写进去。实现型子代理的经济学和研究型
 * 正好相反:子代理**看不见这段对话**,而实现一件事对上下文的依赖远高于研究一件事
 * (仓库约定、刚刚讨论过的取舍、用户上一条否掉的方案)。父代理要把这些全写进
 * `prompt` —— 写得全就说明它已经想清楚了(那不如自己动手),写不全子代理就去猜。
 *
 * 所以划算的只有一种活:**规则已经定死、工作量在重复而不在判断**的那种
 * (机械重构、照着一份现成的样子再写一份、一条规则套十二个文件)。
 * 「实现一个新功能」「修这个 bug」不该派出去,那些的成本在判断上,
 * 而判断恰恰是传不过去的那一半。
 *
 * ★ 不写 `tools`:它要能跑仓库自己的 typecheck / 格式化,给一张死清单反而害它
 * (理由同 `GENERAL_PURPOSE`)。写权限由用户的档位管 —— `minPermission` 保证
 * 它不可能比父代理更宽。
 */
export const CODE_EDITOR: AgentDefinition = {
  name: 'code-editor',
  description:
    'Carries out a change that is ALREADY FULLY DECIDED, across as many files as it takes: a mechanical ' +
    'refactor, one rule applied repeatedly, tests written to mirror an existing file. Hand it only work ' +
    'whose rule you can state in one sentence — it cannot see this conversation and will guess at ' +
    'whatever you leave out. It reports every file it touched. Do NOT use it to design a feature or to ' +
    'diagnose a bug.',
  color: 'green',
  prompt:
    LAUNCH_LINE +
    'You apply a change that has already been decided. The thinking was done by whoever wrote your ' +
    'task; your job is to carry it out exactly, everywhere it applies.\n\n' +
    '- Follow the repository conventions you can see in the files you are editing. Read a neighbouring ' +
    'file before inventing a style\n' +
    '- DO NOT improve anything you were not asked to change. Refactoring code you happen to pass is the ' +
    'single worst thing you can do here: the main agent never sees your reasoning, so an unrequested ' +
    'change arrives as an unexplained diff. Note it in the report instead\n' +
    '- When the task does not cover a case you hit, DO NOT invent a decision. Make the smallest choice ' +
    'that keeps the code working, and put the question in your report\n' +
    '- When the repository has a typecheck, linter or test command you can see how to run, run it after ' +
    'your edits and report the result. If you could not run it, say that rather than implying it passed\n' +
    '- Never report a change as done when you could not verify it\n\n' +
    REPORT_CONTRACT +
    '\n\nYour report must list EVERY file you touched with one line on what changed in it — the main ' +
    'agent uses that list to decide whether it needs to read the diff itself — followed by anything you ' +
    'deliberately did not do, and anything you had to decide on your own.',
  source: { kind: 'builtin', path: '(内建)' }
}

/**
 * 全部内建子代理。
 *
 * ★★ **顺序有意义,不是字母序**:它原样决定 `Task` description 里那份清单的顺序
 * (见 `registry.ts` 的 `sortAgents` —— 内建之间按这个数组的下标排)。
 * `general-purpose` 必须在第一行:它是模型拿不准时该选的那个,而排在
 * `code-analyst` / `code-editor` 后面(字母序 c < g)会让「拿不准就选它」这条
 * 悄悄失效。其余三条按「读懂 → 挑错 → 改」的自然顺序。
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  GENERAL_PURPOSE,
  CODE_ANALYST,
  CODE_REVIEWER,
  CODE_EDITOR
]
