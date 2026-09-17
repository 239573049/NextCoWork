/**
 * Skill 注册表 —— 进程内那份「现在装了哪些 Skill」。
 *
 * 和 `ToolRegistry` 的区别在于**它可以整体换掉**:工具的名字映射必须在会话内
 * 稳定(转录里存的是 externalName,见 `tool/naming.ts`),而 Skill 没有这个约束 ——
 * 一条 Skill 的正文只在 `tool_result` 里出现过一次,重扫之后换了内容也不会
 * 让历史转录变得不自洽。所以这里是 `replaceAll`,不是逐条 upsert。
 */
import type { Skill } from '../../../shared/domain/skill'
import { RegistryBuckets } from '../registry-buckets'
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

/**
 * **每个工作区一份。**
 *
 * ★ 参数**没有默认值**,是故意的:少传一个参数就是一次静默串味(拿到的是
 * 另一个工作区扫出来的目录),而那种错误没有任何症状。让编译器来找调用方,
 * 比让用户在提示词里发现 Skill 不对要早得多。
 *
 * 「不属于任何工作区」的场景(没开工作区、无头测试)传 `''`。
 * 分桶与淘汰规则见 `kernel/registry-buckets.ts`。
 */
const buckets = new RegistryBuckets(() => new SkillRegistry())

export function skillRegistry(workspaceId: string): SkillRegistry {
  return buckets.get(workspaceId)
}

/** 工作区被移除时调。 */
export function dropSkillRegistry(workspaceId: string): void {
  buckets.drop(workspaceId)
}

/**
 * 全部丢掉 —— 切换配置作用域(换账户)时必须调,否则上一个账户的文件根里
 * 扫出来的 Skill 会留在某个桶里。测试之间也用它复位。
 */
export function resetSkillRegistries(): void {
  buckets.clear()
}
