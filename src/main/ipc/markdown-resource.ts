/**
 * 命令 / 子代理的**编辑** handler —— 扩展面板里那个编辑器的接线员。
 *
 * 分工同 `ipc/skills.ts`:解析与序列化在内核(`kernel/markdown-resource.ts`,
 * 那一侧不认识 electron),这里只做四件事 —— 算路径、挡越界、写盘、广播。
 *
 * ★ 命令和子代理共用这一份。它们在磁盘上是同构的(两层目录、`<name>.md`、
 *   frontmatter + 正文),差别只有目录名、文件名正则和前置块的键序 ——
 *   那三样做成参数,比复制两份几乎一样的读写逻辑要稳:一份里修了路径校验
 *   而另一份忘了,是这类重复代码最典型的下场。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { AGENT_NAME_RE } from '../../shared/domain/agent-def'
import { COMMAND_NAME_RE } from '../../shared/domain/command'
import { EnvironmentError } from '../environment/errors'
import { EnvironmentFiles } from '../environment/files'
import type {
  MarkdownResourceFile,
  MarkdownResourceKind,
  MarkdownResourceSave,
  MarkdownResourceScope
} from '../../shared/domain/markdown-resource'
import {
  readResourceFile,
  renderResourceFile,
  writeResourceFile
} from '../kernel/markdown-resource'
import { getEnvironments, getHost, getWorkspaceEnvironment } from '../runtime'
import { windows } from '../window/registry'

interface KindSpec {
  /** `<appData>/<dir>/` 与 `<workspaceRoot>/.next-cowork/<dir>/` */
  dir: string
  nameRe: RegExp
  changedChannel: 'commands:changed' | 'agents:changed'
}

const SPEC: Record<MarkdownResourceKind, KindSpec> = {
  command: { dir: 'commands', nameRe: COMMAND_NAME_RE, changedChannel: 'commands:changed' },
  agent: { dir: 'agents', nameRe: AGENT_NAME_RE, changedChannel: 'agents:changed' }
}

export function broadcastResourceChanged(kind: MarkdownResourceKind): void {
  windows.emitToAll(SPEC[kind].changedChannel, undefined)
}

/**
 * 算出资源目录的根。
 *
 * ★ 项目级走 `environment.path.resolveWithin`,不是 `node:path.join` ——
 *   远程工作区的路径在远端主机上,拼本地路径拿到的是一个不存在的位置。
 */
async function resourceRoot(
  kind: MarkdownResourceKind,
  scope: MarkdownResourceScope,
  workspaceId?: string
): Promise<string> {
  if (scope === 'project') {
    if (!workspaceId) throw new EnvironmentError('unbound')
    const environment = getWorkspaceEnvironment(workspaceId)
    return environment.path.resolveWithin(environment.rootPath, `.next-cowork/${SPEC[kind].dir}`)
  }
  return join(getHost().paths.userData(), SPEC[kind].dir)
}

/**
 * 名字 → 绝对路径。
 *
 * ★ `name` 来自渲染层,是**不可信输入**。两道闸都必须在:
 *   1. 正则:挡掉 `../`、绝对路径、空串、超长
 *   2. `resolveWithin`:挡掉软链逃逸(正则过得去的名字也可能落在目录外)
 *   少任何一道,一次「删除」就能删到工作区外面去。
 */
async function resourcePath(
  kind: MarkdownResourceKind,
  scope: MarkdownResourceScope,
  name: string,
  workspaceId?: string
): Promise<{ file: string; root: string }> {
  if (!SPEC[kind].nameRe.test(name)) throw new Error('名字不合法')
  const root = await resourceRoot(kind, scope, workspaceId)
  if (scope === 'project' && workspaceId) {
    const environment = getWorkspaceEnvironment(workspaceId)
    return { file: await environment.path.resolveWithin(root, `${name}.md`), root }
  }
  // 全局层没有 WorkspacePaths，自己拼 + 落盘前再用 realpath 复核（见 assertInside）。
  return { file: join(root, `${name}.md`), root }
}

/** 项目级且远程时用环境的 fs，其余用宿主的。 */
function fsFor(scope: MarkdownResourceScope, workspaceId?: string): ReturnType<typeof getHost>['fs'] {
  if (scope !== 'project' || !workspaceId) return getHost().fs
  const environment = getWorkspaceEnvironment(workspaceId)
  return environment.remote ? environment.fs : getHost().fs
}

export async function getResource(req: {
  kind: MarkdownResourceKind
  scope: MarkdownResourceScope
  name: string
  workspaceId?: string
}): Promise<MarkdownResourceFile> {
  const { file } = await resourcePath(req.kind, req.scope, req.name, req.workspaceId)
  const content = await readResourceFile(fsFor(req.scope, req.workspaceId), file)
  if (content === null) throw new Error('文件不存在')
  return { kind: req.kind, scope: req.scope, name: req.name, path: file, ...content }
}

export async function saveResource(req: MarkdownResourceSave): Promise<MarkdownResourceFile> {
  const { file } = await resourcePath(req.kind, req.scope, req.name, req.workspaceId)
  const fs = fsFor(req.scope, req.workspaceId)
  const text = renderResourceFile(req.kind, req.frontmatter, req.body)

  const outcome = await writeResourceFile(fs, file, text, req.revision)
  if (!outcome.ok) {
    throw new Error(
      outcome.reason === 'conflict'
        ? '文件已被改动，请重新打开再保存'
        : '写入失败'
    )
  }
  broadcastResourceChanged(req.kind)

  const content = await readResourceFile(fs, file)
  if (content === null) throw new Error('写完却读不回来')
  return { kind: req.kind, scope: req.scope, name: req.name, path: file, ...content }
}

export async function deleteResource(req: {
  kind: MarkdownResourceKind
  scope: MarkdownResourceScope
  name: string
  workspaceId?: string
}): Promise<void> {
  const { file, root } = await resourcePath(req.kind, req.scope, req.name, req.workspaceId)

  if (req.scope === 'project' && req.workspaceId) {
    const lease = getEnvironments().acquire(req.workspaceId)
    try {
      if (lease.environment.remote) {
        await new EnvironmentFiles(lease.environment).mutate({
          workspaceId: req.workspaceId,
          path: file,
          operation: 'delete'
        })
        broadcastResourceChanged(req.kind)
        return
      }
    } finally {
      lease.release()
    }
  }

  /*
    ★ 删之前再用 `realpath` 复核一次落点。正则和 `resolveWithin` 挡的是
    「名字」，而这一步挡的是「文件本身是个软链」—— `commands/x.md -> ~/.ssh/id_rsa`
    在前两道闸下都是合法的，只有解析真实路径才看得出来。
    照搬 `skills.ts` 卸载那段已有的正确答案。
  */
  const resolved = await nodeFs.realpath(file).catch(() => file)
  const realRoot = await nodeFs.realpath(root).catch(() => root)
  if (!resolved.startsWith(realRoot + '/')) throw new Error('文件位置无效')
  await nodeFs.rm(resolved, { force: true })
  broadcastResourceChanged(req.kind)
}
