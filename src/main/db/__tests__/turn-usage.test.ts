/**
 * **「重启之后每一轮还看得见自己花了多少 Token」。**
 *
 * 用量一直是落盘的(`usage_records` 从第 3 条迁移起就有 `run_id`),真正缺的是
 * 反向那一跳:**哪条消息是哪个 run 产出的**。少了它,界面只能显示渲染进程内存里
 * 攒出来的那份,于是重启后逐轮读数集体消失 —— 看着像从来没记过账,而账其实一直在。
 *
 * 所以这里每个用例都真的关库重开,测的就是那一跳。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../shared/agent/message'
import type { UsageAttemptRecord } from '../../../shared/domain/usage'
import { DB_FILENAME, closeDatabase, openDatabase } from '../index'
import * as repo from '../repo'
import { MIGRATIONS } from '../schema'

let dir = ''

const restart = (): void => {
  closeDatabase()
  openDatabase(dir)
}

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-turn-usage-'))
  openDatabase(dir)
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const say = (id: string, text: string, createdAt = 1): AgentMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  createdAt,
  schemaVersion: 1
})

function attempt(id: string, runId: string, patch: Partial<UsageAttemptRecord> = {}): UsageAttemptRecord {
  return {
    id,
    at: 1_000,
    runId,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    attempt: 1,
    providerId: 'provider-1',
    providerName: 'Provider One',
    protocol: 'anthropic',
    endpoint: 'https://provider.example/v1/messages',
    alias: 'assistant',
    upstreamModel: 'model-a',
    responseModel: 'model-a',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 10,
    thinkingTokens: 5,
    thinkingTokensEstimated: false,
    latencyMs: 1_200,
    timeToFirstTokenMs: 250,
    ok: true,
    httpStatus: 200,
    errorKind: null,
    errorMessage: null,
    stopReason: 'end_turn',
    costMicros: 1_000,
    currency: 'USD',
    pricingTier: 0,
    pricingWindow: null,
    toolCalls: 0,
    toolErrors: 0,
    ...patch
  }
}

describe('逐轮用量', () => {
  it('重启后按 run 聚合回每一轮的用量', () => {
    repo.ensureSession({ id: 'session-1', workspaceId: 'workspace-1', title: '会话' })
    repo.commitMessage('session-1', say('m-1', '第一轮'), 'run-1')
    repo.commitMessage('session-1', say('m-2', '第二轮', 2), 'run-2')
    repo.recordUsageAttempt(attempt('u-1', 'run-1'))
    repo.recordUsageAttempt(attempt('u-2', 'run-2', { inputTokens: 7, outputTokens: 3 }))

    restart()

    const detail = repo.getSessionDetail('session-1')
    expect(detail?.messageRuns).toEqual({ 'm-1': 'run-1', 'm-2': 'run-2' })
    expect(detail?.runUsage?.['run-1']).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
      cacheCreation1hInputTokens: 10,
      reasoningTokens: 5
    })
    expect(detail?.runUsage?.['run-2']).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })

  it('同一轮里的重试合并成一笔,失败的那次也算进去', () => {
    repo.ensureSession({ id: 'session-1', workspaceId: 'workspace-1', title: '会话' })
    repo.commitMessage('session-1', say('m-1', '被限流后重试成功的一轮'), 'run-1')
    // 第一次被打回:prompt 已经发上去了,照样计费。排除它,界面上的数字就比账单小。
    repo.recordUsageAttempt(attempt('u-1', 'run-1', {
      ok: false, httpStatus: 429, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheWrite1hTokens: 0, thinkingTokens: null
    }))
    repo.recordUsageAttempt(attempt('u-2', 'run-1', { attempt: 2 }))

    restart()

    expect(repo.getSessionDetail('session-1')?.runUsage?.['run-1']).toMatchObject({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadInputTokens: 300
    })
  })

  it('编辑消息重写整段历史,不会把已有轮次的 run 归属抹掉', () => {
    repo.ensureSession({ id: 'session-1', workspaceId: 'workspace-1', title: '会话' })
    repo.commitMessage('session-1', say('m-1', '原文'), 'run-1')
    repo.recordUsageAttempt(attempt('u-1', 'run-1'))

    // `replaceHistory` 手上只有 AgentMessage,没有 run 归属 —— 它必须保留原值,
    // 否则用户改一个错别字就会把整条会话的历史用量读数清空。
    repo.replaceHistory('session-1', [say('m-1', '改过的原文')])
    restart()

    const detail = repo.getSessionDetail('session-1')
    expect(detail?.messages[0]?.parts).toEqual([{ type: 'text', text: '改过的原文' }])
    expect(detail?.messageRuns).toEqual({ 'm-1': 'run-1' })
    expect(detail?.runUsage?.['run-1']).toMatchObject({ inputTokens: 100 })
  })

  it('迁移之前的旧消息没有归属,不给占位 id', () => {
    repo.ensureSession({ id: 'session-1', workspaceId: 'workspace-1', title: '会话' })
    repo.commitMessage('session-1', say('m-old', '老对话'))

    restart()

    // 「不知道属于哪个 run」和「属于某个 run 但花了 0 token」在界面上是两件事:
    // 前者不显示用量,后者会显示一个假的 0。
    expect(repo.getSessionDetail('session-1')?.messageRuns).toEqual({})
  })

  it('另一条会话的用量不会串进来', () => {
    repo.ensureSession({ id: 'session-1', workspaceId: 'workspace-1', title: '会话一' })
    repo.ensureSession({ id: 'session-2', workspaceId: 'workspace-1', title: '会话二' })
    repo.commitMessage('session-1', say('m-1', '一'), 'run-1')
    repo.commitMessage('session-2', say('m-2', '二'), 'run-2')
    repo.recordUsageAttempt(attempt('u-1', 'run-1'))
    repo.recordUsageAttempt(attempt('u-2', 'run-2', { sessionId: 'session-2' }))

    restart()

    expect(Object.keys(repo.getSessionDetail('session-1')?.runUsage ?? {})).toEqual(['run-1'])
    expect(Object.keys(repo.getSessionDetail('session-2')?.runUsage ?? {})).toEqual(['run-2'])
  })

  /**
   * 升级路径和新建库是两条不同的代码路径:上面每个用例都是在**全新**库上跑完
   * 全部迁移,而真实用户是带着一个停在第 11 版、已经装着对话的库进来的。
   * `ALTER TABLE` 在那上面失败的话,应用是开不起来的 —— 不是少一个读数而已。
   */
  it('停在第 11 版的旧库能升上来,老消息保持无归属', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'nextcowork-v11-'))
    const raw = new DatabaseSync(join(legacy, DB_FILENAME))
    raw.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    const insert = raw.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const migration of MIGRATIONS.slice(0, 11)) {
      raw.exec(migration.sql)
      insert.run(migration.version, migration.name, Date.now())
    }
    raw.prepare('INSERT INTO sessions (id, workspace_id, title, model, mode, thinking, root_path_at_creation, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('session-1', 'workspace-1', '旧会话', 'model-a', 'normal', 'auto', '/tmp', 1, 1, '{}')
    raw.prepare('INSERT INTO messages (id, session_id, ordinal, role, parts, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m-old', 'session-1', 0, 'assistant', JSON.stringify([{ type: 'text', text: '升级前就存在' }]), 1, 1)
    raw.close()

    closeDatabase()
    openDatabase(legacy)
    try {
      repo.commitMessage('session-1', say('m-new', '升级后的一轮', 2), 'run-1')
      repo.recordUsageAttempt(attempt('u-1', 'run-1'))

      const detail = repo.getSessionDetail('session-1')
      expect(detail?.messages.map((m) => m.id)).toEqual(['m-old', 'm-new'])
      expect(detail?.messageRuns).toEqual({ 'm-new': 'run-1' })
      expect(detail?.runUsage?.['run-1']).toMatchObject({ inputTokens: 100 })
    } finally {
      closeDatabase()
      rmSync(legacy, { recursive: true, force: true })
      openDatabase(dir)
    }
  })
})
