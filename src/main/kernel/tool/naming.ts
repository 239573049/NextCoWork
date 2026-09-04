/**
 * 工具的第二个名字 —— 方案 §4.3。
 *
 * Anthropic 把工具名限制在 `^[a-zA-Z0-9_-]{1,64}$`。
 * `mcp__github-enterprise-internal__create_pull_request_review_comment` 是 66 字符,
 * 换来一个只说「invalid tool name」的 400 —— 而那时你会先怀疑自己的 schema。
 *
 * ★ 映射**必须在一次会话内稳定**:已落盘的转录里存的是当时那个 externalName,
 * 重启后如果同一个工具算出别的名字,历史里的 tool_use / tool_result 就再也配不上了。
 * 所以哈希取自 `internalId`(不变量),不取自注册顺序或时间。
 */
import { DESCRIPTION_MAX, EXTERNAL_NAME_MAX, EXTERNAL_NAME_RE } from '../../../shared/agent/tool'
import { clampWithEllipsis, stripControlChars } from '../text'

/**
 * FNV-1a 32 位,手写。
 *
 * ★ 刻意不 `import { createHash } from 'node:crypto'` —— 内核要能在任意 JS 运行时里跑
 * (方案 §2 的「零 electron import」是同一条理由的延伸:依赖越少,能跑单测的地方越多)。
 * 这里的哈希只用来**去重**,不涉及任何安全属性,FNV 完全够。
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 乘 16777619,用移位避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 消毒:非法字符 → `_`。
 *
 * ⚠️ 输入是**不可信的**(MCP server 和 Skill 自己声明的名字,方案 §4.4)。
 * 白名单而不是黑名单 —— 黑名单在这里必然漏。
 */
export function sanitizeToolName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_')
  // 三个以上的下划线压成两个:保住 MCP 的 `mcp__server__tool` 分隔约定,
  // 又不至于让一个全是中文的工具名变成 40 个下划线
  const collapsed = cleaned.replace(/_{3,}/g, '__')
  return collapsed === '' ? 'tool' : collapsed
}

/**
 * ⚠️ 描述同样是不可信输入,而且它**直接进系统提示词** —— 这正是工具投毒的入口。
 *
 * 长度限制拦不住投毒(那要靠权限层),但能拦住「一个 MCP server 用 200KB 描述
 * 把上下文窗口挤爆」这种既可能是攻击、也可能只是 bug 的情况。
 * 控制字符的削法与 Skill 正文共用一份(`../text`),理由见那里。
 */
export function sanitizeDescription(raw: string): string {
  return clampWithEllipsis(stripControlChars(raw), DESCRIPTION_MAX)
}

/** 8 位哈希 + 一个下划线 */
const SUFFIX_LEN = 9

/**
 * internalId → externalName 的稳定分配器。
 *
 * ★ 分配过的名字**永不回收**,即使工具被 unregister。
 * 理由是转录:一个 MCP server 断开后,历史里那条 tool_use 仍然引用着旧名字,
 * 而用户可能正要 attach 上去看它。回收了就意味着同一个名字在一次会话里
 * 先后指向两个不同的工具 —— 那种 bug 查起来毫无线索。
 */
export class ToolNamer {
  private readonly byInternal = new Map<string, string>()
  private readonly byExternal = new Map<string, string>()

  /** 同一个 internalId 永远得到同一个名字 */
  nameFor(internalId: string): string {
    const existing = this.byInternal.get(internalId)
    if (existing !== undefined) return existing

    const base = sanitizeToolName(internalId)
    const name = this.allocate(base, internalId)
    this.byInternal.set(internalId, name)
    this.byExternal.set(name, internalId)
    return name
  }

  /** externalName → internalId。名字不回收,所以已下线的工具也查得到。 */
  toInternal(externalName: string): string | undefined {
    return this.byExternal.get(externalName)
  }

  private allocate(base: string, internalId: string): string {
    if (base.length <= EXTERNAL_NAME_MAX && !this.byExternal.has(base)) return base

    const hash = fnv1a32(internalId)
    const head = base.slice(0, EXTERNAL_NAME_MAX - SUFFIX_LEN)
    const withHash = `${head}_${hash}`
    if (!this.byExternal.has(withHash)) return withHash

    // 走到这里要么是 FNV 撞了,要么是同一个 internalId 被并发分配 ——
    // 都极罕见,但「极罕见」不等于「不会发生」,而静默返回一个重名会让
    // 两个工具在模型眼里合二为一。加一个计数器,永远能收敛。
    for (let i = 1; i < 1000; i++) {
      const suffix = `_${i}`
      const cand = `${withHash.slice(0, EXTERNAL_NAME_MAX - suffix.length)}${suffix}`
      if (!this.byExternal.has(cand)) return cand
    }
    /* c8 ignore next */
    throw new Error(`无法为 ${internalId} 分配唯一的 externalName`)
  }
}

/** 自检用:注册表在每次分配后断言一次,把「不合法的名字」挡在发请求之前 */
export function isValidExternalName(name: string): boolean {
  return EXTERNAL_NAME_RE.test(name)
}
