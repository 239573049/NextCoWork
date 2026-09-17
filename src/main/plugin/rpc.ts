/**
 * 能力实现 —— **四道门的最后两道**在这里落地。
 *
 * 每个 handler 的形状都一样:
 *
 * ```
 * 参数门(narrowXxx,纯函数,capabilities.ts)
 *   → realpath 归一 / 逐 URL 校验(这里,要碰文件系统)
 *     → KernelHost(fs / spawn / fetch / secrets)
 *       → 剥成数据回传(不传句柄、不传流、不传 fd)
 * ```
 *
 * ★ **最后一步不是修辞。** 插件拿到的永远是 `string` / `number` / 普通对象。
 * 给出去一个 `ReadStream` 或者一个 `ChildProcess`,后面所有的门就都成了摆设 ——
 * 它可以在那个对象上直接继续操作,而那条路上没有任何检查。
 */
import type { KernelHost } from '../kernel/host'
import { quoteShellArg } from '../kernel/node-spawn'
import type { PluginMethod, PluginParams } from '../../shared/plugin/protocol'
import { PLUGIN_STORAGE_QUOTA_BYTES } from '../../shared/plugin/protocol'
import type { PluginManifest } from '../../shared/plugin/manifest'
import {
  MAX_PLUGIN_FILE_BYTES,
  narrowCommand,
  narrowFetchUrl,
  narrowStorageKey,
  narrowWorkspacePath,
  secretKeyFor
} from './capabilities'

/** 一次调用的上下文。**没有 iframe、没有 port** —— 这一层不知道插件跑在哪。 */
export interface CapabilityContext {
  pluginId: string
  manifest: PluginManifest
  host: KernelHost
  /** 当前工作区根。空串 = 没有打开工作区,路径类能力一律拒绝 */
  workspaceRoot: string
  workspaceId: string
  /** 清单里可选的命令白名单 —— 没有就等于一条都不许跑 */
  allowedCommands: readonly string[]
  /** 走既有八层权限链。`false` = 用户拒了 */
  approve: (summary: { kind: 'write' | 'exec'; detail: string }) => Promise<boolean>
  kv: {
    get(key: string): string | null
    set(key: string, value: string | null): void
    keys(): string[]
    usedBytes(): number
  }
}

export class CapabilityError extends Error {
  constructor(readonly code: 'invalid_argument' | 'rejected' | 'internal_error', message: string) {
    super(message)
    this.name = 'CapabilityError'
  }
}

function invalid(message: string): never {
  throw new CapabilityError('invalid_argument', message)
}

function rejected(message: string): never {
  throw new CapabilityError('rejected', message)
}

/** 一条活动日志的摘要。**不含参数原文** —— 见 `diagnostics.ts`。 */
export interface CapabilityOutcome {
  data: unknown
  summary: string
}

export async function invokeCapability<M extends PluginMethod>(
  method: M,
  params: PluginParams<M>,
  ctx: CapabilityContext
): Promise<CapabilityOutcome> {
  switch (method) {
    case 'env.appInfo':
      return { data: { appName: 'NextCoWork', appVersion: appVersion(), language: 'zh-CN' }, summary: 'appInfo' }

    case 'workspace.folders':
      return {
        data: {
          folders: ctx.workspaceRoot === ''
            ? []
            : [{ id: ctx.workspaceId, name: ctx.workspaceRoot.split(/[\\/]/).pop() ?? '', path: ctx.workspaceRoot }]
        },
        summary: 'workspace.folders'
      }

    case 'workspace.readFile': {
      const p = params as PluginParams<'workspace.readFile'>
      const target = await resolveInside(ctx, p.path)
      const stat = await ctx.host.fs.stat(target).catch(() => null)
      if (stat === null || stat.isDir) invalid(`not a readable file: ${p.path}`)
      if (stat.size > MAX_PLUGIN_FILE_BYTES) invalid('file exceeds the plugin read limit')
      const bytes = await ctx.host.fs.readFileBytes(target, MAX_PLUGIN_FILE_BYTES)
      const data = p.encoding === 'base64'
        ? Buffer.from(bytes).toString('base64')
        : Buffer.from(bytes).toString('utf8')
      return { data: { data, revision: Math.round(stat.mtimeMs) }, summary: `read ${p.path}` }
    }

    case 'workspace.stat': {
      const p = params as PluginParams<'workspace.stat'>
      const target = await resolveInside(ctx, p.path)
      const stat = await ctx.host.fs.stat(target).catch(() => null)
      return {
        data: stat === null
          ? { kind: 'missing', size: 0, mtimeMs: 0 }
          : { kind: stat.isDir ? 'dir' : 'file', size: stat.size, mtimeMs: stat.mtimeMs },
        summary: `stat ${p.path}`
      }
    }

    case 'workspace.writeFile': {
      const p = params as PluginParams<'workspace.writeFile'>
      const target = await resolveInside(ctx, p.path)
      const bytes = p.encoding === 'base64' ? Buffer.from(p.data, 'base64') : Buffer.from(p.data, 'utf8')
      if (bytes.length > MAX_PLUGIN_FILE_BYTES) invalid('payload exceeds the plugin write limit')
      /*
        ★ **乐观锁在权限链之前。** 反过来的话,用户会先看到一个审批弹窗、
        点了允许、然后才被告知「文件已被别人改过,没写成」—— 他为一次注定
        失败的写操作做了一次决定。
      */
      if (p.revision !== undefined) {
        const stat = await ctx.host.fs.stat(target).catch(() => null)
        if (stat !== null && Math.round(stat.mtimeMs) !== p.revision) {
          rejected('the file changed on disk since it was read')
        }
      }
      if (!(await ctx.approve({ kind: 'write', detail: p.path }))) rejected('the write was not approved')
      await ctx.host.fs.mkdirp(target)
      await ctx.host.fs.writeFile(target, bytes.toString('utf8'))
      const after = await ctx.host.fs.stat(target).catch(() => null)
      return { data: { revision: after === null ? 0 : Math.round(after.mtimeMs) }, summary: `write ${p.path}` }
    }

    case 'workspace.deleteFile': {
      const p = params as PluginParams<'workspace.deleteFile'>
      const target = await resolveInside(ctx, p.path)
      if (!(await ctx.approve({ kind: 'write', detail: `delete ${p.path}` }))) rejected('the delete was not approved')
      const { promises: fsp } = await import('node:fs')
      await fsp.rm(target, { force: true })
      return { data: {}, summary: `delete ${p.path}` }
    }

    case 'workspace.findFiles': {
      const p = params as PluginParams<'workspace.findFiles'>
      if (ctx.workspaceRoot === '') invalid('no workspace is open')
      const limit = Math.min(Math.max(1, p.limit ?? 200), 1000)
      const paths = await findFiles(ctx, p.glob, limit)
      return { data: { paths }, summary: `findFiles ${p.glob}` }
    }

    case 'process.exec': {
      const p = params as PluginParams<'process.exec'>
      const narrowed = narrowCommand(ctx.allowedCommands, p.command, p.args)
      if (!narrowed.ok) invalid(narrowed.reason)
      const cwd = p.cwd === undefined ? ctx.workspaceRoot : (await resolveInside(ctx, p.cwd))
      if (cwd === '') invalid('no workspace is open')
      const shell = ctx.host.platform.shell
      const line = `${narrowed.value.command} ${narrowed.value.args.map((arg) => quoteArg(arg, shell)).join(' ')}`.trim()
      if (!(await ctx.approve({ kind: 'exec', detail: line }))) rejected('the command was not approved')
      const controller = new AbortController()
      const timeoutMs = Math.min(Math.max(1000, p.timeoutMs ?? 60_000), 120_000)
      const result = await ctx.host.spawn(line, { cwd, signal: controller.signal, timeoutMs, shell })
      return { data: result, summary: `exec ${narrowed.value.command}` }
    }

    case 'net.fetch': {
      const p = params as PluginParams<'net.fetch'>
      const narrowed = narrowFetchUrl(ctx.manifest.hostPermissions, p.url)
      if (!narrowed.ok) invalid(narrowed.reason)
      const method = (p.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) invalid(`unsupported method: ${method}`)
      const response = await ctx.host.fetch(narrowed.value, {
        method,
        headers: sanitizeHeaders(p.headers),
        ...(p.body === undefined || method === 'GET' || method === 'HEAD' ? {} : { body: p.body })
      })
      const text = await response.text()
      // ★ response 剥成数据回传,不传流句柄。
      return {
        data: {
          status: response.status,
          headers: Object.fromEntries([...response.headers.entries()].slice(0, 64)),
          body: text.length > MAX_PLUGIN_FILE_BYTES ? text.slice(0, MAX_PLUGIN_FILE_BYTES) : text
        },
        summary: `fetch ${new URL(narrowed.value).host}`
      }
    }

    case 'storage.get': {
      const p = params as PluginParams<'storage.get'>
      const key = storageKey(ctx, p.scope, p.key)
      return { data: { value: ctx.kv.get(key) }, summary: `storage.get ${p.key}` }
    }

    case 'storage.set': {
      const p = params as PluginParams<'storage.set'>
      const key = storageKey(ctx, p.scope, p.key)
      if (p.value !== null && ctx.kv.usedBytes() + p.value.length > PLUGIN_STORAGE_QUOTA_BYTES) {
        invalid('plugin storage quota exceeded')
      }
      ctx.kv.set(key, p.value)
      return { data: {}, summary: `storage.set ${p.key}` }
    }

    case 'storage.keys':
      return { data: { keys: ctx.kv.keys() }, summary: 'storage.keys' }

    case 'secrets.get': {
      const p = params as PluginParams<'secrets.get'>
      const key = narrowStorageKey(p.key)
      if (!key.ok) invalid(key.reason)
      const value = await ctx.host.secrets.get(secretKeyFor(ctx.pluginId, key.value))
      return { data: { value }, summary: `secrets.get ${p.key}` }
    }

    case 'secrets.set': {
      const p = params as PluginParams<'secrets.set'>
      const key = narrowStorageKey(p.key)
      if (!key.ok) invalid(key.reason)
      const ref = secretKeyFor(ctx.pluginId, key.value)
      if (p.value === null) await ctx.host.secrets.remove?.(ref)
      else await ctx.host.secrets.set(ref, p.value)
      return { data: {}, summary: `secrets.set ${p.key}` }
    }

    case 'diagnostics.log': {
      const p = params as PluginParams<'diagnostics.log'>
      return { data: {}, summary: `${p.level}: ${p.message.slice(0, 200)}` }
    }

    default:
      throw new CapabilityError('internal_error', `method ${method} has no handler`)
  }
}

/** 词法边界 + realpath 归一。**两层都要**,理由见 `net/attachment-protocol.ts`。 */
async function resolveInside(ctx: CapabilityContext, path: string): Promise<string> {
  const narrowed = narrowWorkspacePath(ctx.workspaceRoot, path)
  if (!narrowed.ok) invalid(narrowed.reason)
  const target = narrowed.value
  /*
    ★ 一路往上找到**最近的存在祖先**,而不是只看父目录。

    文件不存在是常态(第一次写);但它的**父目录也可能不存在** ——
    `drawings/x.excalidraw` 的第一次写入就是这样。只归一父目录的话,
    realpath 对 `<ws>/drawings` 抛 ENOENT,整次写入被判 `invalid_argument`,
    而 `workspace.writeFile` 自己明明紧接着就调 `mkdirp` —— 两边自相矛盾,
    症状是「插件点了没反应」,因为调用方那一侧把 rejection 丢了。

    词法收窄(`narrowWorkspacePath`)已经保证 `target` 在根内,所以这个循环
    最差也会停在根上,不会一路跑到文件系统顶层。
  */
  let probe = target
  for (;;) {
    if (await ctx.host.fs.exists(probe)) break
    const parent = dirnameOf(probe)
    if (parent === probe) invalid(`path cannot be resolved: ${path}`)
    probe = parent
  }
  const real = await ctx.host.fs.realpath(probe).catch(() => null)
  const realRoot = await ctx.host.fs.realpath(ctx.workspaceRoot).catch(() => ctx.workspaceRoot)
  if (real === null) invalid(`path cannot be resolved: ${path}`)
  if (!(real === realRoot || real.startsWith(realRoot + sepOf(realRoot)))) {
    invalid('path escapes the workspace root after resolving symlinks')
  }
  return target
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path : path.slice(0, index)
}

function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/**
 * 只支持前缀 glob(`src/**`、`docs/*.md`),不引 glob 引擎。
 *
 * 理由同 `matchesPathScope`:这条路径上每一次「我以为它匹配不到」都是一次
 * 越界读。要更强的匹配能力时,插件可以自己 `findFiles` 完再过滤。
 */
async function findFiles(ctx: CapabilityContext, glob: string, limit: number): Promise<string[]> {
  const star = glob.indexOf('*')
  const prefix = star === -1 ? glob : glob.slice(0, star)
  const suffix = star === -1 ? '' : glob.slice(glob.lastIndexOf('*') + 1)
  const base = prefix.replace(/\/[^/]*$/, '')
  const root = base === '' ? ctx.workspaceRoot : await resolveInside(ctx, base)
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 8) return
    const entries = await ctx.host.fs.readDir(dir).catch(() => [])
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDir) {
        await walk(`${dir}/${entry.name}`, childRel, depth + 1)
        continue
      }
      const full = base === '' ? childRel : `${base}/${childRel}`
      if (!full.startsWith(prefix)) continue
      if (suffix !== '' && !full.endsWith(suffix)) continue
      out.push(full)
    }
  }
  await walk(root, '', 0)
  return out
}

function storageKey(ctx: CapabilityContext, scope: 'global' | 'workspace', key: string): string {
  const narrowed = narrowStorageKey(key)
  if (!narrowed.ok) invalid(narrowed.reason)
  /*
    ★ 前缀由宿主拼。让插件自己拼等于让它有机会写成别人的前缀,
    而 kv 是一张共用的表 —— 那就是直接读走别的插件的数据。
  */
  return scope === 'workspace'
    ? `plugin:${ctx.pluginId}:ws:${ctx.workspaceId}:${narrowed.value}`
    : `plugin:${ctx.pluginId}:global:${narrowed.value}`
}

/**
 * 请求头白名单。
 *
 * ★ 挡掉 `Authorization` 之外的敏感头没有意义(插件本来就能把 token 放进
 * body),这里挡的是**会影响宿主身份**的那几个:Cookie 会带上宿主会话,
 * Host / Origin / Referer 会让请求看起来来自应用本身。
 */
function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const blocked = new Set(['cookie', 'host', 'origin', 'referer', 'user-agent', 'content-length'])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (blocked.has(key.toLowerCase())) continue
    if (typeof value !== 'string' || value.length > 4096) continue
    out[key] = value
  }
  return out
}

/** argv 按审批时的 shell 引号化；拒绝的参数仍走插件的 invalid_argument 协议。 */
function quoteArg(arg: string, shell: string): string {
  try {
    return quoteShellArg(shell, arg)
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error))
  }
}

function appVersion(): string {
  return process.env.npm_package_version ?? '0.0.0'
}
