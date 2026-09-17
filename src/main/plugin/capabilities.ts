/**
 * 参数门 —— **四道门里的第三道**(见 `shared/plugin/protocol.ts` 的文件头)。
 *
 * 静态门回答「清单里声明了吗」,授予门回答「用户批了吗」,
 * 这一层回答的是**「这一次调用的参数落在批准范围之内吗」**。
 *
 * ## 为什么必须单独一层
 *
 * 「批准了 `workspace.read`」不等于「可以读任意文件」。没有这一层的话,
 * 一个拿到读权限的插件可以 `readFile('../../../.ssh/id_rsa')` —— 能力检查
 * 会放行,因为它要的确实是「读」。范围收窄和能力授予是两个问题。
 *
 * ## 这里全是纯函数
 *
 * 一个参数都不碰文件系统、不碰 electron。路径的**词法**边界在这里判,
 * realpath 归一(挡软链)在调用点做 —— 和 `net/attachment-protocol.ts`
 * 的两层防线是同一个分工:这一层管「长得对不对」,那一层管「落点在哪」。
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { matchesHostPermission } from '../../shared/plugin/manifest'

export type NarrowResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function deny(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

/** 单次读写的字节上限。插件不是文件管理器,它要的是配置和文档。 */
export const MAX_PLUGIN_FILE_BYTES = 8 * 1024 * 1024

/**
 * 工作区内的相对路径 → 绝对路径。
 *
 * ★ 入参**只接受相对路径**。接受绝对路径意味着每一次调用都要判断
 * 「这个绝对路径是不是恰好在工作区里」,而那个判断在符号链接、大小写不敏感
 * 文件系统、UNC 路径上各有各的坑。只收相对路径把问题缩小成一件事:
 * 拼出来的结果有没有跑到根外面去。
 */
export function narrowWorkspacePath(
  workspaceRoot: string,
  path: string
): NarrowResult<string> {
  if (workspaceRoot === '') return deny('no workspace is open')
  if (typeof path !== 'string' || path === '') return deny('path is required')
  if (path.length > 1024) return deny('path is too long')
  if (path.includes('\0')) return deny('path contains a NUL byte')
  if (isAbsolute(path)) return deny('path must be relative to the workspace root')
  if (/^[a-zA-Z]:/.test(path)) return deny('path must be relative to the workspace root')

  const target = resolve(workspaceRoot, path)
  const rel = relative(resolve(workspaceRoot), target)
  // `..` 开头 = 跑到根外面了;绝对 = 换了盘符(Windows)。
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return deny('path escapes the workspace root')
  return { ok: true, value: target }
}

/**
 * 清单里可选的 `paths` glob 再收窄一次。
 *
 * 只支持前缀形式(`docs/*`、`src/**`),不引 glob 引擎:这一层是**安全边界**,
 * 而通用 glob 的语义(`{a,b}`、否定、`..` 在 pattern 里)每一条都是一次
 * 「我以为它匹配不到」的机会。
 */
export function matchesPathScope(scopes: readonly string[] | undefined, relPath: string): boolean {
  if (scopes === undefined || scopes.length === 0) return true
  const normalized = relPath.replaceAll('\\', '/')
  return scopes.some((scope) => {
    const clean = scope.replaceAll('\\', '/').replace(/\*+$/, '')
    return clean === '' || normalized === clean || normalized.startsWith(clean.endsWith('/') ? clean : `${clean}/`)
  })
}

/**
 * 命令白名单 —— 只匹配 `argv[0]`,而且只按**基名**。
 *
 * ★ 按基名而不是整条路径:`/usr/bin/cargo` 与 `cargo` 是同一个意图,
 * 而让插件作者在清单里写绝对路径会让这份清单在别人机器上一定不成立。
 * 代价是 PATH 里被放了个假 `cargo` 时这一层挡不住 —— 那是另一个威胁模型
 * (本机已被控制),不在这道门的职责里。
 */
export function narrowCommand(
  allowed: readonly string[],
  command: string,
  args: readonly string[]
): NarrowResult<{ command: string; args: string[] }> {
  if (typeof command !== 'string' || command.trim() === '') return deny('command is required')
  if (command.includes('\0')) return deny('command contains a NUL byte')
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    return deny('args must be an array of strings')
  }
  if (args.length > 64) return deny('too many arguments')
  const base = command.replaceAll('\\', '/').split('/').pop() ?? command
  const stem = base.replace(/\.(exe|cmd|bat|ps1)$/i, '')
  if (allowed.length === 0) return deny('the manifest declares no command allow-list')
  if (!allowed.includes(stem)) return deny(`"${stem}" is not in the manifest command allow-list`)
  /*
    ★ **不拼 shell 串,也不接受 shell 元字符。** 这条调用最终走
    `kernel/node-spawn.ts` 的 argv 形式;这里挡掉元字符是为了让「这条命令
    到底会跑什么」在审批弹窗里是可读的 —— 一个带 `&&` 的参数会让弹窗上
    写着 `cargo check`,实际跑的是另外两条。
  */
  if (/[;&|`$><\n]/.test(command)) return deny('command must not contain shell metacharacters')
  return { ok: true, value: { command: stem, args: [...args] } }
}

/** `net.fetch` 的 URL 门。**在主进程做**,不信 CSP。 */
export function narrowFetchUrl(
  hostPermissions: readonly string[],
  url: string
): NarrowResult<string> {
  if (typeof url !== 'string' || url === '') return deny('url is required')
  if (url.length > 2048) return deny('url is too long')
  let parsed: URL
  try { parsed = new URL(url) } catch { return deny('url is not a valid URL') }
  // ★ 只允许 https。明文 http 会让「这条请求去了哪」变成一个中间人说了算的问题。
  if (parsed.protocol !== 'https:') return deny('only https:// is allowed')
  if (parsed.username !== '' || parsed.password !== '') return deny('credentials in the URL are not allowed')
  if (isPrivateHost(parsed.hostname)) return deny('private and loopback addresses are blocked')
  if (!matchesHostPermission(hostPermissions, url)) {
    return deny('url does not match any entry in hostPermissions')
  }
  return { ok: true, value: parsed.toString() }
}

/**
 * 内网/环回地址一律挡掉 —— 和 `kernel/tool/builtin/ssrf.ts` 同一个理由:
 * `hostPermissions` 是作者写的,而作者可以写 `https://169.254.169.254/*`
 * 然后在审核那里以「我要访问我自己的元数据服务」蒙混过去。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** kv 的 key。强制前缀在调用点加,这里只管形状与长度。 */
export function narrowStorageKey(key: string): NarrowResult<string> {
  if (typeof key !== 'string' || key === '') return deny('key is required')
  if (key.length > 256) return deny('key is too long')
  if (!/^[A-Za-z0-9_.:@/-]+$/.test(key)) return deny('key contains unsupported characters')
  return { ok: true, value: key }
}

/**
 * secrets 的 key 前缀。
 *
 * ★ 前缀由**宿主**拼,不是插件传进来的一部分:让插件自己拼前缀等于让它
 * 有机会写成 `plugin:other.plugin:token`,读走别人的密钥。
 */
export function secretKeyFor(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`
}

/** 注入上下文的强制包裹 + 截断。长度上限见 `PLUGIN_CONTEXT_LIMIT`。 */
export function wrapPluginContext(pluginId: string, text: string, limit: number): string {
  /*
    ★ 控制字符必须去掉:它们进的是发给模型的消息流,而其中几个(尤其是
    转义序列)会在转录渲染与终端回显里被解释成别的东西。
    `no-control-regex` 在这里是误报 —— 我们要匹配的**就是**控制字符。
  */
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
  if (clean === '') return ''
  const body = clean.length > limit ? `${clean.slice(0, limit)}…` : clean
  /*
    ★ 强制包裹不是排版,是**边界声明**:模型必须能看出这一段来自插件而不是
    用户或系统提示词。同 `kernel/untrusted.ts` 给 Skill 正文加边界的理由。
  */
  return `<plugin-context source="${pluginId}">\n${body}\n</plugin-context>`
}
