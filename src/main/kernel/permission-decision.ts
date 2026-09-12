/**
 * 权限判定的**顺序** —— 从 `runtime.ts` 的 `approveWith` 里抽出来的纯函数。
 *
 * ## 为什么要抽出来
 *
 * 这条链有八层（联网开关 / deny 桶 / 钩子 / ask 桶 / allow 桶 / 档位 / AI 审核 /
 * 问人），而**顺序就是语义**：谁排在谁前面决定了「一条 allow 规则能不能盖过一条
 * deny 规则」这种问题的答案。它原先整个埋在一个带 IO 的 async 闭包里，一行测试
 * 也覆盖不到 —— 而这正是整个应用里最不该靠「读一遍代码确认」的地方。
 *
 * ## 为什么是**两个**函数而不是一个
 *
 * 中间夹着钩子，而跑钩子是有副作用的（fork 进程）。拆成两段之后，
 * 「deny 桶命中时钩子根本不会跑」这件事从一句注释变成了**类型上看得见的结构**：
 * 调用方拿到 `deny` 就直接 return 了，物理上到不了跑钩子那一步。
 */

/** `permission-gate.ts` 的 `evaluate()` 结果。 */
export type GateOutcome = { kind: 'allow' } | { kind: 'ask' } | { kind: 'deny'; reason: string }

/** 钩子跑完之后，归纳出来的那三种表态。 */
export interface HookVerdict {
  /** 有钩子明确拒绝。带上它给的理由。 */
  deny?: string
  /** 有钩子明确放行。 */
  allow: boolean
  /** 有钩子要求「问人」。 */
  ask: boolean
}

export type EarlyDecision =
  | { kind: 'deny'; reason: string }
  /** 还没定 —— 调用方接着跑钩子，再走 `decideAfterHooks`。 */
  | { kind: 'continue' }

export type FinalDecision =
  | { kind: 'deny'; reason: string }
  | { kind: 'allow' }
  /** 交给 AI 审核器（`auto` 档 + 破坏性操作）。 */
  | { kind: 'review' }
  /** 弹窗问人。 */
  | { kind: 'prompt' }

/**
 * 钩子**之前**那两层。
 *
 * ★ 联网开关排第一：一条 `allow` 规则也不该能把用户关掉的开关重新打开。
 * ★ `deny` 桶排第二，**在钩子之前** —— `deny` 是「连档位都放宽不了」的那一层
 *   （见 `shared/domain/local-settings.ts` 文件头），一条钩子不该能把它打开。
 *   而且命中时钩子**根本不会被执行**：既然结论已经定了，就没有理由再去
 *   fork 一个进程跑用户的脚本。
 */
export function decideBeforeHooks(gate: GateOutcome, denyRule: string | null): EarlyDecision {
  if (gate.kind === 'deny') return { kind: 'deny', reason: gate.reason }
  if (denyRule !== null) {
    return {
      kind: 'deny',
      reason:
        `This call matches the deny rule \`${denyRule}\` in the workspace's ` +
        '.next-cowork/settings.local.json. Do not try to reach the same result through another tool.'
    }
  }
  return { kind: 'continue' }
}

/**
 * 钩子**之后**的其余各层。
 *
 * 优先级（高 → 低）：
 *
 * 1. **钩子 deny** —— 排在 `allow` 桶之前，否则用户点过一次「以后都允许」，
 *    就等于永久绕开了所有安全钩子。
 * 2. **强制问人**（钩子 ask 或 `ask` 桶）—— 它的用处正是把某个本来会静默放行的
 *    操作重新捞回人眼前，所以压过 allow 与档位。
 * 3. **钩子 allow** → 放行。
 * 4. **档位放行** / **`allow` 桶** → 放行。
 * 5. `auto` 档 + 破坏性 → AI 审核。
 * 6. 其余 → 问人。
 */
export function decideAfterHooks(input: {
  gate: GateOutcome
  hook: HookVerdict
  askRule: string | null
  allowRule: string | null
  /** `auto` 档且这个工具是破坏性的。 */
  autoReview: boolean
}): FinalDecision {
  const { gate, hook, askRule, allowRule, autoReview } = input

  if (hook.deny !== undefined) return { kind: 'deny', reason: hook.deny }

  const forcedAsk = hook.ask || askRule !== null
  if (!forcedAsk) {
    if (hook.allow) return { kind: 'allow' }
    if (gate.kind === 'allow') return { kind: 'allow' }
    if (allowRule !== null) return { kind: 'allow' }
  }

  if (autoReview && !forcedAsk) return { kind: 'review' }
  return { kind: 'prompt' }
}
