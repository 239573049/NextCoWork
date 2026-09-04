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
 * 内建的排在最前,其余按名字。
 *
 * 排序本身是**必需**的(不是整洁癖):这个顺序会原样变成 `Task` 工具
 * description 里那份清单的顺序,而目录遍历的顺序在不同平台上不一样 ——
 * 那会让工具定义无谓地抖动,进而让上游的 prompt cache 失效。
 *
 * 内建优先则是给模型看的:`general-purpose` 是它在拿不准时该选的那个,
 * 排在第一行比排在字母序中间更容易被选中。
 */
function sortAgents(list: readonly AgentDefinition[]): readonly AgentDefinition[] {
  return [...list].sort((a, b) => {
    const ab = a.source.kind === 'builtin' ? 0 : 1
    const bb = b.source.kind === 'builtin' ? 0 : 1
    return ab !== bb ? ab - bb : a.name.localeCompare(b.name)
  })
}

let singleton: AgentRegistry | null = null

/** 进程内单例。和 `skillRegistry()` / `getTools()` 同一个惯例。 */
export function agentRegistry(): AgentRegistry {
  singleton ??= new AgentRegistry()
  return singleton
}
