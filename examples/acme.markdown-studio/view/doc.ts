/**
 * 文档通道的视图侧客户端 —— 与宿主 `PluginViewFrame` 的三句话:
 *
 * ```
 * ──ncw:doc:ready──▶   我起来了,把文件给我
 * ◀──ncw:doc:open───   给你:{ path, data }     (markdown 原文,UTF-8)
 * ──ncw:doc:save───▶   存这份:{ data }          (不带 encoding = 文本)
 * ◀──ncw:doc:saved / ncw:doc:saveFailed──
 * ```
 *
 * 与 image-studio 版的差异只有一条:文本语义,data 就是原文、保存不带
 * `encoding`。★ 报文里没有路径(宿主按 Tab 绑定代写),也只认
 * `event.source === window.parent` 的消息。
 */

export interface OpenedDoc {
  /** 工作区相对路径,仅显示用。 */
  readonly path: string
  /** 文件原文;读不出(超限/损坏)时为空串。 */
  readonly data: string
}

type OpenHandler = (doc: OpenedDoc) => void
type SavedHandler = () => void

const listeners = { open: new Set<OpenHandler>(), saved: new Set<SavedHandler>(), failed: new Set<SavedHandler>() }

interface HostMessage {
  type?: string
  path?: string
  data?: string
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const message = event.data as HostMessage
  if (message === null || typeof message !== 'object') return
  if (message.type === 'ncw:doc:open') {
    const doc: OpenedDoc = {
      path: typeof message.path === 'string' ? message.path : '',
      data: typeof message.data === 'string' ? message.data : ''
    }
    for (const handler of listeners.open) handler(doc)
    return
  }
  if (message.type === 'ncw:doc:saved') { for (const handler of listeners.saved) handler(); return }
  if (message.type === 'ncw:doc:saveFailed') { for (const handler of listeners.failed) handler() }
})

export function notifyReady(): void {
  window.parent.postMessage({ type: 'ncw:doc:ready' }, '*')
}

export function onDocOpen(handler: OpenHandler): void { listeners.open.add(handler) }
export function onDocSaved(handler: SavedHandler): void { listeners.saved.add(handler) }
export function onDocSaveFailed(handler: SavedHandler): void { listeners.failed.add(handler) }

/** 存回原文(UTF-8 文本,不带 encoding)。 */
export function saveDoc(data: string): void {
  window.parent.postMessage({ type: 'ncw:doc:save', data }, '*')
}
