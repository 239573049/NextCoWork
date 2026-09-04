/**
 * 子代理定义 —— 照搬 Claude Code 的 `agents/*.md`。
 *
 * ```
 * <appData>/agents/<name>.md                      全局
 * <workspaceRoot>/.next-cowork/agents/<name>.md  项目(同名时项目胜出)
 * ```
 *
 * ★ 和 Skill 的**不对称是有意的**:Skill 是 `skills/<name>/SKILL.md`(一个目录,
 * 能带脚本、模板、参考资料),子代理是 `agents/<name>.md`(单文件,不带资产)。
 * 一个子代理需要的全部东西就是「你是谁 + 你能用哪些工具」,没有可随身携带的素材。
 * 这是 CC 的实际形状,照搬 —— 用户会把 CC 的 agent 文件原样拖过来。
 *
 * ★ 类型住在 `shared/` 而不是 `main/kernel/agent/`:渲染层要在子代理卡片上
 * 显示名字和描述,而 `shared → main` 这个方向是禁止的。
 */
import type { PermissionMode } from '../agent/permission'

/** 定义从哪儿来的。`builtin` 那一支写死在代码里,不落盘 —— 理由见 `agent/builtin.ts`。 */
export type AgentSourceKind = 'builtin' | 'global' | 'project'

export interface AgentDefinition {
  /** `subagent_type` 入参里写的就是它 */
  name: string
  /**
   * 给**模型**看的,不是给用户看的。
   *
   * ★ 它会逐字进 `Task` 工具的 description —— 模型判断「这个活该派给谁」
   * 唯一的依据就是这一行。写成「代码审查代理」不如写成
   * 「审查刚写完的代码,找出 bug 与风格问题。写完一段代码之后主动用它」。
   */
  description: string
  /** 正文 = 角色提示词。**追加**在 `BASE_PROMPT` 之后,不替换它。 */
  prompt: string
  /**
   * 允许用的工具。**省略 = 继承主 run 的全部工具**(和 CC 一致)。
   *
   * ★ 存的是**归一化之后**的 internalId,不是文件里的原文 —— 归一化发生在
   * 加载期(`agent/tool-alias.ts`),不是使用期。放到使用期做的话,
   * 一个认不出的名字要到子代理真的跑起来才暴露,而那时它已经带着
   * 一张空工具表在自信地编答案了。
   */
  tools?: string[]
  /** ModelAlias.alias。省略 = 继承父 run 的模型。 */
  model?: string
  /**
   * 子代理自己的权限档位。★ 最终档位是 `min(父档位, 这个)` ——
   * 它只能**收窄**,永远不能放宽(见 `minPermission` 的注释)。
   */
  permissionMode?: PermissionMode
  source: { kind: AgentSourceKind; path: string }
}

/** 和 `SKILL_NAME_RE` 同一个形状,同一个理由:名字会进提示词、会被模型原样当入参回传。 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 描述的上限。★ 比 Skill 的 1024 小一半:每条子代理的描述都进
 * **`Task` 工具的 description**,而工具定义每一轮都重发。
 */
export const AGENT_DESCRIPTION_MAX = 512

/** 角色提示词的上限。它每轮进系统提示词,和 Skill 正文不同 —— 后者只出现一次。 */
export const AGENT_PROMPT_MAX = 16 * 1024
