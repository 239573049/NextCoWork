/**
 * 内建子代理 —— **写死在代码里,不落盘**。
 *
 * ★ 落盘(启动时往 `<userData>/agents/` 里写一个 general-purpose.md)的坏处很具体:
 * 一台目录建不出来、或者被用户删掉了这个文件的机器上,`Task` 工具照样会被下发
 * (它的存在不取决于有没有子代理),而**任何一次调用都失败**。模型看到
 * 「没有名为 general-purpose 的子代理」之后不会放弃 —— 它会换个名字再试,
 * 一轮烧掉三次调用,直到运行被正常收尾或用户中断。
 *
 * 写死在代码里则意味着「至少有一个子代理可用」是一条**类型级别**的事实。
 */
import type { AgentDefinition } from '../../../shared/domain/agent-def'

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
  prompt:
    'You have been launched by the main agent to carry out one specific task. Complete it independently, ' +
    'then report back.\n\n' +
    /*
      ★ 这一条是整个子代理机制里最容易被忽略、后果又最大的一条。

      子代理的中间过程(工具调用、思考、逐轮的回复)**用户看不到,主代理也看不到** ——
      主代理拿到的只有最后一条消息的文字。不把这件事说清楚,模型会写出
      「我已经把结果整理好了,详见上面」这种回复,而「上面」在父代理那边根本不存在。
    */
    'IMPORTANT: ONLY THE TEXT OF YOUR FINAL MESSAGE IS SENT BACK to the main agent. Your tool calls, your ' +
    'reasoning, and every message before the last one are invisible to both the main agent and the user. ' +
    'So the final message must be a COMPLETE, SELF-CONTAINED REPORT: the conclusion, the evidence ' +
    '(file paths and line numbers), and whatever you could not confirm. NEVER write "see above".\n\n' +
    '- When you cite code, give `path/to/file.ts:42`, not "in that config file somewhere"\n' +
    '- If you cannot find it, or the evidence is thin, SAY SO PLAINLY and say where you looked. A ' +
    'plausible invented answer is far worse than "not found", because the main agent will build on it\n' +
    '- You CANNOT ask the user anything — nobody will answer you in this run. If you lack information, ' +
    'write what is missing into the report\n' +
    '- Stay in scope: do the task you were given, and do not edit unrelated files along the way',
  source: { kind: 'builtin', path: '(内建)' }
}

/** 全部内建子代理。现在只有一个,数组是为了让加载器那一侧不必特判。 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [GENERAL_PURPOSE]
