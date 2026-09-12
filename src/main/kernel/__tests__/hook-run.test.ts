import { describe, expect, it, vi } from 'vitest'
import type { HookDefinition } from '../../../shared/domain/hook'
import { runHook, runHookChain, type HookPayload, type HookProcess, type HookProcessOpen } from '../hook/run'

const hook = (over: Partial<HookDefinition> = {}): HookDefinition => ({
  id: 'h1',
  event: 'PreToolUse',
  command: 'guard.sh',
  enabled: true,
  timeoutMs: 1000,
  ...over
})

const payload: HookPayload = {
  event: 'PreToolUse',
  sessionId: 's1',
  runId: 'r1',
  workspaceRoot: '/ws',
  scope: 'project'
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p)
}

/** 假进程。★ 不 fork 真的东西：这一层要测的是协议，不是 shell。 */
function fakeOpen(config: {
  stdout?: string[]
  stderr?: string[]
  code?: number | null
  /** 永不退出，用来测超时。 */
  hang?: boolean
  onSpawn?: (command: string, args: readonly string[], cwd: string) => void
  throwOnSpawn?: boolean
}): HookProcessOpen & { stdinData: string[]; killed: () => number } {
  const stdinData: string[] = []
  let killCount = 0
  let resolveExit: ((v: { code: number | null }) => void) | undefined

  const open = (async (command, args, options) => {
    if (config.throwOnSpawn === true) throw new Error('ENOENT')
    config.onSpawn?.(command, args, options.cwd)
    const process: HookProcess = {
      stdin: { write: (c: string) => stdinData.push(c), end: () => undefined },
      stdout: chunks(...(config.stdout ?? [])),
      stderr: chunks(...(config.stderr ?? [])),
      exited: config.hang === true
        ? new Promise((resolve) => { resolveExit = resolve })
        : Promise.resolve({ code: config.code ?? 0 }),
      kill: () => {
        killCount += 1
        resolveExit?.({ code: null })
      }
    }
    return process
  }) as HookProcessOpen & { stdinData: string[]; killed: () => number }
  open.stdinData = stdinData
  open.killed = (): number => killCount
  return open
}

const SHELL = { command: '/bin/sh', args: (c: string): string[] => ['-c', c] }
const run = (open: HookProcessOpen, h = hook(), signal?: AbortSignal): ReturnType<typeof runHook> =>
  runHook({ open, hook: h, scope: 'project', payload, cwd: '/ws', shell: SHELL, ...(signal ? { signal } : {}) })

describe('runHook · 协议', () => {
  it('★ stdin 收到的就是那一行 JSON', async () => {
    const open = fakeOpen({})
    await run(open)
    expect(open.stdinData).toHaveLength(1)
    expect(JSON.parse(open.stdinData[0] as string)).toEqual(payload)
    expect(open.stdinData[0]?.endsWith('\n')).toBe(true)
  })

  it('命令经 shell 执行，cwd 是工作区根', async () => {
    let seen: { command: string; args: readonly string[]; cwd: string } | null = null
    const open = fakeOpen({ onSpawn: (command, args, cwd) => { seen = { command, args, cwd } } })
    await run(open, hook({ command: 'echo hi && ls' }))
    expect(seen).toEqual({ command: '/bin/sh', args: ['-c', 'echo hi && ls'], cwd: '/ws' })
  })

  it('exit 0 + 普通文本 → 整段当 additionalContext', async () => {
    const out = await run(fakeOpen({ stdout: ['提醒：先跑 lint'] }))
    expect(out.outcome).toBe('ok')
    expect(out.additionalContext).toBe('提醒：先跑 lint')
    expect(out.decision).toBeUndefined()
  })

  it('exit 0 + 结构化 JSON → 按字段读', async () => {
    const out = await run(fakeOpen({ stdout: ['{"decision":"ask","reason":"需要人看一眼"}'] }))
    expect(out.decision).toBe('ask')
    expect(out.reason).toBe('需要人看一眼')
  })

  it('看着像 JSON 但坏了 → 当普通文本，不丢用户的输出', async () => {
    const out = await run(fakeOpen({ stdout: ['{ 没写完'] }))
    expect(out.additionalContext).toBe('{ 没写完')
  })

  it('认不出的 decision 值忽略掉，不当成 deny', async () => {
    const out = await run(fakeOpen({ stdout: ['{"decision":"maybe"}'] }))
    expect(out.decision).toBeUndefined()
  })

  it('★ exit 2 = 阻断，stderr 当理由', async () => {
    const out = await run(fakeOpen({ code: 2, stderr: ['这条命令碰了生产库'] }))
    expect(out.outcome).toBe('blocked')
    expect(out.decision).toBe('deny')
    expect(out.reason).toBe('这条命令碰了生产库')
  })

  it('exit 2 但 stderr 空 → 退回 stdout，别给一个空理由', async () => {
    const out = await run(fakeOpen({ code: 2, stdout: ['被策略拦下'] }))
    expect(out.reason).toBe('被策略拦下')
  })

  it('★ 其余非零不阻断 —— 一个 command not found 不该拦下整轮运行', async () => {
    const out = await run(fakeOpen({ code: 127, stderr: ['not found'] }))
    expect(out.outcome).toBe('ok')
    expect(out.decision).toBeUndefined()
    expect(out.exitCode).toBe(127)
  })

  it('起不来记成 spawn-failed，也不阻断', async () => {
    const out = await run(fakeOpen({ throwOnSpawn: true }))
    expect(out.outcome).toBe('spawn-failed')
    expect(out.decision).toBeUndefined()
  })
})

describe('runHook · 超时与中断', () => {
  it('★ 超时会 kill，并且不阻断', async () => {
    vi.useFakeTimers()
    try {
      const open = fakeOpen({ hang: true })
      const promise = run(open, hook({ timeoutMs: 50 }))
      await vi.advanceTimersByTimeAsync(60)
      const out = await promise
      expect(out.outcome).toBe('timeout')
      expect(out.decision).toBeUndefined()
      expect(open.killed()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abort 时 kill —— 用户点了停止，不该因此看到一个错误', async () => {
    const open = fakeOpen({ hang: true })
    const controller = new AbortController()
    const promise = run(open, hook(), controller.signal)
    controller.abort()
    const out = await promise
    expect(out.outcome).toBe('timeout')
    expect(open.killed()).toBe(1)
  })
})

describe('runHook · 输出上限', () => {
  it('★ stdout 超 8KB 截断，但流仍然读完 —— 不读会把管道写满让子进程卡死', async () => {
    // 分成很多块，只有「读完」才会全部被消费
    const parts = Array.from({ length: 20 }, () => 'x'.repeat(1024))
    const open = fakeOpen({ stdout: parts })
    const out = await run(open)
    expect(out.stdout.length).toBe(8 * 1024)
    // 走到这里就说明迭代器被消费干净了：readCapped 提前 return 的话 Promise.all 不会 resolve
    expect(out.outcome).toBe('ok')
  })

  it('stderr 上限是 4KB', async () => {
    const out = await run(fakeOpen({ code: 1, stderr: [Array.from({ length: 10 }, () => 'y'.repeat(1024)).join('')] }))
    expect(out.stderr.length).toBe(4 * 1024)
  })
})

describe('runHookChain', () => {
  const rep = (id: string, over: Record<string, unknown> = {}) => ({
    hookId: id, scope: 'project' as const, exitCode: 0, stdout: '', stderr: '',
    durationMs: 1, outcome: 'ok' as const, ...over
  })

  it('按顺序跑完', async () => {
    const seen: string[] = []
    const out = await runHookChain(
      [{ hook: hook({ id: 'a' }), scope: 'global' }, { hook: hook({ id: 'b' }), scope: 'project' }],
      async (h) => { seen.push(h.id); return rep(h.id) }
    )
    expect(seen).toEqual(['a', 'b'])
    expect(out).toHaveLength(2)
  })

  it('★ 首个阻断即短路 —— 后面的不再跑', async () => {
    const seen: string[] = []
    await runHookChain(
      [{ hook: hook({ id: 'a' }), scope: 'global' }, { hook: hook({ id: 'b' }), scope: 'project' }],
      async (h) => {
        seen.push(h.id)
        return h.id === 'a' ? rep('a', { outcome: 'blocked', decision: 'deny' }) : rep(h.id)
      }
    )
    expect(seen).toEqual(['a'])
  })

  it('关掉的那些直接跳过', async () => {
    const seen: string[] = []
    await runHookChain(
      [{ hook: hook({ id: 'off', enabled: false }), scope: 'global' }, { hook: hook({ id: 'on' }), scope: 'project' }],
      async (h) => { seen.push(h.id); return rep(h.id) }
    )
    expect(seen).toEqual(['on'])
  })
})
