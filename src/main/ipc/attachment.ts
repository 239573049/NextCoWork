/**
 * 附件上传 —— 落盘、去重、登记。
 *
 * ## 落盘顺序不是随意的
 *
 * `.tmp` 写完再 `rename` 是**原子替换**:写到一半崩掉留下的是一个 `.tmp`
 * 残片,而不是一个「大小对不上但看起来正常」的目标文件。后者的危害在于
 * 它的 checksum 已经进了表,下一次去重会**命中这个坏文件**,于是一个
 * 中断的上传会污染之后所有相同内容的上传。
 *
 * ## 为什么去重限定在同 scope + 同 owner
 *
 * 跨会话共用一个物理文件之后,删掉其中一个会话就会波及另一个仍在引用它的会话。
 * 要正确处理得上引用计数 —— 而省下的那点磁盘不值得引入一套引用计数的
 * 正确性负担(理由同 `repo.findAttachmentByChecksum`)。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { dialog } from 'electron'
import type {
  Attachment,
  AttachmentScope,
  AttachmentUploadRequest,
  PickedAttachment
} from '../../shared/domain/attachment'
import {
  MAX_ATTACHMENT_BYTES,
  attachmentRelPath,
  buildNcwUrl,
  extOfMime,
  isImageMime,
  mimeOfExt
} from '../../shared/domain/attachment'
import { ulid } from '../../shared/util/id'
import * as repo from '../db/repo'
import { attachmentRoot } from '../net/attachment-protocol'
import { IpcError } from './errors'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 行 → 对外类型。★ `url` 由 locator 反推,**绝对路径不出主进程**。
 *
 * `displayName` 优先取列里存的原始名;迁移 6 之前的行没有它,退回 ULID 文件名 ——
 * 那正是加这一列之前的表现,旧数据不会更糟。
 */
function toAttachment(row: repo.AttachmentRow): Attachment {
  const scope = row.scope as AttachmentScope
  const url = buildNcwUrl({
    scope,
    ownerId: row.ownerId ?? undefined,
    fileName: basename(row.path)
  })
  if (url === null) {
    // 表里存着一条拼不出 URL 的记录 —— 只可能是数据被外部改过
    throw new IpcError('unknown', '附件记录已损坏')
  }
  return {
    id: row.id,
    scope,
    ownerId: row.ownerId ?? undefined,
    displayName: row.displayName ?? basename(row.path),
    mime: mimeOfExt(row.path),
    size: row.size,
    checksum: row.checksum,
    createdAt: row.createdAt,
    url
  }
}

export function uploadAttachment(req: AttachmentUploadRequest): Attachment {
  if (req.bytes.byteLength === 0) throw new IpcError('unknown', '空文件')
  if (req.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new IpcError('unknown', `文件超过 ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`)
  }

  const checksum = sha256(req.bytes)

  // ★ 去重命中时**不写新文件**,直接复用。同一张截图粘三次只占一份磁盘。
  //   ★ 但 displayName 仍取本次上传的 —— 去重的是字节,不是用户对它的称呼。
  const hit = repo.findAttachmentByChecksum(checksum, req.scope, req.ownerId)
  if (hit !== undefined && existsSync(hit.path)) {
    return { ...toAttachment(hit), displayName: req.displayName }
  }

  const id = ulid()
  const fileName = `${id}${extOfMime(req.mime)}`
  const rel = attachmentRelPath({ scope: req.scope, ownerId: req.ownerId, fileName })
  if (rel === null) throw new IpcError('unknown', '附件位置非法')

  const target = join(attachmentRoot(), rel)
  mkdirSync(dirname(target), { recursive: true })

  // ★ 临时文件名以 `.` 开头:清理时按前缀就能认出残片,
  //   而它又不会被 `ncw://` 寻址到(fileName 段校验不过)。
  const tmp = join(dirname(target), `.${fileName}.tmp`)
  try {
    writeFileSync(tmp, req.bytes)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new IpcError('unknown', `写入附件失败: ${String(err)}`)
  }

  const createdAt = Date.now()
  repo.putDraftAttachment({
    id,
    scope: req.scope,
    ownerId: req.ownerId,
    path: target,
    size: req.bytes.byteLength,
    checksum,
    displayName: req.displayName,
    createdAt
  })

  const url = buildNcwUrl({ scope: req.scope, ownerId: req.ownerId, fileName })
  if (url === null) throw new IpcError('unknown', '附件位置非法')

  return {
    id,
    scope: req.scope,
    ownerId: req.ownerId,
    displayName: req.displayName,
    mime: req.mime,
    size: req.bytes.byteLength,
    checksum,
    createdAt,
    url
  }
}

/**
 * 走主进程 dialog 选文件。
 *
 * ★ **渲染层永不指定任意路径**(方案 §9)—— 与 `workspace:pick` / `theme:importImage`
 * 同一条规则。渲染层给的是「我想选文件」这个意图,路径由用户在系统对话框里定。
 * 回传路径**不违反**这条:路径是用户刚刚在对话框里选定的既成事实,与他拖进来的
 * 文件同源,渲染层依旧没有编造一个读取参数的能力。
 *
 * ## 分流规则与拖拽/粘贴必须逐字相同(ChatView 的 `attachFiles`)
 *
 * 图片落盘 —— 内联展示要有 `ncw://` 地址;非图片**不落盘**,只回传真实路径。
 * 复制一份没人会去读的字节副本没有意义:这个应用本身就是个带文件系统工具的
 * Agent,给它真实路径比塞一份副本有用得多。
 *
 * ★ 两个入口分流不一致的代价是**一个入口悄悄失效**:同一个 PDF 从菜单选进来
 * 只剩转录里一句「[附件] 名字」(`partsOf` 对无路径的非图片就是这么退化的),
 * 从拖拽进来却是模型可以打开的 `file_ref`。用户看到的是同一排 chip。
 */
export async function pickAttachments(req: {
  scope: AttachmentScope
  ownerId?: string
}): Promise<PickedAttachment[]> {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: '选择附件'
  })
  if (r.canceled) return []

  const out: PickedAttachment[] = []
  for (const path of r.filePaths) {
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      const mime = mimeOfExt(path)
      // ★ 非图片这一支**不读字节**,所以也不受上传上限约束 —— 上限存在的理由是
      //   结构化克隆的卡顿(见 MAX_ATTACHMENT_BYTES),而这里一个字节都不过 IPC。
      //   拖一个 200MB 的日志进来是可以的,从菜单选同一个文件没有理由被静默丢掉。
      if (!isImageMime(mime)) {
        out.push({ kind: 'path', path, name: basename(path) })
        continue
      }
      if (st.size > MAX_ATTACHMENT_BYTES) continue
      const bytes = new Uint8Array(readFileSync(path))
      out.push({
        kind: 'attachment',
        attachment: uploadAttachment({
          scope: req.scope,
          ownerId: req.ownerId,
          displayName: basename(path),
          mime,
          bytes: bytes as Uint8Array<ArrayBuffer>
        })
      })
    } catch {
      // 单个文件失败不该让整批选择失败 —— 用户选了 5 个,不能因为第 3 个
      // 权限不足就一个都拿不到
    }
  }
  return out
}

export function removeAttachment(req: { id: string }): void {
  const row = repo.getAttachmentRow(req.id)
  if (row === undefined) return

  // This endpoint is for removing an attachment chip before send. A
  // committed row belongs to a message and must not be detached through a
  // renderer-controlled id; doing so would leave the transcript referring to
  // a missing file.
  if (row.status === 'committed' || row.messageId !== null || row.sessionId !== null) {
    throw new IpcError('unknown', '已提交的附件不能从消息中移除')
  }

  // Only files under the application-managed session tree may be unlinked.
  // Agent-generated images can be absolute paths and are deliberately kept as
  // references only; an attachment id must never become an arbitrary delete
  // primitive for the renderer.
  const managedRoot = join(attachmentRoot(), 'sessions')
  const path = resolve(row.path)
  const rel = relative(resolve(managedRoot), path)
  const managed = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  if (managed && repo.attachmentReferenceCount(row.path, row.id) === 0) {
    try {
      // lstat/unlink removes a symlink itself and never follows it to an
      // external target. Directories are not valid uploaded attachments.
      const st = lstatSync(row.path)
      if (st.isDirectory()) throw new Error('附件路径是目录')
      unlinkSync(row.path)
    } catch (err) {
      // A missing file is already equivalent to removal. Permission and type
      // errors are surfaced while the database row is retained for retry.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new IpcError('unknown', `删除附件文件失败: ${String(err)}`)
      }
    }
  }

  // Remove the row after the physical operation. For external paths this only
  // removes our bookkeeping row; the user's file is never touched.
  repo.removeAttachmentRow(req.id)
}

/** 重启后恢复草稿附件区。★ 显示名从 `display_name` 列读回,不再退化成 ULID */
export function listSessionAttachments(req: { sessionId: string }): Attachment[] {
  return repo.listDraftAttachments(req.sessionId).map(toAttachment)
}
