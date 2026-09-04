/**
 * 消息提交时的附件登记 —— 上传链路的**最后一环**。
 *
 * 这一步之前:文件在磁盘上,表里是一条 `draft` 行,`session_id` / `message_id` 都空着。
 * 这一步之后:同一条行变成 `committed` 并挂上会话与消息,从此受 CASCADE 管辖。
 *
 * ★ 这里最容易出的错是**登记成两条**:上传写一条,提交时又 INSERT 一条。
 * 后果不会立刻显现 —— 两条记录指向同一个文件,清理时按其中一条判活、
 * 另一条永远是「文件不存在」的死记录,于是每次清理都报有东西可删、删完还在。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userDataDir },
  dialog: { showOpenDialog: vi.fn() }
}))

import type { AgentMessage } from '../../../shared/agent/message'
import { closeDatabase, openDatabase } from '../../db'
import * as repo from '../../db/repo'
import { uploadAttachment } from '../attachment'

const bytesOf = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(s, 'utf8')) as Uint8Array<ArrayBuffer>

beforeEach(() => {
  closeDatabase()
  userDataDir = mkdtempSync(join(tmpdir(), 'nextcowork-commit-'))
  openDatabase(userDataDir)
  repo.ensureSession({ id: 'S1', workspaceId: 'W1', rootPathAtCreation: '/tmp' })
})

afterEach(() => {
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})

const msg = (id: string, parts: AgentMessage['parts']): AgentMessage => ({
  id,
  role: 'user',
  parts,
  createdAt: Date.now(),
  schemaVersion: 1
})

describe('ncw:// 附件随消息提交', () => {
  it('★ 升级已有的 draft 行,而不是新插一条 —— 一个文件只能有一条记录', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })

    repo.commitMessage('S1', msg('M1', [
      { type: 'text', text: '看这张图' },
      { type: 'image', mime: 'image/png', dataRef: a.url }
    ]))

    const rows = repo.attachmentRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(a.id)
  })

  it('★ size 不为 0 —— dataRef 是 URL,直接 statSync 会静默得到 0', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })
    repo.commitMessage('S1', msg('M1', [{ type: 'image', mime: 'image/png', dataRef: a.url }]))

    // size 是上传时记的真实字节数,提交这一步不该把它冲掉
    expect(repo.getAttachmentRow(a.id)?.size).toBe(3)
  })

  it('提交后挂上 session_id 与 message_id,状态转为 committed', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })
    repo.commitMessage('S1', msg('M1', [{ type: 'image', mime: 'image/png', dataRef: a.url }]))

    const row = repo.getAttachmentRow(a.id)
    expect(row?.status).toBe('committed')
    expect(repo.attachmentRows()[0]?.messageId).toBe('M1')
    expect(repo.attachmentRows()[0]?.sessionId).toBe('S1')
  })

  it('★ 删会话时受管理附件跟着走 —— CASCADE 现在才真正生效', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })
    repo.commitMessage('S1', msg('M1', [{ type: 'image', mime: 'image/png', dataRef: a.url }]))

    repo.deleteSession('S1')
    expect(repo.getAttachmentRow(a.id)).toBeUndefined()
  })
})

describe('外部绝对路径仍走原来的登记方式', () => {
  it('Agent 产出的图(非 ncw://)按 messageId:index 登记', () => {
    repo.commitMessage('S1', msg('M1', [
      { type: 'image', mime: 'image/png', dataRef: '/some/external/plot.png' }
    ]))

    const rows = repo.attachmentRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('M1:0')
  })

  it('★ 两类混在一条消息里互不干扰', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })
    repo.commitMessage('S1', msg('M1', [
      { type: 'image', mime: 'image/png', dataRef: a.url },
      { type: 'image', mime: 'image/png', dataRef: '/some/external/plot.png' }
    ]))

    const ids = repo.attachmentRows().map((r) => r.id).sort()
    expect(ids).toEqual([a.id, 'M1:1'].sort())
  })

  it('★ 重放同一条消息但移除了外部图,旧引用被清掉且不误伤受管理附件', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('IMG')
    })
    repo.commitMessage('S1', msg('M1', [
      { type: 'image', mime: 'image/png', dataRef: a.url },
      { type: 'image', mime: 'image/png', dataRef: '/some/external/plot.png' }
    ]))

    // 重放:只剩受管理的那张
    repo.commitMessage('S1', msg('M1', [{ type: 'image', mime: 'image/png', dataRef: a.url }]))

    const ids = repo.attachmentRows().map((r) => r.id)
    expect(ids).toEqual([a.id])
  })
})
