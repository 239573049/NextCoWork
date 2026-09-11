/**
 * 命令 / 子代理的编辑 —— 两者共用，磁盘上它们是同构的。
 * 见 `shared/domain/markdown-resource.ts`。
 */
import type {
  MarkdownResourceFile,
  MarkdownResourceKind,
  MarkdownResourceSave,
  MarkdownResourceScope
} from '../../../shared/domain/markdown-resource'
import { invoke } from './ipc'

export function getResource(
  kind: MarkdownResourceKind,
  scope: MarkdownResourceScope,
  name: string,
  workspaceId?: string
): Promise<MarkdownResourceFile> {
  return invoke('resource:get', { kind, scope, name, ...(workspaceId === undefined ? {} : { workspaceId }) })
}

export function saveResource(req: MarkdownResourceSave): Promise<MarkdownResourceFile> {
  return invoke('resource:save', req)
}

export function deleteResource(
  kind: MarkdownResourceKind,
  scope: MarkdownResourceScope,
  name: string,
  workspaceId?: string
): Promise<void> {
  return invoke('resource:delete', { kind, scope, name, ...(workspaceId === undefined ? {} : { workspaceId }) })
}
