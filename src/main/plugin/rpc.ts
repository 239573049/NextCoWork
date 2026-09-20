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
  /**
   * 跑命令前问用户。`false` = 用户拒了。
   *
   * ★ **只剩 `exec` 一种。** 这里原本还有 `kind: 'write'` —— 写文件和删文件
   * 各自在动手前再弹一次系统确认框。那一问是**冗余**的:调用走到这个 handler
   * 之前,`manager.ts` 的能力门已经查过 `workspace.write` 在不在该插件的
   * `granted` 集合里(见 `PLUGIN_METHOD_PERMISSION` 映射),而那个集合是用户
   * 在插件详情页显式批过、并且落盘在 kv `plugins.state` 里的。再弹一次,
   * 问的是同一个已经回答过的问题 —— 表现就是「每新建一张白板都要批一次」。
   *
   * 留着 `'write'` 这个取值会让下一个人以为写操作还有第二条门。收窄成
   * `'exec'` 之后,类型本身就说明了「只有跑命令还需要逐次问」。
   */
  approve: (summary: { kind: 'exec'; detail: string }) => Promise<boolean>
  /**
   * 把文件挪进系统废纸篓。
   *
   * ★ 由调用方注入而不是在这里 `import { shell } from 'electron'`:这一层现在
   * 只依赖 `KernelHost`,不认识 Electron —— 真去 import 的话,所有能直接构造
   * 一个 ctx 来测的 handler 都会连带需要一份 electron mock。
   */
  trash: (absolutePath: string) => Promise<void>
  /**
   * 交给系统浏览器打开一个网址。
   *
   * 需求:插件最朴素的一种形态就是「把一个网站带进来」,这是其中最轻的一档。
   * 应用内打开走 `tabs.openBrowser`(另有 URL 门),这一条只负责离开应用。
   * 不满足会怎样:`ncw.env.openExternal()` 抛 `internal_error: no handler` ——
   * 而它在 d.ts、垫片、文档里全都存在,作者只会去怀疑自己的打包。
   *
   * ★ 同 `trash`:由调用方注入,这一层不认识 electron。
   */
  openExternal: (url: string) => Promise<void>
  /**
   * 剪贴板。能力门已经查过 `clipboard`,这里只负责落地。
   *
   * ★ 两个方法都是**异步**的:Electron 这一版的 `clipboard` 就是 Promise 形状的。
   * 写成同步会在类型上悄悄拿到一个 `Promise<string>` 当字符串发给插件 ——
   * 症状是插件读到 `{}` 而不是剪贴板内容。
   */
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  /**
   * 版本控制适配器 —— **已经绑好当前工作区**。
   *
   * ★ 注入而不是在这里认识 git:真正的实现复用 `ipc/git.ts`(porcelain v2 解析、
   * path spec 处理都在那边),抄第二份的代价是两处对「路径怎么转义」的理解会分叉。
   *
   * ★ 是个**工厂而不是现成对象**:每次 RPC 都要造一份 `CapabilityContext`,
   * 而绝大多数调用和 git 无关。提前造等于每次读文件都顺带准备一套 git 上下文。
   */
  scm: () => PluginScmAdapter
  kv: {
    get(key: string): string | null
    set(key: string, value: string | null): void
    keys(): string[]
    usedBytes(): number
  }
}

/**
 * 插件能看见的版本控制面。
 *
 * 需求:插件要能读仓库状态做判断(「有未提交改动就别跑发布」),也要能在用户
 * 明确批准后提交。**没有 push / pull** —— 它们会把本机凭据用到远端,而失败形态
 * (冲突、鉴权、hook 拒绝)不是一条 RPC 的返回值能如实回答的。
 *
 * 每个方法都不接 workspaceId:适配器在构造时就绑死了当前工作区,插件说了不算。
 */
export interface PluginScmAdapter {
  status: () => Promise<{ branch: string; staged: string[]; unstaged: string[] }>
  diff: (options: { path: string; staged: boolean }) => Promise<{ diff: string; binary: boolean; truncated: boolean }>
  log: (options: { limit: number }) => Promise<{ commits: { hash: string; subject: string; author: string; at: number }[] }>
  branches: () => Promise<{ current: string; branches: string[] }>
  stage: (paths: string[]) => Promise<void>
  commit: (message: string) => Promise<{ hash: string }>
  createBranch: (name: string, checkout: boolean) => Promise<void>
  checkout: (name: string) => Promise<void>
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

    case 'env.openExternal': {
      const p = params as PluginParams<'env.openExternal'>
      /*
        ★ **只允许 https**,与 `narrowFetchUrl` 同一立场 —— 但这里是**另一条**
        判定,不复用 `hostPermissions`:交给系统浏览器打开的东西离开了应用的
        信任边界,用户在自己的浏览器里能看见地址栏。真正要挡的是
        `javascript:` / `file:` / `ncw-plugin:` 这类能在本机取得额外权限的 scheme。
        不满足会怎样:一个插件可以用 `file:///` 让用户的文件管理器打开任意目录。
      */
      const url = normalizeExternalUrl(p.url)
      await ctx.openExternal(url)
      return { data: { opened: true }, summary: `openExternal ${new URL(url).host}` }
    }

    case 'env.clipboardRead':
      // 能力门已经查过 `clipboard`;读到的内容不进活动日志(剪贴板里可能是密码)。
      return { data: { text: await ctx.clipboard.readText() }, summary: 'clipboard.read' }

    case 'env.clipboardWrite': {
      const p = params as PluginParams<'env.clipboardWrite'>
      if (typeof p.text !== 'string') invalid('text is required')
      if (p.text.length > MAX_PLUGIN_FILE_BYTES) invalid('clipboard payload is too large')
      await ctx.clipboard.writeText(p.text)
      // 摘要只记长度,不记内容 —— 同 `diagnostics.ts` 的「不含参数原文」。
      return { data: {}, summary: `clipboard.write ${p.text.length} chars` }
    }

    case 'scm.status':
      return { data: await ctx.scm().status(), summary: 'scm.status' }

    case 'scm.diff': {
      const p = params as PluginParams<'scm.diff'>
      const path = relativeInside(ctx, p.path)
      const result = await ctx.scm().diff({ path, staged: p.staged === true })
      return { data: { ...result, diff: truncate(result.diff) }, summary: `scm.diff ${path}` }
    }

    case 'scm.log': {
      const p = params as PluginParams<'scm.log'>
      const limit = Math.min(Math.max(1, p.limit ?? 20), 200)
      return { data: await ctx.scm().log({ limit }), summary: `scm.log ${limit}` }
    }

    case 'scm.branches':
      return { data: await ctx.scm().branches(), summary: 'scm.branches' }

    case 'scm.stage': {
      const p = params as PluginParams<'scm.stage'>
      if (!Array.isArray(p.paths) || p.paths.length === 0) invalid('paths is required')
      if (p.paths.length > 500) invalid('too many paths')
      // 每一条都过工作区收窄 —— `git add ../../..` 在仓库根之外同样是越界。
      const paths = p.paths.map((path) => relativeInside(ctx, path))
      await ctx.scm().stage(paths)
      return { data: {}, summary: `scm.stage ${paths.length} path(s)` }
    }

    case 'scm.commit': {
      const p = params as PluginParams<'scm.commit'>
      const message = typeof p.message === 'string' ? p.message.trim() : ''
      if (message === '') invalid('message is required')
      if (message.length > 4096) invalid('message is too long')
      return { data: await ctx.scm().commit(message), summary: 'scm.commit' }
    }

    case 'scm.createBranch': {
      const p = params as PluginParams<'scm.createBranch'>
      const name = narrowBranchName(p.name)
      await ctx.scm().createBranch(name, p.checkout === true)
      return { data: {}, summary: `scm.createBranch ${name}` }
    }

    case 'scm.checkout': {
      const p = params as PluginParams<'scm.checkout'>
      const name = narrowBranchName(p.name)
      await ctx.scm().checkout(name)
      return { data: {}, summary: `scm.checkout ${name}` }
    }

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
      // ★ 不再在这里弹确认框:`workspace.write` 是否被授予,能力门已经在
      // `manager.ts` 里查过了(答案落在 kv `plugins.state` 的 `granted` 里)。
      await ctx.host.fs.mkdirp(target)
      await ctx.host.fs.writeFile(target, bytes.toString('utf8'))
      const after = await ctx.host.fs.stat(target).catch(() => null)
      return { data: { revision: after === null ? 0 : Math.round(after.mtimeMs) }, summary: `write ${p.path}` }
    }

    case 'workspace.deleteFile': {
      const p = params as PluginParams<'workspace.deleteFile'>
      const target = await resolveInside(ctx, p.path)
      /*
        ★ **走系统废纸篓,失败时不降级为永久删除。** 这条和
        `ipc/workspace-files.ts` 的删除分支是同一个立场。

        它在这里尤其要紧:上面那次逐次确认框已经撤掉了,插件删文件不再有
        「你确定吗」这一问。可恢复性从此**只剩废纸篓这一层** —— 掉回
        `fs.rm` 就等于插件可以静默地永久抹掉用户的文件。所以 `trash` 抛错
        就让整条调用失败,让插件收到一个明确的拒绝。
      */
      await ctx.trash(target).catch(() => rejected('the file could not be moved to the trash'))
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
      const prepared = await prepareExec(ctx, p)
      const controller = new AbortController()
      const result = await ctx.host.spawn(prepared.line, {
        cwd: prepared.cwd,
        signal: controller.signal,
        timeoutMs: prepared.timeoutMs,
        shell: prepared.shell
      })
      return { data: result, summary: `exec ${prepared.command}` }
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

/**
 * 跑命令前的**全部门**:参数门(白名单 + 元字符)→ cwd 收窄 → 引号化 → 审批。
 *
 * ★ 导出给 `manager.ts` 的 `process.execStream` 复用。一次性 exec 与流式 exec
 * 是同一件事的两种取出方式,而**门必须只有一套** —— 抄第二份的话,两条路上
 * 「哪些命令算被批准过」迟早会分叉,而分叉的那一侧不会有人为它写测试。
 *
 * ★ 审批只在这里问**一次**。流式那条不逐 chunk 问:逐 chunk 问的结果是
 * 用户为了一条命令点二十次「允许」。
 */
export async function prepareExec(
  ctx: CapabilityContext,
  params: { command: string; args: string[]; cwd?: string; timeoutMs?: number }
): Promise<{ command: string; line: string; cwd: string; shell: string; timeoutMs: number }> {
  const narrowed = narrowCommand(ctx.allowedCommands, params.command, params.args)
  if (!narrowed.ok) invalid(narrowed.reason)
  const cwd = params.cwd === undefined ? ctx.workspaceRoot : (await resolveInside(ctx, params.cwd))
  if (cwd === '') invalid('no workspace is open')
  const shell = ctx.host.platform.shell
  const line = `${narrowed.value.command} ${narrowed.value.args.map((arg) => quoteArg(arg, shell)).join(' ')}`.trim()
  if (!(await ctx.approve({ kind: 'exec', detail: line }))) rejected('the command was not approved')
  return {
    command: narrowed.value.command,
    line,
    cwd,
    shell,
    timeoutMs: Math.min(Math.max(1000, params.timeoutMs ?? 60_000), 120_000)
  }
}

/**
 * 交给系统浏览器的地址。
 *
 * ★ 只放行 https。`http:` 也拒:一条明文地址由谁应答是中间人说了算,而这里
 * 打开的是**用户自己的浏览器**,出了应用边界就再没有第二道检查。
 * 不满足会怎样:`file:///` / `javascript:` 能让插件在用户机器上撬开别的东西。
 */
function normalizeExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') invalid('url is required')
  if (raw.length > 2048) invalid('url is too long')
  let parsed: URL
  try { parsed = new URL(raw) } catch { invalid('url is not a valid URL') }
  if (parsed.protocol !== 'https:') invalid('only https:// can be opened externally')
  if (parsed.username !== '' || parsed.password !== '') invalid('credentials in the URL are not allowed')
  return parsed.toString()
}

/**
 * 分支名收窄。
 *
 * ★ 挡的是**会被 git 当成选项或路径的形状**:`-` 开头会变成一个 flag,
 * `..` / 空格 / 控制字符在 refname 里非法或有歧义。挡在这里而不是指望
 * git 自己报错,是因为报错会以一句 git 原文出现在插件那边,对不上原因。
 */
function narrowBranchName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') invalid('branch name is required')
  if (name.length > 255) invalid('branch name is too long')
  if (name.startsWith('-') || name.includes('..') || /[\s~^:?*[\\\0]/.test(name)) {
    invalid(`not a valid branch name: ${name}`)
  }
  return name
}

/**
 * scm 这一路的路径参数:**先过工作区收窄,再原样把相对路径交给 git**。
 *
 * ★ 不做 realpath(不像 `resolveInside`):git 的 pathspec 要的就是仓库相对路径,
 * 而且这些路径可能指向已经被删掉的文件(`scm.diff` 一个删除项是常态),
 * 那时 realpath 一定失败 —— 用它会让「看一眼我删了什么」变成 `invalid_argument`。
 */
function relativeInside(ctx: CapabilityContext, path: unknown): string {
  if (typeof path !== 'string' || path === '') invalid('path is required')
  const narrowed = narrowWorkspacePath(ctx.workspaceRoot, path)
  if (!narrowed.ok) invalid(narrowed.reason)
  return path.replaceAll('\\', '/')
}

/** 超长输出按插件读写上限截断 —— 一个巨大的 diff 不该撑爆一次 RPC。 */
function truncate(value: string): string {
  return value.length > MAX_PLUGIN_FILE_BYTES ? `${value.slice(0, MAX_PLUGIN_FILE_BYTES)}\n… (truncated)` : value
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
