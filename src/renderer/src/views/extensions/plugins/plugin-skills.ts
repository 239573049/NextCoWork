/**
 * 「这个插件现在提供了哪几条 Skill」—— 纯函数,从 Skill 列表里反查。
 *
 * ## 为什么是反查,而不是读插件自己的清单
 *
 * `manifest.contributes.skills` 说的是「我声明了这几个目录」,而界面要回答的是
 * 「模型现在看得见哪几条」。两者在几种很常见的情况下不同,且每一种都**只能**
 * 从 Skill 那一侧看出来:
 *
 * - 某个目录的 `SKILL.md` 缺 `description` → 整条作废(`kernel/skill/load.ts`);
 * - 两个插件撞了同一个名字 → 后来的那条被跳过;
 * - 用户自己在全局或项目里写了同名 skill → 插件那条被覆盖(插件优先级最低);
 * - frontmatter 里的 `name` 和目录名不一致 → 显示的名字不是目录名。
 *
 * 照清单画的话,详情页会信誓旦旦地列出一条模型根本看不见的 skill,
 * 而作者和用户都没有任何线索。
 *
 * ## 为什么值得单独一个文件
 *
 * 这几条规则是**断言**,不是渲染。抽出来之后它们能被直接测到
 * (`__tests__/plugin-skills.test.ts`),而埋在组件里就只能起 Electron 才测得了。
 * 同 `thread-content.ts` / `dock-layout.ts`,是这个仓库的既有做法。
 */
import type { SkillListItem } from '../../../../../shared/domain/skill'

/** 详情页要显示的一条。 */
export interface PluginSkillRow {
  id: string
  name: string
  description: string
  /**
   * 这一刻模型是不是真的能用它。
   *
   * ★ 两个开关都要满足:用户可能在 Skill 页上单独关掉了某一条
   * (`globalEnabled`),也可能这个工作区没选它(`activeInWorkspace`)。
   * 不显示这个状态的话,用户会在插件页看到「提供了 pdf-tools」、
   * 却发现模型从来不用它,而原因在另一个页面上。
   */
  active: boolean
  /**
   * 它是从哪个包内目录来的(只取最后一段,如 `pdf-tools`)。
   *
   * ★ 存在的理由只有一个:`missingPluginSkills` 要拿它和清单比对。
   * 用**名字**比是错的 —— frontmatter 里的 `name` 可以和目录名不一样
   * (扫描器允许,只是记一条诊断),那种插件的每一条 skill 都会被误报成「缺失」。
   */
  dirName: string
}

/**
 * 从完整 Skill 列表里挑出这个插件贡献的那几条。
 *
 * 按名字排序 —— 列表本身的顺序来自扫描器(插件先、全局后),
 * 照搬的话同一个插件的几条 skill 在界面上的相对位置会随别人的安装而变。
 */
export function pluginSkillRows(items: readonly SkillListItem[], pluginId: string): PluginSkillRow[] {
  return items
    .filter((item) => item.pluginId === pluginId)
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      active: item.globalEnabled && item.activeInWorkspace,
      dirName: lastSegment(item.sourcePath ?? '')
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 声明了、但**没有**出现在 Skill 列表里的那几个目录。
 *
 * ★ 这个函数存在的全部意义是让「静默消失」变得看得见。上面那几种失败
 * (缺 description、撞名、被用户的同名 skill 覆盖)的共同表现都是
 * 「插件说有,列表里没有」,而在此之前没有任何界面提过这件事 ——
 * 作者只能一个个去试。
 *
 * ★ 比的是**目录**不是名字,理由见 `PluginSkillRow.dirName`。
 */
export function missingPluginSkills(
  declaredPaths: readonly string[],
  rows: readonly PluginSkillRow[]
): string[] {
  const present = new Set(rows.map((row) => row.dirName).filter((name) => name !== ''))
  return declaredPaths
    .map((path) => lastSegment(path))
    .filter((name) => name !== '' && !present.has(name))
}

/** 末段目录名。同时认 `/` 和 `\` —— `sourcePath` 在 Windows 上是反斜杠的。 */
function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}
