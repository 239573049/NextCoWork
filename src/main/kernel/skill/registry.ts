/**
 * Skill 注册表 —— 进程内那份「现在装了哪些 Skill」。
 *
 * 和 `ToolRegistry` 的区别在于**它可以整体换掉**:工具的名字映射必须在会话内
 * 稳定(转录里存的是 externalName,见 `tool/naming.ts`),而 Skill 没有这个约束 ——
 * 一条 Skill 的正文只在 `tool_result` 里出现过一次,重扫之后换了内容也不会
 * 让历史转录变得不自洽。所以这里是 `replaceAll`,不是逐条 upsert。
 */
import type { Skill } from '../../../shared/domain/skill'
import type { SkillDiagnostic, SkillScanResult } from './load'

export class SkillRegistry {
  private skills: readonly Skill[] = []
  private diags: readonly SkillDiagnostic[] = []

  replaceAll(result: SkillScanResult): void {
    // 按名字排一下:目录里的顺序会直接变成系统提示词里的顺序,
    // 而目录遍历的顺序在不同平台上不一样 —— 那会让提示词前缀无谓地抖动,
    // 进而让上游的 prompt cache 失效。
    this.skills = [...result.skills].sort((a, b) => a.name.localeCompare(b.name))
    this.diags = result.diagnostics
  }

  list(): readonly Skill[] {
    return this.skills
  }

  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name)
  }

  diagnostics(): readonly SkillDiagnostic[] {
    return this.diags
  }

  /**
   * 把工作区的启用清单解析成真正要下发的那几条。
   *
   * ★ **空清单 = 全部可用**,不是「一条都不可用」。
   *
   * `DEFAULT_WORKSPACE_SETTINGS.activeSkillIds` 出厂就是 `[]`,按字面理解
   * 就是「新建的工作区里所有 Skill 都不生效」—— 那样用户装完 Skill、
   * 在界面上看见它、然后发现模型完全没反应,而没有任何地方提示开关在哪。
   * 渐进披露之后每条 Skill 在提示词里只占一行,没有任何成本上的理由默认关掉。
   * 于是这里的语义是:**列了就是白名单,没列就是全都要**。
   */
  resolve(ids: readonly string[] | undefined, mode: 'all' | 'explicit' = 'all'): readonly Skill[] {
    if (ids === undefined) return this.skills
    if (ids.length === 0) return mode === 'explicit' ? [] : this.skills
    const want = new Set(ids)
    return this.skills.filter((s) => want.has(s.id))
  }
}

let singleton: SkillRegistry | null = null

/** 进程内单例。和 `getTools()` 同一个惯例。 */
export function skillRegistry(): SkillRegistry {
  singleton ??= new SkillRegistry()
  return singleton
}
