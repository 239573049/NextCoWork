/**
 * 权限闸门的**策略**部分 —— 只有那张表,没有任何机制。
 *
 * ★ 刻意和 `PermissionDecision` 分成两个类型。`allow_always` / `allow_edited` 是
 * **用户的回答**,闸门永远不可能产出它们。混成一个类型的话,「谁有资格说 always」
 * 在类型上就看不出来了 —— 而那正是以后接对话框时最容易搞错的一处。
 *
 * ## 这一批「需要询问」= 拒绝
 *
 * 审批对话框(InteractionGate / 待决表)不在这一批里。`evaluate()` 照实返回 `ask`,
 * 由调用方(`runtime.ts`)决定怎么降级 —— 这样以后接上对话框时,改的是调用方
 * 那三行,而不是这张表。表本身是对的,只是暂时没人能回答它的问题。
 */
import type { PermissionMode, PermissionQuery } from '../../shared/agent/permission'

export type PermissionOutcome =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask' }

/**
 * 联网被关掉时给模型的说法。
 *
 * ★ 必须说清「这是用户关的开关」,否则模型会去试 `Bash` 里的 curl —— 那是同一件事
 * 换个入口,而且绕过了这道闸。最后一句直接堵掉那条路。
 */
const NETWORK_OFF =
  '这个工具需要联网,但当前工作区的「联网」开关是关闭的,所以调用被拒绝。' +
  '这是用户的设置,不是你调用得不对。请不要改用 Bash 里的 curl / wget 去做同一件事 —— ' +
  '那会绕过用户明确关掉的开关。请告诉用户:这一步需要联网,可以在工作区设置里打开。'

/**
 * 那张表。**顺序即语义**,`permission-gate.test.ts` 按行逐条钉死。
 *
 * 1. `needsNetwork && !webSearch` → deny。★ 必须排在只读之前:一个**只读**的联网
 *    工具(`WebFetch` 就是)在开关关掉时仍然要拒。`full` 档也放宽不了它 ——
 *    `permission.ts` 里 `'full'` 的注释原文就是「**联网仍受开关控制**」。
 * 2. `readOnly` → allow。三档都放行读。每读一个文件弹一次窗,用户 30 秒内就学会
 *    无脑点「允许」—— 那比不弹更危险,因为后面真正该看的那次也会被点掉。
 * 3. `mode === 'ask'` → ask。写与执行才问。
 * 4. `mode === 'auto' && destructive` → ask。对应「仅对潜在不安全操作询问」。
 * 5. 其余(`auto` 非破坏 / `full`)→ allow。
 */
export function evaluate(q: PermissionQuery): PermissionOutcome {
  if (q.needsNetwork === true && !q.webSearch) return { kind: 'deny', reason: NETWORK_OFF }
  if (q.readOnly) return { kind: 'allow' }
  if (q.mode === 'ask') return { kind: 'ask' }
  if (q.mode === 'auto' && q.destructive) return { kind: 'ask' }
  return { kind: 'allow' }
}

/**
 * 需要联网的工具的 `internalId`。
 *
 * ★ 用一张显式的表,而不是给 `ToolRegistration` 加一个 `needsNetwork` 字段 ——
 * 加字段的话,MCP 工具(步骤 10)的作者可以自己把它写成 `false`,于是
 * 「联网开关」这个用户设置就被第三方工具描述给关掉了。判定权留在我们这边。
 */
export const TOOLS_NEEDING_NETWORK: ReadonlySet<string> = new Set(['WebFetch'])

/**
 * 「该问但问不了」时给模型的原文。
 *
 * ★ 三句话各有各的用途,一句都不能省:
 * ① **归因** —— 不说的话,模型会开始怀疑自己的参数,把同一个调用改着法儿重试三次;
 * ② **禁止绕行** —— 不说的话,它会去试 `Bash` 里的 `cat` 来替代 `Write`,
 *    而那恰恰是这道闸要防的事;
 * ③ **给用户一条出路** —— 只说「不行」的话,用户看到的是一个卡住的助手。
 */
export const ASK_NOT_WIRED_YET =
  '这次调用需要用户当面批准,但这个版本还没有把审批对话框接上 —— 所以它被自动拒绝了。' +
  '**这不是你的错,也不是你调用得不对。**\n\n' +
  '不要换一个工具去做同一件事,不要试图绕过这个限制,也不要重试。' +
  '请直接停下来告诉用户:这一步需要审批,而审批功能尚未可用;' +
  '如果他想让你继续,可以把工作区的权限模式改成「自动」或「完全」,或者自己动手做这一步。'

/** 给测试和诊断用:把一次判定压成一行人话。 */
export function describeOutcome(mode: PermissionMode, o: PermissionOutcome): string {
  if (o.kind === 'allow') return `${mode}:放行`
  if (o.kind === 'ask') return `${mode}:需要询问`
  return `${mode}:拒绝`
}
