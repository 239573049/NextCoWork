/**
 * 子代理注册表 —— 进程内那份「现在有哪些子代理可派」。
 *
 * 和 `SkillRegistry` 同一个形状(可整体替换、按名字取、带诊断),差别有两处:
 *
 * 1. **没有 `resolve()`。** Skill 有「这个工作区启用了哪几条」的选装清单;
 *    子代理没有 —— 它不进系统提示词,只在模型**主动**派活时才被用到,
 *    多一个可选的子代理的成本就是 `Task` description 里多一行。
 * 2. **出厂就非空。** 构造时先装上内建的那条(`BUILTIN_AGENTS`),于是
 *    「至少有一个子代理可派」在**任何时刻**都成立,包括第一次扫描发生之前。
 *    ★ 这一点是有意的:`Task` 工具的 description 是在**注册时**拼出来的,
 *    而 `builtinTools()` 的注册发生在第一次扫描之前 —— 不预置的话,
 *    第一份 description 里会写着「当前没有任何可用的子代理」。
 */
import type { AgentDefinition } from '../../../shared/domain/agent-def'
import { BUILTIN_AGENTS } from './builtin'
import type { AgentDiagnostic, AgentScanResult } from './load'

export class AgentRegistry {
  private agents: readonly AgentDefinition[] = sortAgents(BUILTIN_AGENTS)
  private diags: readonly AgentDiagnostic[] = []

  replaceAll(result: AgentScanResult): void {
    this.agents = sortAgents(result.agents)
    this.diags = result.diagnostics
  }

  list(): readonly AgentDefinition[] {
    return this.agents
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.find((a) => a.name === name)
  }

  names(): string[] {
    return this.agents.map((a) => a.name)
  }

  diagnostics(): readonly AgentDiagnostic[] {
    return this.diags
  }
}

/**
 * 内建的排在最前(内建之间按 `BUILTIN_AGENTS` 的书写顺序),其余按名字。
 *
 * 排序本身是**必需**的(不是整洁癖):这个顺序会原样变成 `Task` 工具
 * description 里那份清单的顺序,而目录遍历的顺序在不同平台上不一样 ——
 * 那会让工具定义无谓地抖动,进而让上游的 prompt cache 失效。
 *
 * 内建优先则是给模型看的:`general-purpose` 是它在拿不准时该选的那个,
 * 排在第一行比排在字母序中间更容易被选中。
 *
 * ★ 内建之间**不能**按名字排 —— 那正是这一条会悄悄失效的地方:内建里三条是
 *   `code-*` 开头,字母序会把 `general-purpose` 推到第四行,而「拿不准就选它」
 *   这条规矩在清单里没有任何别的载体,它靠的就是排在第一行。
 *
 * ★ 用户可以用同名文件覆盖一条内建(`load.ts` 里那个 `byName`),覆盖之后
 *   `source.kind` 就不是 `builtin` 了 —— 于是它按名字排进后半段,这是对的:
 *   那已经是用户自己的子代理,不该再占着「模型该优先看的那几行」。
 */
const BUILTIN_ORDER = new Map(BUILTIN_AGENTS.map((a, index) => [a.name, index]))

function sortAgents(list: readonly AgentDefinition[]): readonly AgentDefinition[] {
  return [...list].sort((a, b) => {
    const ab = a.source.kind === 'builtin' ? 0 : 1
    const bb = b.source.kind === 'builtin' ? 0 : 1
    if (ab !== bb) return ab - bb
    if (ab === 1) return a.name.localeCompare(b.name)
    // 两条都是内建 —— 认不出的(理论上不存在)排到已知的后面,而不是插进中间。
    return (BUILTIN_ORDER.get(a.name) ?? Number.MAX_SAFE_INTEGER)
      - (BUILTIN_ORDER.get(b.name) ?? Number.MAX_SAFE_INTEGER)
  })
}

let singleton: AgentRegistry | null = null

/** 进程内单例。和 `skillRegistry()` / `getTools()` 同一个惯例。 */
export function agentRegistry(): AgentRegistry {
  singleton ??= new AgentRegistry()
  return singleton
}
