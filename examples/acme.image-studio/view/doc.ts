/**
 * 文档通道的视图侧客户端 —— 与宿主 `PluginViewFrame` 之间仅有的几句话:
 *
 * ```
 * ──ncw:doc:ready──▶   我起来了,把文件给我
 * ◀──ncw:doc:open───   给你:{ path, data, mime? }   (图片 = dataUrl)
 * ──ncw:doc:save───▶   存这份:{ data, encoding? }   (图片 = base64 + 'base64')
 * ◀──ncw:doc:saved / ncw:doc:saveFailed──
 * ```
 *
 * ★ 报文里没有路径,也**不该有**:写哪个文件由宿主按 Tab 绑定决定。这条
 *   通道的能力上界就是「它自己那个文件」,多要一个字段都是越界。
 * ★ 只认 `event.source === window.parent` 且 origin 是宿主主窗口的消息:
 *   iframe 里还可能有别的嵌套页,别把别人的 open 当成自己的。
 *   (宿主发送用的 targetOrigin 是本插件 origin;这里反过来校验来源。)
 */

export interface OpenedDoc {
  /** 工作区相对路径,仅用于显示文件名 —— 保存不依赖它。 */
  readonly path: string
  /** 图片:data: URL。文本之外读不出的内容时为空串。 */
  readonly data: string
  /** 图片的 mime(如 image/png);文本/读不出时缺省。 */
  readonly mime?: string
}

type OpenHandler = (doc: OpenedDoc) => void
type SavedHandler = () => void

const listeners = { open: new Set<OpenHandler>(), saved: new Set<SavedHandler>(), failed: new Set<SavedHandler>() }

interface HostMessage {
  type?: string
  path?: string
  data?: string
  mime?: string
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const message = event.data as HostMessage
  if (message === null || typeof message !== 'object') return
  if (message.type === 'ncw:doc:open') {
    const doc: OpenedDoc = {
      path: typeof message.path === 'string' ? message.path : '',
      data: typeof message.data === 'string' ? message.data : '',
      ...(message.mime === undefined ? {} : { mime: message.mime })
    }
    for (const handler of listeners.open) handler(doc)
    return
  }
  if (message.type === 'ncw:doc:saved') { for (const handler of listeners.saved) handler(); return }
  if (message.type === 'ncw:doc:saveFailed') { for (const handler of listeners.failed) handler() }
})

/** 报 ready 之前先把监听挂好(本模块 import 即挂),反过来的话会丢掉宿主回得快的那条。 */
export function notifyReady(): void {
  window.parent.postMessage({ type: 'ncw:doc:ready' }, '*')
}

export function onDocOpen(handler: OpenHandler): void { listeners.open.add(handler) }
export function onDocSaved(handler: SavedHandler): void { listeners.saved.add(handler) }
export function onDocSaveFailed(handler: SavedHandler): void { listeners.failed.add(handler) }

/**
 * 存回。`encoding: 'base64'` 时 `data` 是图片字节的 base64(不带 data: 前缀);
 * 缺省按 UTF-8 文本存 —— 本编辑器只有图片,永远走 base64。
 */
export function saveDoc(data: string, encoding: 'base64'): void {
  window.parent.postMessage({ type: 'ncw:doc:save', data, encoding }, '*')
}
