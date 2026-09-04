/**
 * `ncw://` 静态资源协议 —— 渲染层直接引用本地附件,不再走 IPC 传字节。
 *
 * ## 为什么要一个自定义协议
 *
 * 在此之前,渲染层要显示一张本地图只能走 `theme:readImage` 那条路:把整个文件
 * 作为 `Uint8Array` 经结构化克隆送过去,渲染层再 `new Blob` → `createObjectURL`。
 * 代价是**每显示一次全量拷贝一次**,而且拿不到浏览器的图片解码流水线、磁盘缓存、
 * Range 请求 —— 视频连拖进度条都做不到。
 *
 * 换成协议之后这些全部由 Chromium 接管,附件的显示路径上不再有我们的代码。
 *
 * ## 两段注册,顺序不能反
 *
 * `registerAttachmentScheme()` 必须在 `app.whenReady()` **之前**调用。
 * 放到 ready 之后**不报错**,但 privileges 全部丢失 —— 表现是「图片有时能显示、
 * fetch 报 CORS、视频不能拖进度条」这类看起来彼此无关的散装故障。
 *
 * ## 安全
 *
 * 协议是**渲染层可以任意构造输入**的入口,与 `workspace:listDir` 同级别的不可信
 * 输入。防线是两层且都必须在:
 *
 * 1. `parseNcwUrl`(纯函数,`shared/domain/attachment.ts`)—— 解码后逐段校验
 * 2. `resolveAttachmentPath` 的 `isWithinRoot` —— 拼完再验一次落点
 *
 * 第二层不是冗余:第一层管的是「URL 长得对不对」,第二层管的是「拼出来的路径
 * 落在哪」。符号链接只有第二层能拦(而它拦不住 —— 见 `realpath` 那条注释)。
 */
import { net, protocol } from 'electron'
import { defaultDatabaseDirectory } from '../db'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  NCW_HOST,
  NCW_SCHEME,
  attachmentRelPath,
  mimeOfExt,
  parseNcwUrl
} from '../../shared/domain/attachment'

/** 附件根。★ 必须与 `ipc/storage.ts` 的 `attachmentDirectory()` 是同一个目录 —— 清理扫的就是它 */
export const ATTACHMENTS_DIR = 'attachments'

export function attachmentRoot(): string {
  return join(defaultDatabaseDirectory(), ATTACHMENTS_DIR)
}

/**
 * ★ 与 `ipc/storage.ts` 的 `isWithin` 同源。
 *
 * 那边是私有函数,而这里是**独立的安全边界**,不能靠 import 一个恰好还没被
 * 重构掉的私有符号。等 storage 那条线稳定后再合并成一处 —— 在那之前,
 * 两份相同的实现比一份跨模块的耦合安全。
 */
function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * URL → 绝对路径。**这是整条链路上唯一需要单测的部分**,所以它是纯函数:
 * root 由调用方给,不碰 `app`,不碰文件系统。
 *
 * 返回 null = 拒绝(handler 侧回 403/404)。不抛异常 —— 调用点只需要一个二选一。
 */
export function resolveAttachmentPath(root: string, rawUrl: string): string | null {
  const loc = parseNcwUrl(rawUrl)
  if (loc === null) return null

  const rel = attachmentRelPath(loc)
  if (rel === null) return null

  const target = resolve(join(root, rel))
  // ★ 第二层:拼完再验落点。第一层验的是 URL 的形状,这一层验的是结果。
  if (!isWithinRoot(root, target)) return null
  return target
}

/**
 * 在 `app.whenReady()` **之前**调用。
 *
 * - `standard`:走标准 URL 解析,才有正常的 host/pathname 语义
 * - `secure`:视同 https,否则被当不安全来源,CSP 与 fetch 双双拦下
 * - `supportFetchAPI`:渲染层可以 `fetch('ncw://…')` 拿 blob
 * - `stream`:★ 视频/音频的 Range 请求靠它,否则大文件只能整包读
 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NCW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 同源自用,不开放跨源
        corsEnabled: false
      }
    }
  ])
}

/** 在 `app.whenReady()` 之后调用 */
export function installAttachmentProtocol(): void {
  protocol.handle(NCW_SCHEME, (request) => handleAttachmentRequest(request, attachmentRoot()))
}

export async function handleAttachmentRequest(
  request: Request,
  root: string
): Promise<Response> {
  const target = resolveAttachmentPath(root, request.url)
  if (target === null) {
    // ★ 403 而不是 404:两者要能区分开。404 是「这个 id 的文件没了」(正常,
    //   走 onError 显示占位),403 是「有人在构造越界路径」(应当被注意到)。
    return new Response('forbidden', { status: 403 })
  }

  try {
    /*
      ★ 转发给 net.fetch,而不是自己 readFileSync:

      - Range 请求(视频拖进度条)由它处理。自己实现要解析 Range 头、
        拼 206 响应和 Content-Range —— 一整套容易写错的协议细节。
      - 大文件走流,不整包进内存。
      - 但 **Content-Type 仍要自己给**:file:// 的类型推断在各平台不一致,
        推不出来时浏览器会把图片当下载处理。
    */
    const res = await net.fetch(pathToFileURL(target).toString())
    if (!res.ok) return new Response('not found', { status: 404 })

    const headers = new Headers(res.headers)
    headers.set('Content-Type', mimeOfExt(target))
    /*
      ★ immutable 长缓存在这里是**安全的**,正因为磁盘文件名是 ULID:
      同一个 URL 的内容永不改变。若文件名可复用(比如用原始文件名),
      这个头会把旧图钉死在缓存里,换了图也刷不掉。
    */
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return new Response(res.body, { status: res.status, headers })
  } catch {
    // 文件被外部删除 / 权限不足 —— 对渲染层都是「这张图没了」
    return new Response('not found', { status: 404 })
  }
}

/** 给 UI 用的常量:CSP 里需要放开的 scheme 串 */
export const NCW_CSP_SOURCE = `${NCW_SCHEME}:`
export { NCW_HOST }
