/**
 * 前置块 ⇄ 表单的双向映射 —— 纯函数，理由同 `shared/filter.ts`（`.tsx` 测不到）。
 *
 * ★ 核心约束:**表单只覆盖它认识的那几个键，其余原样带回去**。
 *   从 Claude Code 粘过来的 agent 文件里常有 `color: blue` 这类键，
 *   编辑一次就把它抹掉，是那种当场看不出、以后也想不起来为什么没了的损坏。
 */
import type { MarkdownResourceKind } from '../../../../../shared/domain/markdown-resource'

export type Frontmatter = Record<string, string | string[]>

/** 表单直接管的键。不在这张表里的一律原样透传。 */
export const FORM_KEYS: Record<MarkdownResourceKind, readonly string[]> = {
  command: ['description', 'argument-hint'],
  agent: ['name', 'description', 'tools', 'model', 'permissionMode']
}

export function readField(fm: Frontmatter, key: string): string {
  const v = fm[key]
  if (typeof v === 'string') return v
  return Array.isArray(v) ? v.join(', ') : ''
}

export function readListField(fm: Frontmatter, key: string): string[] {
  const v = fm[key]
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return []
}

/**
 * 改一个标量字段。空串 = 删掉这个键，而不是写一个空值 ——
 * `description:` 空着会被解析器当成「块式序列的头」，形状就变了。
 */
export function setField(fm: Frontmatter, key: string, value: string): Frontmatter {
  const next = { ...fm }
  if (value.trim() === '') delete next[key]
  else next[key] = value
  return next
}

/** 改一个列表字段。空列表同样删键。 */
export function setListField(fm: Frontmatter, key: string, value: readonly string[]): Frontmatter {
  const next = { ...fm }
  if (value.length === 0) delete next[key]
  else next[key] = [...value]
  return next
}

/**
 * 保存前的校验。
 *
 * ★ 子代理缺 `description` 必须在这里拦下 —— `agent/load.ts` 会把没有 description
 *   的整条作废，让用户存完之后发现子代理**消失了**，而界面上什么也没说。
 */
export function validate(kind: MarkdownResourceKind, fm: Frontmatter, body: string): string | null {
  if (body.trim() === '') return 'ext.error.emptyBody'
  if (kind === 'agent' && readField(fm, 'description').trim() === '') return 'ext.error.agentNeedsDescription'
  return null
}
