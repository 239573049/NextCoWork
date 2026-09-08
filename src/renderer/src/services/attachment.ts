/**
 * 附件服务 —— 上传与管理。
 *
 * ★ **读取不在这里。** 显示一张附件图走的是 `<img src={a.url}>`,由 `ncw://`
 * 协议直接喂给 Chromium,不经过 IPC。这个文件只负责「进」和「管」两端。
 */
import type {
  Attachment,
  AttachmentScope,
  AttachmentUploadRequest,
  PickedAttachment
} from '../../../shared/domain/attachment'
import { MAX_ATTACHMENT_BYTES, mimeOfExt } from '../../../shared/domain/attachment'
import { invoke } from './ipc'

export function uploadAttachment(req: AttachmentUploadRequest): Promise<Attachment> {
  return invoke('attachment:upload', req)
}

/**
 * 走主进程 dialog。取消时返回空数组,不是 null —— 调用点不必分两种空。
 *
 * ★ 回来的是**两种形态的联合**:图片已落盘(`kind: 'attachment'`),
 * 非图片只有路径(`kind: 'path'`)—— 与拖拽/粘贴同规则,见主进程侧注释。
 */
export function pickAttachments(
  scope: AttachmentScope,
  ownerId?: string
): Promise<PickedAttachment[]> {
  return invoke('attachment:pick', { scope, ownerId })
}

export function removeAttachment(id: string): Promise<void> {
  return invoke('attachment:remove', { id })
}

export function listSessionAttachments(sessionId: string): Promise<Attachment[]> {
  return invoke('attachment:listBySession', { sessionId })
}

/**
 * `File` → 上传。拖拽与粘贴共用这一条。
 *
 * ★ **大小在这里先拦一道**,不等到主进程:超限的文件光是 `arrayBuffer()`
 * 就要把几百 MB 读进渲染进程内存,然后再经结构化克隆送过去被拒 ——
 * 那一下卡顿是真实的,而结果注定是失败。
 */
export async function uploadFile(
  file: File,
  scope: AttachmentScope,
  ownerId?: string
): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`「${file.name}」超过 ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`)
  }
  const buf = await file.arrayBuffer()
  return uploadAttachment({
    scope,
    ownerId,
    displayName: displayNameOf(file),
    // ★ file.type 可能是空串(某些拖拽来源不给),退回按扩展名推
    mime: file.type === '' ? mimeOfExt(file.name) : file.type,
    bytes: new Uint8Array(buf)
  })
}

/**
 * ★ 截图粘贴是最高频的入口,而它的 `file.name` 常常是空的或统一的
 * `image.png` —— 三张截图三个同名 chip,用户分不清哪个是哪个。
 * 这里给一个带时间的兜底名。
 */
function displayNameOf(file: File): string {
  if (file.name !== '' && file.name !== 'image.png') return file.name
  const t = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
  return `粘贴图片-${stamp}${file.type === 'image/png' ? '.png' : ''}`
}
