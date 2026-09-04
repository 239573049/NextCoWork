/**
 * Skill 注册表 —— 方案 §4.10。界面上是 Anthropic 风格的 Agent Skills:
 * `/name` 调用、分类、从文件夹/zip/git 安装、**按工作区软链启用**。
 */

export type SkillSourceKind = 'builtin' | 'folder' | 'zip' | 'git'

/**
 * 装在哪一层。
 *
 * ★ 和 `SkillSourceKind` 是两个不同的问题:`kind` 说的是**怎么装进来的**
 * (从文件夹、从 zip、从 git),`scope` 说的是**装在哪儿**(全局 / 这个项目)。
 * 同名时项目胜出,靠的是 scope,不是 kind —— 两条都可能是 `folder`。
 */
export type SkillScope = 'global' | 'project'

export interface Skill {
  id: string
  /** `/name` 调用 */
  name: string
  description: string
  /** 开发工具 / 文档助手 / 数据分析 / … */
  category: string
  source: { kind: SkillSourceKind; path: string }
  /** 全局装的还是这个项目里装的。同名时项目胜出。 */
  scope?: SkillScope
  /** 全局开关;还要在工作区里单独启用才生效(界面「Skill 工作区选装模式」) */
  globalEnabled: boolean
  frontmatter: SkillFrontmatter
  /**
   * 注入系统提示词的正文。
   * ⚠️ **Skill 正文是不可信输入**(从 zip/git 装的),与 MCP 同等对待。
   */
  body: string
}

export interface SkillFrontmatter {
  model?: string
  /** 收窄本轮的工具快照 */
  allowedTools?: string[]
}

/**
 * SkillRegistry 唯一的下游是 ContextAssembler ——
 * 正文拼进系统提示词,allowedTools 收窄工具快照。
 */
export interface SkillListItem {
  id: string
  name: string
  description: string
  category: string
  sourceKind: SkillSourceKind
  scope?: SkillScope
  globalEnabled: boolean
  /** 在**当前**工作区是否激活 */
  activeInWorkspace: boolean
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SKILL_BODY_MAX = 64 * 1024
