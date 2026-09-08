/**
 * 上传服务的集成测试 —— 真 SQLite、真文件系统,只把 `electron` 换掉。
 *
 * 用真库真文件而不是全 mock:这一层的价值恰恰在于**落盘顺序与去重查询**,
 * 把 fs 和 sqlite 都换成假的之后,剩下能测的只有「函数调用了另一个函数」。
 *
 * ★ `electron` 整个替掉:`app.getPath` 与 `dialog` 在 node 环境不存在。
 * 附件根指向临时目录,于是 `attachmentRoot()` 跟着走。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userDataDir },
  dialog: { showOpenDialog: vi.fn() }
}))

import { dialog } from 'electron'
import { MAX_ATTACHMENT_BYTES } from '../../../shared/domain/attachment'
import { closeDatabase, openDatabase } from '../../db'
import * as repo from '../../db/repo'
import { attachmentRoot } from '../../net/attachment-protocol'
import { listSessionAttachments, pickAttachments, removeAttachment, uploadAttachment } from '../attachment'

const bytesOf = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(s, 'utf8')) as Uint8Array<ArrayBuffer>

beforeEach(() => {
  closeDatabase()
  userDataDir = mkdtempSync(join(tmpdir(), 'nextcowork-att-'))
  openDatabase(userDataDir)
})

afterEach(() => {
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('uploadAttachment', () => {
  it('落盘到 sessions/<id>/ 并返回 ncw:// URL,不泄漏绝对路径', () => {
    const a = uploadAttachment({
      scope: 'session',
      ownerId: 'S1',
      displayName: '截图.png',
      mime: 'image/png',
      bytes: bytesOf('PNGDATA')
    })

    expect(a.url).toMatch(/^ncw:\/\/attachments\/sessions\/S1\/[0-9A-Z]+\.png$/)
    expect(JSON.stringify(a)).not.toContain(userDataDir)
    expect(a.displayName).toBe('截图.png')
    expect(a.size).toBe(7)

    const dir = join(attachmentRoot(), 'sessions', 'S1')
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, files[0] as string), 'utf8')).toBe('PNGDATA')
  })

  it('★ 同内容重复上传去重:只占一份磁盘,返回同一个 id', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('SAME')
    })
    const b = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'b.png', mime: 'image/png', bytes: bytesOf('SAME')
    })

    expect(b.id).toBe(a.id)
    expect(readdirSync(join(attachmentRoot(), 'sessions', 'S1'))).toHaveLength(1)
    // displayName 各记各的 —— 去重的是字节,不是用户对它的称呼
    expect(b.displayName).toBe('b.png')
  })

  it('★ 去重不跨 owner:换个会话就该有自己的一份,否则删会话会波及别人', () => {
    uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('SAME')
    })
    const b = uploadAttachment({
      scope: 'session', ownerId: 'S2', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('SAME')
    })

    expect(readdirSync(join(attachmentRoot(), 'sessions', 'S1'))).toHaveLength(1)
    expect(readdirSync(join(attachmentRoot(), 'sessions', 'S2'))).toHaveLength(1)
    expect(b.ownerId).toBe('S2')
  })

  it('★ 去重命中但文件已被外部删除时,重新落盘而不是返回一条死记录', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('SAME')
    })
    const dir = join(attachmentRoot(), 'sessions', 'S1')
    rmSync(join(dir, readdirSync(dir)[0] as string))

    const b = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('SAME')
    })
    expect(b.id).not.toBe(a.id)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('theme scope 落在 themes/ 下且不带 owner 目录', () => {
    const a = uploadAttachment({
      scope: 'theme', displayName: 't.png', mime: 'image/png', bytes: bytesOf('T')
    })
    expect(a.url).toMatch(/^ncw:\/\/attachments\/themes\/[0-9A-Z]+\.png$/)
    expect(existsSync(join(attachmentRoot(), 'themes'))).toBe(true)
  })

  it('超限与空文件被拒', () => {
    expect(() =>
      uploadAttachment({
        scope: 'session', ownerId: 'S1', displayName: 'e', mime: 'image/png',
        bytes: new Uint8Array(0) as Uint8Array<ArrayBuffer>
      })
    ).toThrow()

    expect(() =>
      uploadAttachment({
        scope: 'session', ownerId: 'S1', displayName: 'big', mime: 'application/zip',
        bytes: new Uint8Array(33 * 1024 * 1024) as Uint8Array<ArrayBuffer>
      })
    ).toThrow(/上限/)
  })

  it('★ 落盘后不留 .tmp 残片 —— 原子替换的可观测证据', () => {
    uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('X')
    })
    const files = readdirSync(join(attachmentRoot(), 'sessions', 'S1'))
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(files.some((f) => f.startsWith('.'))).toBe(false)
  })

  it('★ 登记为 draft 而不是 committed —— 文件在磁盘上但还没进任何消息', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a.png', mime: 'image/png', bytes: bytesOf('X')
    })
    expect(repo.getAttachmentRow(a.id)?.status).toBe('draft')
  })

  it('未知 mime 落到 .bin,不产生无扩展名文件', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'x', mime: 'application/x-weird', bytes: bytesOf('X')
    })
    expect(a.url.endsWith('.bin')).toBe(true)
  })
})

describe('listSessionAttachments', () => {
  it('只列出该会话的草稿附件', () => {
    uploadAttachment({ scope: 'session', ownerId: 'S1', displayName: 'a', mime: 'image/png', bytes: bytesOf('A') })
    uploadAttachment({ scope: 'session', ownerId: 'S1', displayName: 'b', mime: 'image/png', bytes: bytesOf('B') })
    uploadAttachment({ scope: 'session', ownerId: 'S2', displayName: 'c', mime: 'image/png', bytes: bytesOf('C') })

    expect(listSessionAttachments({ sessionId: 'S1' })).toHaveLength(2)
    expect(listSessionAttachments({ sessionId: 'S2' })).toHaveLength(1)
  })

  it('已提交的不再算草稿', () => {
    /*
      ★ 先建**会话行与消息行**:`commitAttachmentsByPath` 要写 session_id 与
      message_id,两列上各有一条外键。真实路径里它由 `commitMessage` 在插完
      消息之后调用 —— 测试要如实模拟这个前提,而不是绕开它。

      这两条外键正是「上传时不能写 session_id」的同一个约束在另一端的体现:
      附件的登记必须晚于它所属的消息,而上传必须早于消息。draft/committed
      两态存在的理由就在这个时间差里。
    */
    repo.ensureSession({ id: 'S1', workspaceId: 'W1', rootPathAtCreation: '/tmp' })
    repo.commitMessage('S1', {
      id: 'M1',
      role: 'user',
      parts: [{ type: 'text', text: '带图的消息' }],
      createdAt: Date.now(),
      schemaVersion: 1
    })

    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a', mime: 'image/png', bytes: bytesOf('A')
    })
    const row = repo.getAttachmentRow(a.id)
    repo.commitAttachmentsByPath([row?.path as string], 'M1', 'S1')
    expect(listSessionAttachments({ sessionId: 'S1' })).toHaveLength(0)
    expect(repo.getAttachmentRow(a.id)?.status).toBe('committed')
  })
})

describe('removeAttachment', () => {
  it('文件与记录一起消失', () => {
    const a = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: 'a', mime: 'image/png', bytes: bytesOf('A')
    })
    const path = repo.getAttachmentRow(a.id)?.path as string
    expect(existsSync(path)).toBe(true)

    removeAttachment({ id: a.id })
    expect(existsSync(path)).toBe(false)
    expect(repo.getAttachmentRow(a.id)).toBeUndefined()
  })

  it('删不存在的 id 不抛', () => {
    expect(() => { removeAttachment({ id: 'nope' }) }).not.toThrow()
  })
})

describe('显示名(迁移 6)', () => {
  /**
   * ★ 磁盘文件名是 ULID,所以「用户看到的名字」必须单独存一列。
   * 不存的表现很具体:传图 → 关应用 → 重开,chip 从「季度报表.png」
   * 变成「01J8XQZ4M7.png」—— 而 ULID 恰恰是为了不让人认路径才选的。
   */
  it('重启后列回来的仍是原始名,不是 ULID 文件名', () => {
    uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: '季度报表.png',
      mime: 'image/png', bytes: bytesOf('A')
    })

    const restored = listSessionAttachments({ sessionId: 'S1' })
    expect(restored[0]?.displayName).toBe('季度报表.png')
    // 磁盘上仍是 ULID —— 两者是分开的
    expect(restored[0]?.url).toMatch(/\/[0-9A-Z]{26}\.png$/)
  })

  it('★ 去重命中时显示名取本次的 —— 去重的是字节,不是用户对它的称呼', () => {
    uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: '旧名.png',
      mime: 'image/png', bytes: bytesOf('SAME')
    })
    const b = uploadAttachment({
      scope: 'session', ownerId: 'S1', displayName: '新名.png',
      mime: 'image/png', bytes: bytesOf('SAME')
    })
    expect(b.displayName).toBe('新名.png')
  })
})

describe('会话行不存在时也能上传', () => {  /**
   * ★ 这条用例钉的是一个真实缺陷:`attachments.session_id` 上有指向 `sessions`
   * 的外键,而上传发生在**发送之前** —— 新建对话还没发第一条消息时,
   * `sessions` 表里没有那一行。早先的实现往 `session_id` 里写 ownerId,
   * 于是每一次「新对话里先传图」都直接 FOREIGN KEY constraint failed。
   *
   * 现在 draft 只写无外键的 `owner_id`,`session_id` 留到消息提交那一刻再填。
   */
  it('全新 sessionId(sessions 表里没有这一行)不触发外键失败', () => {
    expect(() =>
      uploadAttachment({
        scope: 'session',
        ownerId: 'BRAND-NEW-SESSION',
        displayName: 'a.png',
        mime: 'image/png',
        bytes: bytesOf('A')
      })
    ).not.toThrow()

    expect(listSessionAttachments({ sessionId: 'BRAND-NEW-SESSION' })).toHaveLength(1)
  })
})

/**
 * ★ 这一组锁的是**两个入口的行为等价**,不是 dialog 本身。
 *
 * 菜单「添加附件」与拖拽/粘贴必须给出同形的托盘项:图片落盘、非图片只带路径。
 * 曾经不是这样 —— 菜单一律落盘,而非图片落盘后在 `partsOf` 那边退化成一句
 * 「[附件] 名字」,于是同一个 PDF 从菜单进来模型读不到,从拖拽进来能读到。
 */
describe('pickAttachments —— 与拖拽/粘贴同一套分流', () => {
  const showOpenDialog = vi.mocked(dialog.showOpenDialog)

  /** 在临时目录里造一个真文件,返回它的绝对路径 */
  function fixture(name: string, content: string): string {
    const path = join(userDataDir, name)
    writeFileSync(path, content)
    return path
  }

  beforeEach(() => {
    showOpenDialog.mockReset()
  })

  it('★ 非图片不落盘,只回传用户选中的真实路径', async () => {
    const path = fixture('说明.pdf', 'PDFDATA')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })

    const out = await pickAttachments({ scope: 'session', ownerId: 'S1' })

    expect(out).toEqual([{ kind: 'path', path, name: '说明.pdf' }])
    // 一个字节都不该被复制到附件根下
    expect(existsSync(join(attachmentRoot(), 'sessions', 'S1'))).toBe(false)
    expect(repo.listDraftAttachments('S1')).toHaveLength(0)
  })

  it('图片仍走落盘 —— 内联展示要有 ncw:// 地址', async () => {
    const path = fixture('截图.png', 'PNGDATA')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })

    const out = await pickAttachments({ scope: 'session', ownerId: 'S1' })

    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('attachment')
    const a = out[0]?.kind === 'attachment' ? out[0].attachment : undefined
    expect(a?.url).toMatch(/^ncw:\/\/attachments\/sessions\/S1\/[0-9A-Z]+\.png$/)
    expect(a?.displayName).toBe('截图.png')
    // ★ 绝对路径不出主进程,这一支的约束没有被放松
    expect(JSON.stringify(a)).not.toContain(userDataDir)
  })

  it('★ 超限的非图片仍然回传,超限的图片仍然被跳过', async () => {
    // 稀疏文件:声明 33MB 但不占磁盘,跑得比写 33MB 快得多
    const big = fixture('巨大.log', '')
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1)
    const bigPng = fixture('巨图.png', '')
    truncateSync(bigPng, MAX_ATTACHMENT_BYTES + 1)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [big, bigPng] })

    const out = await pickAttachments({ scope: 'session', ownerId: 'S1' })

    // 上限存在的理由是结构化克隆的卡顿,而路径这一支根本不读字节 ——
    // 拖一个 200MB 的日志进来是可以的,菜单选同一个文件没有理由被静默丢掉。
    expect(out).toEqual([{ kind: 'path', path: big, name: '巨大.log' }])
  })

  it('单个文件失败不拖垮整批', async () => {
    const ok = fixture('好.pdf', 'A')
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [join(userDataDir, '不存在.pdf'), ok]
    })

    const out = await pickAttachments({ scope: 'session', ownerId: 'S1' })
    expect(out).toEqual([{ kind: 'path', path: ok, name: '好.pdf' }])
  })

  it('目录被跳过 —— 不递归展开', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [userDataDir] })
    expect(await pickAttachments({ scope: 'session', ownerId: 'S1' })).toEqual([])
  })

  it('取消返回空数组', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await pickAttachments({ scope: 'session' })).toEqual([])
  })
})
