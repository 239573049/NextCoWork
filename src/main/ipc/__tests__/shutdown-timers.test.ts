/**
 * 退出时把后台轮询停掉。
 *
 * `before-quit` 的末尾是 `closeDatabase({ final: true })` —— **封库**,之后任何读写
 * 都抛 `DatabaseClosedError`。但配置同步(5 秒一轮)和登录态刷新(5 分钟一轮)这两条
 * interval 都 `unref()` 过:unref 只是「不拦着进程退出」,**不是「不再触发」**,
 * 在进程真正走完退出流程之前它们照常到点就跑,而两条的第一句都是去摸库。
 *
 * 症状只有退出时控制台里一条 UnhandledPromiseRejection,数据一个字节都没坏,
 * 所以极易被当噪音 —— 但它说的是「关灯之后还有人在写库」。
 *
 * 两条断言分工不同:
 *  - 主修是**把表停掉**(第一条)。
 *  - 兜底是**万一还有一发在路上,拒绝也不许漏出去**(第二条)—— 只有前者的话,
 *    任何一条新加的、忘了登记进 `shutdownClientAuth()` 的轮询都会把这个 bug 原样带回来。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: {}, BrowserWindow: { getAllWindows: () => [] } }))

import { closeDatabase, openDatabase } from '../../db/index'
import { nodeHost } from '../../kernel/host'
import { installHost, resetRuntimeForTest } from '../../runtime'
import { store } from '../../state/store'
import { getClientAuthState, shutdownClientAuth } from '../client-auth'
import { startConfigSync } from '../config-sync'

let dir = ''

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-shutdown-'))
  openDatabase(dir)
  resetRuntimeForTest()
  // 内存 secrets + 一律 404 的 fetch:这几条路径一步都不该出网。
  installHost(nodeHost({
    paths: { userData: () => join(dir, 'userData'), temp: () => tmpdir() },
    fetch: () => Promise.resolve(new Response('{}', { status: 404 }))
  }))
})

afterEach(() => {
  shutdownClientAuth()
  vi.useRealTimers()
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('退出时的后台轮询', () => {
  it('shutdownClientAuth() 把登录刷新和配置同步的定时器都清掉', () => {
    vi.useFakeTimers()
    store.setKv('client-auth.meta', {
      mode: 'authenticated',
      user: { id: 'u-1', email: 'a@b.invalid', name: 'A' },
      expiresAt: Date.now() + 3600_000
    })

    getClientAuthState()
    startConfigSync('acct-1')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    shutdownClientAuth()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('封库之后漏网的那一发轮询不会变成未捕获拒绝', async () => {
    // setImmediate 保持真的:下面要靠它跨过 Node 判定「这个拒绝没人接」的那一拍。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const rejections: unknown[] = []
    const collect = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', collect)
    try {
      startConfigSync('acct-2')
      await vi.advanceTimersByTimeAsync(0)

      closeDatabase({ final: true })
      await vi.advanceTimersByTimeAsync(5000)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(rejections).toEqual([])
    }
    finally {
      process.off('unhandledRejection', collect)
    }
  })
})
