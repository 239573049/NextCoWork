/**
 * **删了消息,压缩检查点得跟着走。**
 *
 * 线上症状是用户删光一整段对话之后,顶部那个「上下文检查点」面板上还挂着一条
 * 「Mechanically compacted 56 message(s)…」,而下面的转录只剩一句「您好」——
 * 它锚在一条已经不存在的消息上,画不出线,于是永远赖在面板里。
 *
 * 比面板更要命的是另一头:`agent-session` 启动时会把最新那条**非机械**检查点
 * 恢复成 `contextNote`,再由 `withSummary` 塞进每一次请求。也就是说手动
 * `/compact` 之后再删一轮,一段描述已删内容的摘要会被继续发给模型 ——
 * 用户删了消息,模型却还记得,而且全程不报错。所以两种 source 各测一条。
 *
 * 测 `repo.replaceHistory` 而不是渲染层的 `deleteTurn`:清理**必须**跟消息改写
 * 在同一个事务里,而这个函数是「用户有意改写转录」的唯一入口(删一轮、编辑消息、
 * 编辑后重跑都汇到这儿)。在调用点上测,等于给每条路各留一次忘记的机会。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../shared/agent/message'
import type { ContextCheckpointSource } from '../../../shared/agent/context-management'
import { closeDatabase, openDatabase } from '../index'
import * as repo from '../repo'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-cporphan-db-'))
  openDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const SESSION = 'session-1'

function say(id: string, role: AgentMessage['role'], text = id): AgentMessage {
  return { id, role, createdAt: 1_700_000_000_000, schemaVersion: 1, parts: [{ type: 'text', text }] }
}

/** 三条消息 + 两个检查点,分别锚在 m1 和 m3 上。 */
function seed(source: ContextCheckpointSource = 'mechanical'): AgentMessage[] {
  repo.ensureSession({ id: SESSION, workspaceId: 'w' })
  const messages = [say('m1', 'user'), say('m2', 'assistant'), say('m3', 'user')]
  repo.replaceHistory(SESSION, messages)
  repo.upsertContextCheckpoint({
    id: 'cp-early', sessionId: SESSION, windowIndex: 0, note: '早窗', source,
    coveredThroughMessageId: 'm1', createdAt: 1, updatedAt: 1, revision: 1
  })
  repo.upsertContextCheckpoint({
    id: 'cp-late', sessionId: SESSION, windowIndex: 1, note: '晚窗', source,
    coveredThroughMessageId: 'm3', createdAt: 1, updatedAt: 1, revision: 1
  })
  return messages
}

const ids = (): string[] => repo.listContextCheckpoints(SESSION).map((c) => c.id)

describe('改写历史时回收锚不回去的检查点', () => {
  it('锚点被删掉的那条消失,锚点还在的那条留下', () => {
    const messages = seed()
    repo.replaceHistory(SESSION, messages.filter((m) => m.id !== 'm3'))
    expect(ids()).toEqual(['cp-early'])
  })

  it('★ 手动摘要同样回收 —— 否则它会被当成 contextNote 继续发给模型', () => {
    const messages = seed('manual')
    repo.replaceHistory(SESSION, messages.filter((m) => m.id !== 'm3'))
    expect(ids()).toEqual(['cp-early'])
  })

  it('★ 只是改内容、一条没删时,检查点一条都不动', () => {
    const messages = seed()
    // 真的改了正文(走的是写入分支,不是「什么都没变」那条提前返回)
    repo.replaceHistory(SESSION, messages.map((m) => m.id === 'm2' ? say('m2', 'assistant', '改过的正文') : m))
    expect(ids()).toEqual(['cp-early', 'cp-late'])
  })

  it('★ 没有锚点字段的老数据留着 —— 分不清是历史还在还是被删了,而误删不可逆', () => {
    repo.ensureSession({ id: SESSION, workspaceId: 'w' })
    repo.replaceHistory(SESSION, [say('m1', 'user'), say('m2', 'assistant')])
    repo.upsertContextCheckpoint({
      id: 'cp-legacy', sessionId: SESSION, windowIndex: 0, note: '老数据',
      source: 'model', createdAt: 1, updatedAt: 1, revision: 1
    })
    repo.replaceHistory(SESSION, [say('m1', 'user')])
    expect(ids()).toEqual(['cp-legacy'])
  })

  it('★ 覆盖范围里有被删消息、但锚点还在时留着 —— 它同时概括着大量还在的消息', () => {
    const messages = seed()
    // 删掉 m1(cp-late 的摘要里必然提到它),但 cp-late 锚在 m3 上,线还有地方可落
    repo.replaceHistory(SESSION, messages.filter((m) => m.id !== 'm1'))
    expect(ids()).toEqual(['cp-late'])
  })
})
