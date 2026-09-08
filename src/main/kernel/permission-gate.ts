/**
 * 权限闸门的**策略**部分 —— 只有那张表,没有任何机制。
 *
 * ★ 刻意和 `PermissionDecision` 分成两个类型。`allow_always` / `allow_edited` 是
 * **用户的回答**,闸门永远不可能产出它们。混成一个类型的话,「谁有资格说 always」
 * 在类型上就看不出来了。
 *
 * `evaluate()` 返回 `ask` 时,调用方(`runtime.ts`)通过 InteractionGate
 * 等待用户回答。策略判断不持有待决状态,也不把询问自动降级为拒绝。
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
  'This tool needs network access, but the "network" switch is turned off for this workspace, so the ' +
  'call was denied. This is the user\'s setting, not a mistake in how you called it. Do NOT reach for ' +
  'curl or wget through Bash to do the same thing — that would route around a switch the user turned ' +
  'off deliberately. Tell the user this step needs network access and that they can enable it in the ' +
  'workspace settings.'

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
 * 需要联网的工具的 `internalId` —— 一张**下限表**。
 *
 * 原来这里是唯一的判定依据,理由是「给 `ToolRegistration` 加 `needsNetwork` 字段的话,
 * MCP 工具的作者可以自己写成 `false`,用户的联网开关就被第三方描述关掉了」。
 * 那个顾虑是对的,但结论过头了:一张写死 internalId 的表**列不出 MCP 工具**
 * (它们的 id 是运行时才知道的 `mcp__<server>__<tool>`),于是步骤 10 一落地,
 * 所有 MCP 工具都会绕过这道闸 —— 恰好是同一个顾虑的更严重版本。
 *
 * 现在的分工是:`ToolInfo.needsNetwork` 承担判定,但**它只能往严的方向说话** ——
 * 这张表里的名字无论字段怎么填都算联网(见 `runtime.ts` 里那个 `||`)。
 * 而那个字段本身也不采信任何不可信输入:MCP 工具的值由 `mcp/bridge.ts`
 * 按我们库里存的**传输方式**推出来,不读服务器自报的 annotations。判定权仍在我们这边。
 */
export const TOOLS_NEEDING_NETWORK: ReadonlySet<string> = new Set([
  'WebFetch',
  'web_search',
  'browser_open',
  'browser_navigate',
  'browser_snapshot'
])

/** 给测试和诊断用:把一次判定压成一行人话。 */
export function describeOutcome(mode: PermissionMode, o: PermissionOutcome): string {
  if (o.kind === 'allow') return `${mode}:放行`
  if (o.kind === 'ask') return `${mode}:需要询问`
  return `${mode}:拒绝`
}

/**
 * `# Environment` 里那几行**权限事实**。
 *
 * ★ 它放在这里、跟着上面那张表走,而不是在 `context-assembler.ts` 里另写一份 ——
 * 理由和 `text.ts` / `untrusted.ts` 文件头那条一样:**两处必须给出同一个答案**。
 * 提示词说「写盘会被拒」而闸门其实放行(或者反过来),是最坏的一种漂移:
 * 模型会据此**提前放弃**一件它本来做得成的事,而这中间不会有任何报错。
 *
 * 写成事实而不是规则(见 `context-assembler.ts` 文件头第 3 关):模型**事前**
 * 就知道自己写盘要不要审批,而不是撞一次墙再学 —— 撞墙那一轮不只是浪费,
 * 它的下一步大概率是去试 `Bash` 绕。
 */
export function permissionFacts(mode: PermissionMode, webSearch: boolean): string {
  const say = (readOnly: boolean, destructive: boolean): string => {
    const o = evaluate({ mode, readOnly, destructive, webSearch })
    if (o.kind === 'allow') return 'run without asking'
    if (o.kind === 'ask') return 'wait for user approval before execution'
    return 'are denied'
  }
  const net = webSearch
    ? 'available'
    : 'denied — the network switch is off for this workspace, and Bash cannot be used to route around it'

  return (
    `Permission mode: ${mode}\n` +
    `- Reading and searching: ${say(true, false)}\n` +
    `- Writing files and running commands: ${say(false, true)}\n` +
    `- File tools are not fenced to the workspace: an absolute path anywhere on this machine resolves, ` +
    `and the rules above are what governs it\n` +
    `- Tools that need the network: ${net}`
  )
}
