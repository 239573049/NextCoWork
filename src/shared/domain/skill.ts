/**
 * Skill 注册表 —— 方案 §4.10。界面上是 Anthropic 风格的 Agent Skills:
 * `/name` 调用、分类、从文件夹/zip/git 安装、**按工作区软链启用**。
 */

/**
 * 怎么装进来的。
 *
 * ★ `'plugin'` 和别的几个不是一个层次上的东西:前四种是**用户自己**把一个
 * 目录放进了 skills 根,`'plugin'` 是一个已安装插件在它自己的包里带来的。
 * 区别体现在生命周期上 —— 前四种删了才没,后一种**随插件的启用状态即时增减**,
 * 而且用户不能单独卸载它(卸载入口在插件那边,见 `scope` 上的说明)。
 */
export type SkillSourceKind = 'builtin' | 'folder' | 'zip' | 'git' | 'plugin'

/**
 * 装在哪一层。
 *
 * ★ 和 `SkillSourceKind` 是两个不同的问题:`kind` 说的是**怎么装进来的**
 * (从文件夹、从 zip、从 git),`scope` 说的是**装在哪儿**(全局 / 这个项目)。
 * 同名时项目胜出,靠的是 scope,不是 kind —— 两条都可能是 `folder`。
 *
 * ★ `'plugin'` 是第三层,**优先级最低**:插件带来的 skill 被同名的全局或项目
 * skill 覆盖。需求是「插件提供的是一个合理默认,用户自己写的那条永远说了算」——
 * 反过来的话,用户在 `.next-cowork/skills/` 里放一条同名的覆盖规则会毫无反应,
 * 而界面上两条都在,没有任何地方解释谁生效。
 *
 * ★ 这一层**没有卸载入口**:它的文件在插件包里,删掉就破坏了包的完整性
 * (下次插件更新又会回来)。要让它消失得禁用或卸载那个插件。
 * `views/skills/SkillsFeature.tsx` 据此隐藏卸载按钮 —— 画出来的话,
 * 那个按钮会去删 `<userData>/skills/<name>`,一个根本不存在的路径。
 */
export type SkillScope = 'global' | 'project' | 'plugin'

export interface Skill {
  id: string
  /** `/name` 调用 */
  name: string
  description: string
  /** 开发工具 / 文档助手 / 数据分析 / … */
  category: string
  source: {
    kind: SkillSourceKind
    path: string
    version?: string
    sha256?: string
    /**
     * 哪个插件带来的(`publisher.name`)。只有 `kind === 'plugin'` 时有值。
     *
     * ★ 存 id 而不是存插件的显示名:显示名跟着界面语言走,而这个值会进
     * 诊断文本、会被用来判断「这条 skill 属于哪个插件」。存显示名的话,
     * 切一次语言就对不上了。
     */
    pluginId?: string
  }
  /** 全局装的、这个项目里装的,还是某个插件带来的。同名时 project > global > plugin。 */
  scope?: SkillScope
  /** 全局开关;还要在工作区里单独启用才生效(界面「Skill 工作区选装模式」) */
  globalEnabled: boolean
  unavailableReason?: 'client-assets'
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
  displayName?: string
  description: string
  category: string
  author?: string
  sourceKind: SkillSourceKind
  scope?: SkillScope
  /**
   * 带来这条 skill 的插件(`publisher.name`)。只有 `sourceKind === 'plugin'` 时有值。
   *
   * ★ 界面据此做两件事:标出来源(「来自插件 acme.pdf」),以及**藏掉卸载按钮**。
   * 不给这个字段的话,插件 skill 在列表里和用户自己装的长得一模一样,
   * 而点卸载会去删一个不存在的路径。
   */
  pluginId?: string
  globalEnabled: boolean
  /** 在**当前**工作区是否激活 */
  activeInWorkspace: boolean
  unavailableReason?: 'client-assets'
  /** Local package metadata, when available. */
  version?: string
  sha256?: string
  sourcePath?: string
  usageCount?: number
  lastUsedAt?: number
  diagnostics?: string[]
  downloadCount?: number
  /** Optional marketplace/local icon used by the skills gallery. */
  iconUrl?: string | null
}

export type SkillInstallScope = 'global' | 'project'

export interface SkillMarketItem {
  slug: string
  name: string
  displayName: string
  description: string
  category: string
  iconUrl?: string | null
  author?: string
  version?: string
  sha256?: string
  fileSize?: number
  downloadUrl?: string
  downloadCount?: number
  triggerCount?: number
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SKILL_BODY_MAX = 64 * 1024
