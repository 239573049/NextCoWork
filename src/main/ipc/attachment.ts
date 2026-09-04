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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dialog } from 'electron'
import type {
  Attachment,
  AttachmentScope,
  AttachmentUploadRequest
} from '../../shared/domain/attachment'
import {
  MAX_ATTACHMENT_BYTES,
  attachmentRelPath,
  buildNcwUrl,
  extOfMime,
  mimeOfExt
} from '../../shared/domain/attachment'
import { ulid } from '../../shared/util/id'
import * as repo from '../db/repo'
import { attachmentRoot } from '../net/attachment-protocol'
import { IpcError } from './errors'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 行 → 对外类型。★ `url` 由 locator 反推,**绝对路径不出主进程** */
function toAttachment(row: repo.AttachmentRow, displayName: string): Attachment {
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
    displayName,
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
  const hit = repo.findAttachmentByChecksum(checksum, req.scope, req.ownerId)
  if (hit !== undefined && existsSync(hit.path)) {
    return toAttachment(hit, req.displayName)
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
 * 同一条规则。渲染层给的是「我想选文件」这个意图,路径由用户在系统对话框里定,
 * 主进程读完就把它转成受管理的附件,原路径不回传。
 */
export async function pickAttachments(req: {
  scope: AttachmentScope
  ownerId?: string
}): Promise<Attachment[]> {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: '选择附件'
  })
  if (r.canceled) return []

  const out: Attachment[] = []
  for (const path of r.filePaths) {
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      if (st.size > MAX_ATTACHMENT_BYTES) continue
      const bytes = new Uint8Array(readFileSync(path))
      out.push(
        uploadAttachment({
          scope: req.scope,
          ownerId: req.ownerId,
          displayName: basename(path),
          mime: mimeOfExt(path),
          bytes: bytes as Uint8Array<ArrayBuffer>
        })
      )
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
  // 先删文件再删行:反过来的话,删行成功、删文件失败会留下一个
  // 表里没有的磁盘文件 —— 而它正好落进「孤儿」的定义里,下次清理会收掉它。
  // 这个顺序下最坏是留一条指向不存在文件的行,清理侧已有那条规则。
  rmSync(row.path, { force: true })
  repo.removeAttachmentRow(req.id)
}

/** 重启后恢复草稿附件区 */
export function listSessionAttachments(req: { sessionId: string }): Attachment[] {
  return repo.listDraftAttachments(req.sessionId).map((row) =>
    // displayName 没有单独落列,退回文件名。UI 侧在会话内仍持有用户看到的原始名,
    // 只有「重启后恢复」这一条路径会退化成 ULID 文件名。
    toAttachment(row, basename(row.path))
  )
}
