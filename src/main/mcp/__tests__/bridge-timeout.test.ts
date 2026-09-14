/**
 * MCP 工具调用的**墙钟上限**。
 *
 * `manager.ts` 一直给 `connect`(30s)和 `listTools`(15s)上着闸,唯独真正执行的
 * 那一次漏了:握手成功、工具列出来了、然后某次 `callTool` 一去不回 ——
 * 而 `bridge.ts` 那边只有 `ctx.signal`,没有任何超时。除非用户自己按停止,
 * 否则那个 await **永远不会结算**。子代理尤其致命:它没人看着,卡片上只剩
 * 一个不动的「运行中」,工具调用数停在某个数字上再也不变。
 *
 * 这份文件钉三件事,缺一件这道闸就只是个摆设:
 *
 * 1. 到点之后**返回 `toolFail` 而不是抛出** —— 超时要收敛成一次普通的工具失败,
 *    进转录、模型看得见、能换条路,run 继续跑。抛出去的话整条 run 就断了。
 * 2. 传给 `callTool` 的那个 signal **真的被 abort 了**。只 race 不 abort 是不够的:
 *    远端那次调用还在跑,一个正在建 PR 的工具会把 PR 建完 —— 正是 `bridge.ts`
 *    文件头担心的那件事。
 * 3. 用户按停止时**照旧往上抛**。中断不是一次工具失败,`agent-session.ts`
 *    要靠它把整条 run 收成 `aborted`。
 *
 * ★ 这里用假 client 而不是 `manager.test.ts` 那台真服务器:要测的是「对面不回话」,
 * 而一台真服务器**没有办法表演不回话**(`InMemoryTransport` 两端都是同步的)。
 * 协议往返那一半由 `manager.test.ts` 用真服务器覆盖着,两份各测各的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServerConfig } from '../../../shared/domain/mcp'
import { nodeHost } from '../../kernel/host'
import type { ToolContext, ToolRegistration } from '../../kernel/tool/registry'
import { isRejected, toRegistration } from '../bridge'

const host = nodeHost()

const cfg: McpServerConfig = {
  id: 'demo',
  name: '演示服务器',
  enabled: true,
  transport: 'stdio',
  command: 'true',
  args: [],
  envNames: []
}

const descriptor = {
  name: 'slow_tool',
  description: '一个不回包的工具',
  inputSchema: { type: 'object' as const, properties: {} }
}

function ctx(signal = new AbortController().signal): ToolContext {
  return {
    workspaceRoot: '/tmp',
    signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'c1',
    runId: 'r1',
    host,
    emit: () => {}
  }
}

/**
 * 一个永远不回包的 client,顺便把它收到的那个 signal 交出来。
 *
 * `honorSignal`(缺省开着)决定它像不像一个**真的** SDK client:真 client 收到
 * abort 会立刻把那次请求拒掉。这一项之所以可调,是因为两种服务器都存在 ——
 * 认取消的,和连取消都不理的。两种都必须收敛成一次工具失败。
 */
function silentClient(honorSignal = true): {
  client: Pick<Client, 'callTool'>
  seen: () => AbortSignal | undefined
} {
  let captured: AbortSignal | undefined
  return {
    client: {
      callTool: ((_req: unknown, _schema: unknown, opts?: { signal?: AbortSignal }) => {
        captured = opts?.signal
        return new Promise((_resolve, reject) => {
          // 刻意不结算 —— 这就是「服务器连上了却不回话」
          if (!honorSignal) return
          opts?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('This operation was aborted')
              err.name = 'AbortError'
              reject(err)
            },
            { once: true }
          )
        })
      }) as Pick<Client, 'callTool'>['callTool']
    },
    seen: () => captured
  }
}

function register(client: Pick<Client, 'callTool'>): ToolRegistration {
  const reg = toRegistration(cfg, descriptor, client)
  if (isRejected(reg)) throw new Error(`注册被拒:${reg.reason}`)
  return reg
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MCP 工具调用 · 墙钟上限', () => {
  it('★ 对面不回话时,60 秒后收敛成一次工具失败(而不是永远挂着)', async () => {
    const { client } = silentClient()
    const pending = register(client).execute({}, ctx())

    // 59 秒:还在等 —— 闸不能提前落下,工具本来就可能慢
    await vi.advanceTimersByTimeAsync(59_000)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    const result = await pending

    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('slow_tool')
    expect(result.output.content).toContain('60')
  })

  /**
   * ★★ 这一条才是「超时」和「放弃等待」的分界。
   *
   * 只 race 不 abort 的话,我们这边返回了失败,远端那次调用仍在跑到底 ——
   * 模型以为没发生,而 PR 已经建好了。所以断言的是**那个 signal 被 abort 了**。
   */
  it('★ 超时会真的取消远端那次调用 —— 传下去的 signal 被 abort', async () => {
    const { client, seen } = silentClient()
    const pending = register(client).execute({}, ctx())

    expect(seen()).toBeDefined()
    expect(seen()?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(61_000)
    await pending

    expect(seen()?.aborted).toBe(true)
  })

  /**
   * 用户按停止:`isAbortError` 命中,**原样抛出**。
   *
   * 伪装成工具失败的话模型会接着往下跑 —— 用户按了停止,界面停了,
   * 而模型在后台又调了三个工具。
   */
  it('用户按停止时原样抛出,不伪装成工具失败', async () => {
    const outer = new AbortController()
    const { client } = silentClient()
    const pending = register(client).execute({}, ctx(outer.signal))
    const caught = pending.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.name : 'unknown')
    )

    outer.abort()
    await vi.advanceTimersByTimeAsync(1)

    expect(await caught).toBe('AbortError')
  })

  /**
   * ★★ 连取消都不理的服务器也得收住。
   *
   * 上面那条用的是「认取消」的假 client,于是超时那一刻有**两个**拒绝在赛跑:
   * `withDeadline` 自己那个普通 Error,和 client 因为 signal 被 abort 抛出的
   * AbortError。赢的必须是前者 —— 后者赢的话 `bridge.ts` 会 `isAbortError` 命中
   * 并原样抛出,一次工具超时就变成了「整条 run 被中断」,而用户根本没按过停止。
   * 这一条把不认取消的那一半也钉住:两种服务器给出的都是工具失败。
   */
  it('连取消都不理的服务器,同样收敛成工具失败而不是中断整条 run', async () => {
    const { client } = silentClient(false)
    const pending = register(client).execute({}, ctx())
    await vi.advanceTimersByTimeAsync(61_000)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('slow_tool')
  })

  /** 正常回包的工具一点不受影响 —— 闸只在不回话时才动 */
  it('按时回包的工具照常拿到结果', async () => {
    const client: Pick<Client, 'callTool'> = {
      callTool: (() => Promise.resolve({ content: [{ type: 'text', text: '干完了' }] })) as Pick<
        Client,
        'callTool'
      >['callTool']
    }
    const result = await register(client).execute({}, ctx())
    expect(result.isError).toBe(false)
    expect(result.output.content).toContain('干完了')
  })
})
