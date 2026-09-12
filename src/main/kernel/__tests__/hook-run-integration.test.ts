/**
 * 钩子执行器的**集成**测试 —— 真的 fork 进程，真的走 shell。
 *
 * ★ 和 `hook-run.test.ts` 的分工：那一份用假的 `HookProcessOpen` 测**协议**
 *   （谁该返回什么），一个进程都不开；这一份测**协议之外的那一半** ——
 *   stdin 那行 JSON 到底有没有被脚本读到、`exit 2` 在真 shell 下是不是 2、
 *   超时的时候进程树是不是真的死了。
 *
 *   假进程测不出这些：它的 `stdin.write` 只是往数组里 push，`exited` 是一个
 *   立即 resolve 的 Promise。整套东西在假进程上全绿，而真跑起来第一条就卡住 ——
 *   这正是本文件存在的理由。
 *
 * POSIX only：Windows 没有进程组的等价物（`killTree` 那边走 `taskkill /T`，
 * 是另一条路径），而 CI 与开发机都是 POSIX。
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { HookDefinition } from '../../../shared/domain/hook'
import { runHook, type HookPayload, type HookProcessOpen } from '../hook/run'

const posix = process.platform !== 'win32'

/** 真进程。★ `detached` 与生产一致（`environment/local.ts` 只给钩子传 true）。 */
const realOpen: HookProcessOpen = async (command, args, options) => {
  const child = spawn(command, [...args], { cwd: options.cwd, stdio: 'pipe', detached: true })
  child.stdin.on('error', () => {})
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve({ code: null }))
    }),
    kill: () => {
      // 杀整个进程组，和 local.ts 的 detached 分支一致
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      }
    }
  }
}

const SHELL = { command: '/bin/sh', args: (c: string): string[] => ['-c', c] }

const payload: HookPayload = {
  event: 'PreToolUse',
  sessionId: 's1',
  runId: 'r1',
  workspaceRoot: process.cwd(),
  scope: 'project',
  toolName: 'Bash',
  toolInternalId: 'Bash',
  toolInput: { command: 'echo hello' }
}

const run = (command: string, timeoutMs = 5000): ReturnType<typeof runHook> => {
  const hook: HookDefinition = { id: 'h1', event: 'PreToolUse', command, enabled: true, timeoutMs }
  return runHook({ open: realOpen, hook, scope: 'project', payload, cwd: process.cwd(), shell: SHELL })
}

describe.skipIf(!posix)('钩子执行器 · 真进程', () => {
  it('★ stdin 那行 JSON 真的被脚本读到了', async () => {
    // 脚本把 stdin 读出来再原样吐回 stdout —— 只有真的写进去了才拿得到
    const out = await run('cat')
    expect(out.exitCode).toBe(0)
    // 断言 stdout 而不是 additionalContext：payload 本身是 JSON，原样吐回来会先
    // 过一遍 `parseDecision`（它认不出任何已知字段，于是整段当文本留着）。
    expect(JSON.parse(out.stdout)).toMatchObject({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'echo hello' }
    })
  })

  it('脚本能从 payload 里取出字段来判断', async () => {
    // 一条真实用法：只拦 Bash
    const out = await run(`grep -q '"toolInternalId":"Bash"' && echo 命中 || echo 没命中`)
    expect(out.additionalContext).toBe('命中')
  })

  it('★ exit 2 在真 shell 下确实是阻断', async () => {
    const out = await run('echo 这条命令碰了生产库 >&2; exit 2')
    expect(out.outcome).toBe('blocked')
    expect(out.decision).toBe('deny')
    expect(out.reason).toBe('这条命令碰了生产库')
  })

  it('结构化 JSON 回包走通', async () => {
    const out = await run(`printf '{"decision":"ask","reason":"看一眼"}'`)
    expect(out.decision).toBe('ask')
    expect(out.reason).toBe('看一眼')
  })

  it('★ 命令不存在不阻断 —— 一个 command not found 不该拦下整轮运行', async () => {
    const out = await run('这个命令肯定不存在-xyzzy')
    expect(out.outcome).toBe('ok')
    expect(out.decision).toBeUndefined()
    expect(out.exitCode).not.toBe(0)
  })

  it('cwd 真的生效', async () => {
    const out = await run('pwd')
    expect(out.additionalContext).toBe(process.cwd())
  })

  it('★ 超时会杀掉进程树，而不是只杀那一个 shell', async () => {
    const started = Date.now()
    // `sh -c "sleep 30"` 里 sleep 是 sh 的子进程：只杀 sh 的话 sleep 会活下来。
    // 用一个能被观测的形式：把 sleep 的 pid 写出来，杀完之后验证它没了。
    const out = await run('sleep 30 & echo $!; wait', 600)
    expect(out.outcome).toBe('timeout')
    // 600ms 超时 + 进程被杀，整体不该拖到 30 秒
    expect(Date.now() - started).toBeLessThan(5000)

    const orphan = Number.parseInt(out.stdout.trim(), 10)
    if (Number.isFinite(orphan)) {
      // 给信号一点传播时间
      await new Promise((r) => setTimeout(r, 300))
      let alive = true
      try { process.kill(orphan, 0) } catch { alive = false }
      expect(alive).toBe(false)
    }
  })

  it('★ 输出超上限时进程仍然能正常退出 —— 不读会把管道写满卡死子进程', async () => {
    // 吐 200KB，远超 8KB 上限
    const out = await run(`i=0; while [ $i -lt 200 ]; do printf '%1024d' 0; i=$((i+1)); done`)
    expect(out.outcome).toBe('ok')
    expect(out.exitCode).toBe(0)
    expect(out.stdout.length).toBe(8 * 1024)
  })
})
