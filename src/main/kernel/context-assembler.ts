/**
 * ContextAssembler —— 方案 §4.12。
 *
 * v1 里它基本只是拼装,但**顺手算出上下文占用**,session 据此发 `context_usage`
 * 事件(§4.2)。上下文用尽是这类应用最高频的失败,而它现在是可以**提前看见**的。
 *
 * ★ 为什么是一组纯函数而不是一个 class:它现在没有状态。将来的压缩策略、
 * 缓存断点会带来状态,那时再包一层 —— 但**模块的名字现在就得存在**,
 * 因为「防止 `agent-session.ts` 长成 900 行」靠的是这个名字,不是这个 class。
 *
 * 内核纯度:不读时钟、不读环境变量,`now` 与 `workspaceRoot` 都是入参
 * (方案 §2 的 KernelHost 端口集)。
 */
import type { AgentMessage, ContentPart } from '../../shared/agent/message'
import { isToolResultOnly, userMessage } from '../../shared/agent/message'
import type { PermissionMode } from '../../shared/agent/permission'
import type { SessionMode, ThinkingLevel } from '../../shared/agent/run-request'
import { THINKING_BUDGET } from '../../shared/agent/run-request'
import type { ToolInfo } from '../../shared/agent/tool'
import { resolveModelThinking } from '../../shared/domain/model-runtime'
import type { ThinkingConfig } from '../../shared/domain/provider'
import type { PersonalizationSettings } from '../../shared/domain/settings'
import { PERSONALIZATION_MAX } from '../../shared/domain/settings'
import type { Skill } from '../../shared/domain/skill'
import type { GitContext } from './git-context'
import type { PlatformInfo } from './host'
import { permissionFacts } from './permission-gate'
import { clampWithEllipsis, stripControlChars } from './text'
import type { TodoItem } from './tool/builtin/todo'
import type { PlanDocumentV2 } from '../../shared/domain/plan'
import { MARK, latestTodosFrom } from './tool/builtin/todo'
import { neutralizeReminderTags, untrustedBoundary } from './untrusted'
import type { CanonicalRequest } from './upstream/canonical'

// ─────────────────────────── token 估算 ───────────────────────────

/**
 * ★ 这是**估算**,不是真值。真值在 `message_end.usage` 里,session 收到后
 * 应当用它覆盖。但压力条必须在**请求发出前**就画出来 —— 那时唯一能有的就是估算。
 *
 * 误差量级:英文约 ±15%,中文约 ±25%。够画一根进度条,不够做计费。
 * 所以 UI 上它是一根**条**,不是一个数字 —— 显示「128,431 / 200,000」会让人
 * 以为那是精确的,然后在它和账单对不上时来提 bug。
 */
const CHARS_PER_TOKEN_LATIN = 4
const TOKENS_PER_CJK_CHAR = 1

/** 每个块、每条消息在上游都有固定的结构开销(角色标记、块头) */
const PART_OVERHEAD_TOKENS = 8
const MESSAGE_OVERHEAD_TOKENS = 4
/** 工具定义除了名字和 schema,还有一层固定包装 */
const TOOL_OVERHEAD_TOKENS = 12
/** 一张图的量级。真实值取决于分辨率,这里取常见截图的中位数 */
const IMAGE_TOKENS = 1600

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // 部首、假名、CJK 统一表意
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0x20000 && cp <= 0x3ffff) //  扩展 B 及以上
  )
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let total = 0
  // for...of 按码点迭代 —— 用 text.length 会把一个 emoji 算成两个字符
  for (const ch of text) {
    total++
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk++
  }
  return Math.ceil(cjk * TOKENS_PER_CJK_CHAR + (total - cjk) / CHARS_PER_TOKEN_LATIN)
}

/** 工具入参理论上不会有环(它来自 JSON.parse),但类型是 unknown —— 不赌 */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

function estimatePart(p: ContentPart): number {
  const body = ((): number => {
    switch (p.type) {
      case 'text':
      case 'thinking':
        return estimateTokens(p.text)
      case 'tool_call':
        return estimateTokens(p.name) + estimateTokens(safeJson(p.input))
      case 'tool_result':
        return estimateTokens(p.output.content)
      case 'subagent':
        return estimateTokens(p.summary ?? '')
      case 'image':
        // dataRef 是个引用,但上游收到的是真图 —— 按图算,不按引用字符串算
        return IMAGE_TOKENS
      case 'file_ref':
        // 只把路径当文本发给模型,按路径字符串本身估算即可
        return estimateTokens(p.path)
      case 'error':
        return estimateTokens(p.error.message)
    }
  })()
  return body + PART_OVERHEAD_TOKENS
}

export function estimateMessages(messages: readonly AgentMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += MESSAGE_OVERHEAD_TOKENS
    for (const p of m.parts) n += estimatePart(p)
  }
  return n
}

/**
 * ★ 工具定义**要算进上下文**。一个挂了三个 MCP server 的工作区,工具 schema
 * 能占掉两三万 token —— 漏算它,压力条会在真正爆掉之前一直显示「还很空」。
 */
export function estimateTools(tools: readonly ToolInfo[]): number {
  let n = 0
  for (const t of tools) {
    n +=
      TOOL_OVERHEAD_TOKENS +
      estimateTokens(t.externalName) +
      estimateTokens(t.description) +
      estimateTokens(safeJson(t.inputSchema))
  }
  return n
}

// ─────────────────────────── 系统提示词 ───────────────────────────

/**
 * ★ 提示词一律**英文**,注释一律中文。
 *
 * 不是偏好问题:模型对英文指令的服从度在同等长度下更高,而系统提示词
 * **每一轮都重发** —— 同一句约束用中文写要多花约 1.6 倍的 token(见上面
 * `TOKENS_PER_CJK_CHAR`)。两件事叠起来,中文提示词是「更贵而且更松」。
 *
 * ★ 结构照搬 Claude Code:分节的**行为规则**,不是一段自我介绍。
 *
 * ## 往这里加一行之前,先过这四关
 *
 * 系统提示词是**每轮重发**的,而且是 prompt cache 的前缀 —— 一行不改变行为的字
 * 不是「多写了一点」,是**每一轮、永远**都在付钱。所以门槛应该高:
 *
 * 1. **说得出没有它模型会做错的那件具体事**。说不出就删掉。
 *    「简洁一点」说不出;「回答不要以 Here's what I found 开头」说得出。
 * 2. **形容词换成阈值或例子**。「be concise」没有下限,模型拿自己的先验去对齐,
 *    而那个先验是啰嗦的;「under 4 lines」+ 两条 `<example>` 才咬得住。
 * 3. **能变成事实就不要写成规则**(见 `host.ts` 的 `PlatformInfo`),
 *    能变成工具描述就不要写在这里(路由逻辑跟着工具走,工具不在快照里时
 *    那段字也不该占位),能在代码里强制就不要靠嘱咐 ——
 *    `edit_file` 的「先读后写」是 `fs.ts` 里的一道闸,不是这里的一行字。
 *    这三条的共同点:提示词是**最贵也最容易被忽略**的那个位置,排在最后选。
 * 4. **对着真实的失败写**,不是对着「理想的助手」写。下面
 *    `# When things go wrong` 整节的存在理由,就是模型会把同一个失败的调用
 *    原样重试直到用户中断 —— 运行不会因为固定轮次数耗尽而停止。
 */
const BASE_PROMPT = `You are the coding assistant in NextCoWork, a desktop app running on the user's own machine.

# Tone and style
- Be concise. Keep prose under 4 lines unless the user asks for detail or the task genuinely needs more. Code, diffs, and tool output do not count toward that.
- No preamble, no postamble. Do not open with "Here's what I found" or "Great question". Do not close with a summary of what you just did unless the user asks. Answer, then stop.
<example>user: what port does the dev server use? / assistant: 5173 — vite.config.ts:12</example>
<example>user: is this function async? / assistant: No.</example>
- Reply in the language the user writes in.
- Output is rendered as GitHub-flavored Markdown in a chat pane.
- Reference code as \`path/to/file.ts:42\` so the user can jump straight to it. Quote only the lines that matter — never paste back a whole file the user already has.
- Explain a command before you run it when it changes the user's machine or takes real time.

# Proactiveness
Do what the user asked, completely — and stop there.
- NEVER refactor, rename, reformat, upgrade, or "clean up" code the task did not require. Notice it, say so in one line, and let the user decide.
- NEVER create a file the user did not ask for, and NEVER write documentation (*.md, README) unless asked for it.
- When the user asks a QUESTION, answer it. Do not start editing because the answer implies an edit.

# Following conventions
- Before you change code, read enough of the surrounding file to match it: its naming, its idioms, its typing style, and how much it comments.
- NEVER assume a library is available. Check the manifest (package.json, Cargo.toml, pyproject.toml…) or find an existing import of it first.
- NEVER assume a command is available either. The test, lint, build, and run commands are whatever THIS repo defines — read its package.json scripts or its README. Do not guess \`npm test\`.
- NEVER commit, push, or publish anything unless the user asks you to.

# Doing the work
- Prefer editing an existing file over creating a new one.
- Keep users informed when a multi-step task changes state.
- Batch independent tool calls into a single reply. Several searches at once beats one per turn.
- Verify when verifying is cheap: run the test, run the typechecker, re-read the line you edited. NEVER report that something passes when you did not run it.
- Finish the whole task. If one part is genuinely blocked, do everything else and say plainly what you left out and why.

# When things go wrong
- If a call fails twice the same way, STOP repeating it — a third identical attempt fails too. Change the approach, or tell the user what is blocking you.
- READ the error before you react to it. Tool errors here are written to tell you what to do next; most of them name the fix.
- Report what actually happened. If a test fails, show the failure. If you skipped a step, say so. NEVER describe work you did not do.

# Permissions
Every tool call is checked against the permission mode the user chose for this workspace.
If a call is denied, do NOT route around it: do not retry it, do not reach for a different tool
that does the same thing, and do not use Bash to do what the denied tool would have done.
Stop and tell the user which permission you need.`

const MODE_APPENDIX: Record<SessionMode, string> = {
  normal: `# Default mode progress

For complex execution tasks, use update_plan with the complete checklist. Keep it concise and update it only when a step changes. Finish the current step before starting the next one. Do not repeat the whole checklist in chat after calling the tool. If scope changes, submit a complete replacement checklist. Before finishing, run the relevant verification command and report the result.`,
  plan: `# Plan mode

You have read-only tools only. Investigate the environment and repository first. Build a concise,
verifiable checklist with submit_plan using only explanation and plan[]. Do not call update_plan,
modify files, execute commands that change state, or promise that execution has started. The plan
must contain at least one concrete step and should not add redundant ceremony for a simple task.
After submit_plan succeeds, stop this planning run and wait for the user's decision.`,
  goal: `# Goal mode

Keep going until the goal is actually met. Do NOT stop after each step to ask "should I continue?" —
switching into goal mode is the user saying "keep going" once, for all of it.

Stop for exactly two reasons: the goal is done, or you have hit a fork you genuinely cannot resolve
without guessing. Say which of the two it is when you stop.`
}

/**
 * Skill 目录 —— **只有名字和描述,没有正文**。
 *
 * ★ 这是这一批最大的一处行为变化,也是它全部的意义所在。
 *
 * 原来这里把**每一条** Skill 的正文全量拼进系统提示词,而系统提示词
 * **每一轮都重发**。装十条就是每轮多烧十几万字符;更要命的是提示词前缀一变,
 * 上游的 prompt cache 就整体失效 —— 用户加装一条 Skill 之后,整个会话的
 * 每一轮都从头重新计费。
 *
 * 改成 Claude Code 的渐进披露:这里只放目录(每条一行),模型自己判断哪条
 * 对得上,再调 `Skill` 工具把正文取回来。正文因此只在**需要它的那一轮**
 * 出现一次,落在 `tool_result` 里。
 *
 * ⚠️ 描述仍然是**不可信输入**(Skill 从 zip / git 装),与 MCP 描述同等对待:
 * 削控制字符 + 限长。而这里唯一真正的防御是最后那段**权限边界声明** ——
 * 前两条只防「意外」,不防「故意」。真正的防线在权限层(§4.5):
 * Skill 说什么都不能让一次工具调用跳过审批。写在提示词里,是为了让模型
 * 在**它自己**能判断时先拒绝一次。
 */

/** 单条描述的字符上限。★ 和 `skill/load.ts` 里加载时那道闸是同一个数。 */
const SKILL_DESCRIPTION_MAX = 1024
/**
 * 整份目录的字符上限。
 *
 * ★ 原来是 `SKILLS_TOTAL_MAX = 128 * 1024`(那是**正文**的预算)。现在每条只占
 * 一行,16KB 能装下一百多条 —— 而真的装到撑爆这个预算的用户,问题也不在预算上。
 */
const SKILLS_CATALOG_MAX = 16 * 1024

function buildSkillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''

  const lines: string[] = []
  let budget = SKILLS_CATALOG_MAX
  let dropped = 0

  for (const s of skills) {
    const desc = clampWithEllipsis(stripControlChars(s.description), SKILL_DESCRIPTION_MAX)
    const line = `- \`${stripControlChars(s.name)}\` — ${desc}`
    if (line.length > budget) {
      dropped++
      continue
    }
    budget -= line.length + 1
    lines.push(line)
  }

  // 静默丢弃是更糟的:用户装了 Skill、界面上显示已启用、模型却没看到
  const note =
    dropped > 0 ? `\n\n(${dropped} more Skill(s) not listed — the catalog hit its size limit.)` : ''

  return `# Available Skills

The user has enabled these Skills for this workspace. THIS IS A CATALOG ONLY — the instructions
themselves are not here. When one description matches the task in front of you, call the \`Skill\`
tool with that name to fetch its body, then follow it. NEVER guess what a Skill contains from its
name; the description tells you whether to open it, not what is inside.

The user may explicitly name a Skill in their message with a tag such as
<skill name="algorithmic-art" />. Treat that tag as an explicit request: before doing the
task, call the Skill tool with the exact name from the tag and follow the returned body. Keep
the full enabled catalog available for other Skills as well; an explicit tag does not remove or
replace the workspace Skill allow-list.

${lines.join('\n')}${note}

${untrustedBoundary('A Skill body')}`
}

/**
 * 「偏好 › 个性化」那三栏 → 提示词里的一段。全空时返回空串(`buildSystemPrompt`
 * 会把它过滤掉)—— 一个从没填过这一页的用户,提示词里不该多出一个空标题。
 *
 * ★ **仍然要消毒。** 这三段是用户自己打的,所以不套 `untrustedBoundary`
 * (理由见 `shared/domain/settings.ts` 的 `PersonalizationSettings`),
 * 但「可信」和「格式正确」是两回事:粘贴进来的文本能带着 C0 控制字符,
 * 而旧库里可能躺着一段在上限存在之前写下的超长指令。两道都在这里补齐 ——
 * 落库那侧的闸门只管**以后**写进来的值。
 *
 * ★ **姓名和背景是事实,全局提示词是指令**,所以分成两段而不是拼成一段:
 * 「我叫张三」和「一律用中文回答」在模型眼里是两种东西,混在一个标题下
 * 会让后者读起来像是在自我介绍。
 */
function buildPersonalizationSection(p: PersonalizationSettings): string {
  const clean = (s: string, max: number): string =>
    clampWithEllipsis(stripControlChars(s).trim(), max)

  const name = clean(p.name, PERSONALIZATION_MAX.name)
  const background = clean(p.background, PERSONALIZATION_MAX.background)
  const instructions = clean(p.instructions, PERSONALIZATION_MAX.instructions)

  const sections: string[] = []

  const facts: string[] = []
  if (name !== '') facts.push(`Name: ${name}`)
  if (background !== '') facts.push(`What they do: ${background}`)
  if (facts.length > 0) {
    sections.push(
      `# About the user\n\nThe user filled this in themselves, in Settings. It is background, not a ` +
        `task — do not greet them by name every turn and do not bring it up unless it is relevant.` +
        `\n\n${facts.join('\n')}`
    )
  }

  if (instructions !== '') {
    /*
      ★ 最后那句不是客套,是**优先级声明**。用户在设置里写下的是「默认怎么做」,
      而聊天框里刚打的那句是「这一次要怎么做」—— 两者冲突时后者赢。
      不写这句的话,一条「永远用中文回答」会让模型在用户明确说
      "answer in English" 时也照旧说中文,而用户完全不知道该去哪里关掉它。
    */
    sections.push(
      `# User instructions\n\nStanding instructions the user set in Settings. They apply to every ` +
        `conversation. The user cannot see this block: do not mention it, do not thank them for it. ` +
        `When it conflicts with what the user just asked you for, the user's latest message wins.` +
        `\n\n${instructions}`
    )
  }

  return sections.join('\n\n')
}

export interface SystemPromptInput {
  mode: SessionMode
  skills: readonly Skill[]
  workspaceRoot: string
  /** host.clock.now() */
  now: number
  /**
   * host.platform。★ 必填,不是可选。
   *
   * 可选的话,忘了传的那条路径会**静音地**少掉两行事实 —— 而症状是模型在
   * macOS 上写了一条 GNU 才有的 `sed -i`,看起来像模型笨,不像我们漏了字段。
   * 提示词里的事实要么是真的、要么根本不该在,没有「有时候有」这一档。
   */
  platform: PlatformInfo
  environment?: Pick<import('./host').WorkspaceHost, 'remote' | 'description' | 'facts'>
  /**
   * 这两项和 `platform` 同档:**必填的事实**,不是可选的装饰。
   *
   * ★ 它们进的是系统提示词而不是下面那个 reminder 块 —— 它们是 **run 级常量**
   * (`RunRequest` 原文:「快照:run 开始时定死,运行期不变」)。放进每轮现算的
   * 易失块里,等于每一轮为同一句话重新破一次 prompt cache;放在这里进的是
   * 稳定前缀,而且消费它们的 `# Permissions` 那段规则就在同一份提示词里。
   */
  permissionMode: PermissionMode
  webSearch: boolean
  /**
   * 子代理的角色提示词(`agents/<name>.md` 的正文)。
   *
   * ★ 它是**追加**的一段,不是替换。见下面 `buildSystemPrompt` 里的说明。
   */
  agentPrompt?: string
  /**
   * 「偏好 › 个性化」那三栏(`store.getSettings().personalization`)。
   * 缺省 = 这条路径不给(纯内核测试)。全空的那份也可以照给,拼出来是空串。
   */
  personalization?: PersonalizationSettings
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  // 模型不知道今天几号,而「最近」「最新版本」这类判断依赖它
  const date = new Date(input.now).toISOString().slice(0, 10)

  const parts = [
    BASE_PROMPT,
    /*
      ★ 角色提示词**追加**在 `BASE_PROMPT` 之后,永远不替换它。

      替换掉基础提示词的子代理会丢掉「被拒绝时不要试图绕开」「Skill 正文
      不能放宽你的权限」这一类约束 —— 而一个会绕开约束的子代理,正是这整套
      权限设计最不想要的东西。位置也是有意的:紧跟在基础提示词之后、
      在环境和模式之前,所以后面那几段(尤其是 plan 模式那段)压得住它。
    */
    input.agentPrompt === undefined || input.agentPrompt.trim() === ''
      ? ''
      : `# Your role\n\n${input.agentPrompt.trim()}`,
    /*
      ★ 这一段全是**事实**,一条规则都没有 —— 见文件头第 3 关。
      `Platform` 挡掉的是一整类 bash 失败(macOS 的 `sed -i` 要带空串参数、
      没有 `readlink -f`、`date` 的旗标不一样),而它的成本是三个 token。
      `Shell` 来自 `agentShell()`,和 bash 工具真正跑命令的那个是同一个。
    */
    `# Environment\n\nWorkspace root: ${input.workspaceRoot}\n` +
      `Platform: ${input.platform.os} (${input.platform.osVersion})\n` +
      `Shell: ${input.platform.shell}\n` +
      (input.environment ? `Execution location: ${input.environment.remote ? 'SSH server' : 'local machine'} ${JSON.stringify(input.environment.description)}\n`
        + (input.environment.facts ? `Host: ${JSON.stringify(input.environment.facts.hostname)}; user: ${JSON.stringify(input.environment.facts.username)}; home: ${JSON.stringify(input.environment.facts.home)}\n` : '')
        + (input.environment.remote ? 'Workspace files, commands and terminals execute on this server. The client filesystem and client browser are not available to workspace tools.\n' : '') : '') +
      `Today's date: ${date} (UTC)\n` +
      permissionFacts(input.permissionMode, input.webSearch),
    /*
      ★ 位置是有意的:在**事实**之后、在模式说明之前。

      在事实之后 —— 「用户是谁」和「今天几号」「shell 是什么」同档,都是这次
      运行的常量,而它们都进稳定前缀(不进每轮现算的 reminder 块),因而
      一份都不破 prompt cache。

      在模式说明之前 —— plan 模式那段说的是「你现在只有只读工具」,它必须压得住
      一条写着「别问了直接改」的全局提示词。用户设的是默认口吻,不是权限。
    */
    input.personalization === undefined ? '' : buildPersonalizationSection(input.personalization),
    MODE_APPENDIX[input.mode],
    buildSkillsSection(input.skills)
  ]
  return parts.filter((p) => p !== '').join('\n\n')
}

// ─────────────────────────── thinking 预算 ───────────────────────────

/** Anthropic 拒绝小于 1024 的预算 */
const MIN_THINKING_BUDGET = 1024
/** 思考吃掉的是 max_tokens 的额度,总得给正文留一点 */
const MIN_OUTPUT_HEADROOM = 1024

/**
 * ★ 上游要求 `max_tokens > thinking.budget_tokens`。
 *
 * 这条约束不写下来,症状是:用户在界面上选「最高」(64000),而模型的
 * `maxOutputTokens` 是 8192 —— 请求直接 400,错误信息里只字不提 thinking,
 * 你会先去查自己的消息数组。
 *
 * 处理方式是**降级而不是报错**:能挤出 1024 就按挤出来的算,挤不出就不开思考。
 * 用户选的是「多想一点」,不是「宁可失败也要想这么多」。
 */
export function resolveThinkingBudget(
  level: ThinkingLevel,
  supportsThinking: boolean,
  maxOutputTokens: number
): number | undefined {
  // 界面原文:「不支持该参数的模型将自动忽略此设置」
  if (!supportsThinking) return undefined
  if (level === 'off') return undefined

  // 「自动」不等于「关闭」—— 它得真的开一点思考,否则界面上这两档没有区别
  const wanted = level === 'auto' ? THINKING_BUDGET.medium : THINKING_BUDGET[level]

  const ceiling = maxOutputTokens - MIN_OUTPUT_HEADROOM
  if (ceiling < MIN_THINKING_BUDGET) return undefined
  return Math.min(wanted, ceiling)
}

// ─────────────────────── 注入进消息流的 system-reminder ───────────────────────

/**
 * 项目规矩与运行时状态,注入**这一轮发出去的那份消息流**,转录一个字都不动。
 *
 * ## 为什么不在提交转录时注入
 *
 * 三条硬证据,每一条单独都足以否掉那个做法:
 * 1. `Thread.tsx` 的 `UserBubble` 把该消息**所有** text part `join('')` 之后渲染 ——
 *    往 user 消息里 commit 一个 reminder,用户会在**自己的**聊天气泡里逐字读到
 *    整篇 AGENTS.md。
 * 2. committed 的内容会被冻进转录。用户改了 AGENTS.md,旧会话仍然永远重放旧的;
 *    一条三天前的 `[x] 跑测试` 会以「当前状态」的身份一直上行。
 * 3. `ContentPart` 没有任何 metadata / hidden 标志位,「commit 了但不渲染」
 *    要改 schema + 渲染层 + 编码器三处,而收益是零。
 *
 * 装饰放在 `assemble()` 里,三件事一起解决:转录干净、内容每轮现算、UI 看不见。
 *
 * ## ★ 位置是被 prompt cache 决定的,不是随手放的
 *
 * 前缀缓存按 `system → tools → messages` 顺序**逐字节**匹配,而这个特性改的正是
 * `messages`。所以:
 *
 * - **静态的放最前**:AGENTS.md 前置到第一条 user 消息(一个工作区内不变,
 *   而且它长 —— 32KB 的项目规矩垫在问题后面,等于把用户的问题推到 8000 token 之外)。
 * - **易失的放最后**:状态块追加到**本 run 那条用户输入**消息。
 *
 * ★ 尾块**绝不能**挂在「最后一条消息」上。`turn()` 在没有工具调用时就 finish 了,
 * 所以除了每个 run 的第一轮,数组末尾**永远**是 `executeAll` 提交的那条
 * `toolResultMessage`。挂在它上面的话:第 K 轮里它带着尾块、第 K+1 轮里不带,
 * 前缀就在**整个数组里最大的那条**上断掉 —— 功能完全正常,只有账单和延迟在涨。
 * 挂在用户输入那条上,整个 run 里它一字不变,断点只落在 run 的第一轮,
 * 而那一轮本来就要处理一条全新的用户消息。
 *
 * ★ 代价要说清楚:尾块因此是**每 run 算一次**,不是每轮现算。所以文案里逐字写着
 * "as of the start of this run" —— 含糊地写成「current branch」而它其实是五分钟
 * 之前的,比不写更糟:提示词里的假事实模型不会去质疑。
 */

/** 装饰用的标签。★ 它是个标签,不是信任边界 —— 见 `untrusted.ts` 里那段说明。 */
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/** 单条 todo 文字的上限。它是模型自己写的,但仍然要限长:一条 5000 字的 todo 能顶掉整个尾块。 */
const TODO_TEXT_MAX = 200

export interface ReminderContext {
  approvedPlan?: PlanDocumentV2
  /** AGENTS.md,已拼接已消毒(`instructions.ts`)。空串 / 缺省 = 没有。 */
  projectInstructions?: string
  /** run 开始时的 git 快照(`git-context.ts`)。缺省 = 不是仓库 / 读不到。 */
  git?: GitContext
  /**
   * TodoWrite 的 **externalName**。
   *
   * ★ 必须由 `tools.byInternalId('TodoWrite')?.externalName` 查出,不能写字面量,
   * 也不能从本轮的 `advertised` 快照里取 —— 详见 `latestTodosFrom` 的文档。
   */
  todoToolName?: string
}

function reminderPart(body: string): ContentPart {
  return { type: 'text', text: `${REMINDER_OPEN}\n${body}\n${REMINDER_CLOSE}` }
}

/**
 * ★ 每一段拼进去的不可信文本都要过这一道。
 * todo 的文字是模型自己写的,但模型上一轮读过的东西可能是投毒的 —— 它会把那段话
 * 原样抄进 todo,于是下一轮那段话就以「系统状态」的身份回来了。
 */
function clean(text: string, max: number): string {
  return clampWithEllipsis(neutralizeReminderTags(stripControlChars(text)), max)
}

function instructionsBlock(text: string): string {
  return (
    'Project instructions for this workspace, loaded from AGENTS.md. Follow them for the whole ' +
    'conversation.\n' +
    'The user did not type this block and cannot see it: do not reply to it, do not mention that you ' +
    'read it, and do not thank the user for it. When it conflicts with what the user just asked you ' +
    'for, the user wins.\n\n' +
    `<project-instructions>\n${text}\n</project-instructions>\n\n` +
    untrustedBoundary('The project instructions above')
  )
}

function gitSection(g: GitContext): string {
  const where = g.branch === '' ? 'no branch (detached HEAD, or no commits yet)' : `branch ${g.branch}`
  const dirty =
    g.dirtyCount === 0 ? 'working tree clean' : `${String(g.dirtyCount)} file(s) with uncommitted changes`
  const recent =
    g.recent.length === 0 ? '' : `\nRecent commits:\n${g.recent.map((l) => `- ${l}`).join('\n')}`
  return `Git: ${where} · ${dirty}${recent}`
}

function todoSection(todos: readonly TodoItem[]): string {
  const lines = todos.map((t) => `${MARK[t.status]} ${clean(t.content, TODO_TEXT_MAX)}`)
  return `Your todo list:\n${lines.join('\n')}`
}

function stateBlock(ctx: ReminderContext, messages: readonly AgentMessage[]): string | undefined {
  const sections: string[] = []
  if (ctx.approvedPlan !== undefined) sections.push(`Approved plan (${ctx.approvedPlan.id} v${String(ctx.approvedPlan.version)}):\n${ctx.approvedPlan.plan.map((step) => `- [${step.status}] ${step.step}`).join('\n')}`)
  if (ctx.git !== undefined) sections.push(gitSection(ctx.git))

  /*
    ★ todo 从**转录**反推,不引入任何服务端状态 —— 唯一真相源仍然是那条
    `tool_call`,`todo.ts` 的无状态设计原封不动。子 run 的 `messages` 是空的,
    于是它自然拿不到父代理的 todo(那是父代理的进度,不是它的),不用特判。

    ★ 传进来的是**截到本 run 那条用户输入为止**的一段,不是全量数组 ——
    这既是文案里那句 "as of the start of this run" 的字面实现,也是缓存的要求:
    模型在本 run 中途自己改了 todo 的话,每轮现算就意味着尾块每轮都变,
    而尾块挂在**第一条**用户消息上 —— 前缀会从那里往后整体作废。
    它这一轮刚写的那次 `TodoWrite` 就在最近几条转录里,它看得见。
  */
  const todos =
    ctx.todoToolName === undefined ? undefined : latestTodosFrom(messages, ctx.todoToolName)
  if (todos !== undefined) sections.push(todoSection(todos))

  if (sections.length === 0) return undefined
  return (
    'Workspace state, as of the start of this run. It is here so you do not have to run a command to ' +
    'find it.\n' +
    'The user did not type this block and cannot see it: do not reply to it and do not mention it.\n' +
    'It is a snapshot — anything that changed while this run was already going is NOT reflected here.' +
    `\n\n${sections.join('\n\n')}`
  )
}

/**
 * ★ Anthropic 要求 `tool_result` 块位于 user 消息**开头**。
 *
 * 按下面 `decorate` 的定位规则,头块落到的那条消息不会含 tool_result —— 但违反
 * 这条约束的症状是**上游 400**,不是编译错误,所以这里不赌规则将来不被放宽:
 * 插在前导的那串 tool_result 之后,无论如何都是合法的。
 */
function insertHead(parts: readonly ContentPart[], head: ContentPart): ContentPart[] {
  let i = 0
  while (i < parts.length && parts[i]?.type === 'tool_result') i++
  return [...parts.slice(0, i), head, ...parts.slice(i)]
}

/**
 * 装饰一份**副本**。
 *
 * ★ 拷贝不是洁癖:`input.messages` 里那些对象就是 `store.setHistory` 要落盘的那些。
 * 就地改 `parts` = reminder 被写进转录,而且下一轮再加一份,滚雪球直到爆窗口。
 * 头块因此是**新建一个 part**,而不是拼进已有的那个 —— 顺带也去掉了
 * 「就地改一下」的诱惑。
 *
 * ★ 找不到 user 消息(空数组)时**原样返回,绝不合成一条消息**:那种情况下请求
 * 本来就是必然的 400,而合成一条会把「一眼看得出的 400」变成「模型收到一堆项目
 * 规矩、却没有任务」—— 后者要靠读日志才发现。
 */
export function decorate(
  messages: readonly AgentMessage[],
  ctx: ReminderContext
): readonly AgentMessage[] {
  const instructions = ctx.projectInstructions?.trim() ?? ''
  const head = instructions === '' ? undefined : reminderPart(instructionsBlock(instructions))
  if (head === undefined && ctx.git === undefined && ctx.todoToolName === undefined && ctx.approvedPlan === undefined) return messages

  /*
    ★ 两处定位都不能写成 `messages[0]` / `messages.at(-1)`。
    头:**当下这个数组里**第一条 user 消息 —— 于是 `withSummary()` 往头部插一条
    摘要消息之后,规则依然成立,压缩不需要任何特殊处理。
    尾:从后往前第一条**不是纯工具结果**的 user 消息,理由见本节文件头那颗 ★。
  */
  const i = messages.findIndex((m) => m.role === 'user')
  if (i === -1) return messages
  let j = -1
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k]
    if (m !== undefined && m.role === 'user' && !isToolResultOnly(m)) {
      j = k
      break
    }
  }

  const tailBody = j === -1 ? undefined : stateBlock(ctx, messages.slice(0, j + 1))
  const tail = tailBody === undefined ? undefined : reminderPart(tailBody)
  if (head === undefined && tail === undefined) return messages

  return messages.map((m, k) => {
    const addHead = k === i && head !== undefined
    const addTail = k === j && tail !== undefined
    if (!addHead && !addTail) return m
    const parts = addHead ? insertHead(m.parts, head) : [...m.parts]
    if (addTail) parts.push(tail)
    return { ...m, parts }
  })
}

// ─────────────────────────── 组装 ───────────────────────────

/** 超过窗口的这个比例就该压缩了 */
const COMPACT_THRESHOLD = 0.8

export interface AssembleInput {
  messages: readonly AgentMessage[]
  tools: readonly ToolInfo[]
  skills: readonly Skill[]
  /** 子代理的角色提示词,追加在基础提示词之后。主 run 不传。 */
  agentPrompt?: string
  /**
   * 「偏好 › 个性化」。★ **子代理照样给** —— 同 `projectInstructions` 的先例
   * (`runtime.ts` 里那段注释):子代理在同一个工作区、替同一个用户干活,
   * 不给它「一律用中文」这条,它会交回一份英文的结论,而父代理只看得见结论。
   */
  personalization?: PersonalizationSettings
  mode: SessionMode
  thinking: ThinkingLevel
  /** ModelAlias.alias,不是上游真实模型名 —— 路由器负责翻译 */
  model: string
  /** 用户显式选定的供应商(硬约束),原样带给路由器。见 `RunRequest.modelProviderId` */
  modelProviderId?: string
  workspaceRoot: string
  now: number
  /** host.platform */
  platform: PlatformInfo
  /** 以下两项直接来自 `RunRequest`,进系统提示词的 `# Environment`(见 `SystemPromptInput`) */
  permissionMode: PermissionMode
  webSearch: boolean
  /** 以下三项来自 ModelAlias */
  contextWindow: number
  maxOutputTokens: number
  supportsThinking: boolean
  /** Detailed declaration for new catalogue-backed aliases. */
  thinkingConfig?: ThinkingConfig
  reasoningEfforts?: readonly import('../../shared/domain/provider').ReasoningEffort[]
  /**
   * 注入进消息流的那一份。缺省 = 什么都不注入(纯内核测试走这条)。
   *
   * ★ **整体可选**,和上面 `platform` 必填是**相反**的决定,理由也相反:
   * `platform` 漏传会让提示词少掉两条**事实**(静默地骗模型);`reminder` 漏传
   * 只是少注入一段可有可无的上下文,没有任何东西会变成假的。
   */
  reminder?: ReminderContext
}

export interface ContextUsage {
  used: number
  window: number
  shouldCompact: boolean
}

export interface AssembleOutput {
  request: CanonicalRequest
  usage: ContextUsage
}

export function assemble(input: AssembleInput): AssembleOutput {
  const system = buildSystemPrompt(input)
  const reasoning = input.thinkingConfig === undefined
    // Legacy aliases may have no capability declaration. Preserve an explicit
    // Off so the protocol boundary can disable upstream defaults when supported.
    ? input.thinking === 'off' ? { mode: 'toggle' as const, enabled: false, explicit: true } : undefined
    : resolveModelThinking(input.thinking, input.thinkingConfig, input.maxOutputTokens, input.reasoningEfforts)
  const budget = input.thinkingConfig === undefined
    ? resolveThinkingBudget(input.thinking, input.supportsThinking, input.maxOutputTokens)
    : reasoning?.enabled === true
      ? reasoning.budgetTokens
      : undefined

  const messages =
    input.reminder === undefined ? input.messages : decorate(input.messages, input.reminder)

  const request: CanonicalRequest = {
    model: input.model,
    ...(input.modelProviderId === undefined ? {} : { modelProviderId: input.modelProviderId }),
    thinkingLevel: input.thinking,
    system,
    messages: [...messages],
    tools: [...input.tools],
    maxOutputTokens: input.maxOutputTokens,
    ...(budget !== undefined ? { thinkingBudget: budget } : {}),
    ...(reasoning !== undefined ? { reasoning } : {})
  }

  /*
    ★ 从**装饰后**的数组算,不是 `input.messages`。
    照旧读原数组的话,上下文占用每轮都会少算掉整个 AGENTS.md + 状态块,
    `shouldCompact` 跟着一起迟到 —— 而那两样正是这个模块存在的全部理由(文件头 §4.12)。
    表现是「上下文突然就爆了」,不会有任何报错。
  */
  const used = estimateTokens(system) + estimateMessages(messages) + estimateTools(input.tools)

  return {
    request,
    usage: {
      used,
      window: input.contextWindow,
      /**
       * ★ 把 `maxOutputTokens` 算进来:上下文窗口是**输入加输出**共用的。
       * 只比较输入的话,你会在「输入刚好塞得下、回复写到一半被截断」时
       * 才发现该压缩了 —— 而那时这一轮已经浪费了。
       */
      shouldCompact: used + input.maxOutputTokens > input.contextWindow * COMPACT_THRESHOLD
    }
  }
}

// ─────────────────────────── 压缩 ───────────────────────────

const COMPACTED_TOOL_OUTPUT = '[compacted: tool output from this turn was dropped]'
const COMPACTED_PLACEHOLDER = '[compacted]'
/** 最近这么多条消息保留原文 */
const KEEP_RECENT_DEFAULT = 6

/**
 * 机械压缩 —— `/compact` 的**下半截**。
 *
 * 完整的 `/compact` 是「让模型总结一遍旧历史」,那需要发一次请求,
 * 因而属于 session 而不是这里(步骤 12)。但**按体积算,大头不在那里**:
 * 转录里最占地方的是历史工具输出 —— 一个 `read_file` 就是几千 token,
 * 而它在模型已经据此改完代码之后就不再有信息量了。
 *
 * 所以这一半是纯函数,可以立即做、可以单测,并且它保住了那条最容易违反的不变式:
 *
 * ★ **绝不删除 `tool_call` 或 `tool_result` 块本身,只清空内容。**
 * 删掉一个 tool_result 就等于制造了一个孤儿 tool_use,下一轮直接 400 ——
 * 与中断收尾漏补 tool_result(§4.8 第 4 件)是同一个坑的另一个入口。
 */
export interface CompactOptions {
  keepRecent?: number
}

function compactPart(p: ContentPart): ContentPart | undefined {
  switch (p.type) {
    case 'tool_result':
      // 保住 callId 与配对关系,只丢内容
      return { ...p, output: { content: COMPACTED_TOOL_OUTPUT } }
    case 'thinking':
      /**
       * 历史思考块可以整块丢:上游只要求**最后一轮**助手消息的 thinking
       * 带着签名原样回传。而「最后一轮」永远落在下面保留原文的尾部里。
       */
      return undefined
    case 'image':
      // 图最贵,而它通常在被描述过一次之后就不再需要
      return { type: 'text', text: COMPACTED_PLACEHOLDER }
    default:
      return p
  }
}

export function compactMessages(
  messages: readonly AgentMessage[],
  opts: CompactOptions = {}
): AgentMessage[] {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_DEFAULT
  const cutoff = messages.length - keepRecent

  return messages.map((m, i) => {
    // 第一条保留原文:它是任务的原始表述,压掉它模型就不知道自己在干嘛了
    if (i === 0 || i >= cutoff) return m

    const parts = m.parts
      .map(compactPart)
      .filter((p): p is ContentPart => p !== undefined)

    /**
     * ★ 空 parts 的消息会被上游拒绝(「all messages must have non-empty content」)。
     * 一条只有 thinking 的助手消息压完就是空的 —— 这在开了扩展思考时很常见。
     */
    if (parts.length === 0) return { ...m, parts: [{ type: 'text', text: COMPACTED_PLACEHOLDER }] }
    return { ...m, parts }
  })
}

/**
 * 压缩后接一条摘要消息的位置 —— 步骤 12 让模型生成摘要时往这里塞。
 * 现在给出签名,是为了让调用方那一行**不必在那时改**。
 */
export function withSummary(
  messages: readonly AgentMessage[],
  summary: string,
  id: string,
  now: number
): AgentMessage[] {
  return [userMessage(id, [{ type: 'text', text: `Summary of the conversation so far:\n\n${summary}` }], now), ...messages]
}
