import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAbortError } from '../abort'
import { nodeHost } from '../host'

/**
 * `SpawnFn` 的真进程测试。
 *
 * ★ 这里几乎每一条测的都不是「结果对不对」,而是**进程有没有真的死透**、
 * **命令会不会挂住**。这两类问题在打桩的测试里一律是绿的,而它们正是
 * bash 工具唯一会让用户痛的地方(「我点了停止,但端口还占着」)。
 */

const spawn = nodeHost().spawn

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-spawn-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function opts(over: Partial<{ cwd: string; signal: AbortSignal; timeoutMs: number }> = {}): {
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
} {
  return { cwd: root, signal: new AbortController().signal, ...over }
}

/** 轮询到进程真的不见了。★ 不用固定 sleep —— 那在 CI 上必然 flaky。 */
async function waitGone(pid: number, budgetMs = 3000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/** 轮询到子进程把 pid 写进文件。同上,不固定 sleep。 */
async function waitPidFile(path: string, budgetMs = 3000): Promise<number> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8').trim()
      if (raw !== '') return Number(raw)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`子进程没在 ${String(budgetMs)}ms 内写出 pid`)
}

describe('spawn 基本语义', () => {
  it('拿到 stdout 与退出码 0', async () => {
    const r = await spawn('echo hi', opts())
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
  })

  it('非零退出码原样回传,不当成异常', async () => {
    const r = await spawn('echo oops >&2; exit 3', opts())
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('oops')
  })

  it('在给定的 cwd 里跑', async () => {
    const r = await spawn('pwd', opts())
    // macOS 的 /var → /private/var,所以比后缀不比全等
    expect(r.stdout.trim().endsWith(root.replace(/^\/private/, ''))).toBe(true)
  })

  it('★ 命令起不来时回 127 而不是抛 —— 这是工具错误,模型能自己改', async () => {
    const r = await spawn('echo hi', opts({ cwd: join(root, 'does-not-exist') }))
    expect(r.code).toBe(127)
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it('★ stdin 是关的 —— 等输入的命令必须立刻返回,不是挂在那里', async () => {
    const r = await spawn('cat', opts({ timeoutMs: 4000 }))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('spawn 的 env 清洗', () => {
  it('★ ELECTRON_RUN_AS_NODE 不继承 —— 继承会让子进程里的 node 其实是 Electron', async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const r = await spawn('echo "[${ELECTRON_RUN_AS_NODE}]"', opts())
      expect(r.stdout.trim()).toBe('[]')
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = before
    }
  })

  it('NODE_OPTIONS 不继承 —— 否则子进程会去抢同一个 --inspect 端口', async () => {
    const before = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--inspect'
    try {
      const r = await spawn('echo "[${NODE_OPTIONS}]"', opts())
      expect(r.stdout.trim()).toBe('[]')
    } finally {
      if (before === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = before
    }
  })

  it('其余环境变量照常继承', async () => {
    const before = process.env.NEXTCOWORK_SPAWN_PROBE
    process.env.NEXTCOWORK_SPAWN_PROBE = 'kept'
    try {
      const r = await spawn('echo "${NEXTCOWORK_SPAWN_PROBE}"', opts())
      expect(r.stdout.trim()).toBe('kept')
    } finally {
      if (before === undefined) delete process.env.NEXTCOWORK_SPAWN_PROBE
      else process.env.NEXTCOWORK_SPAWN_PROBE = before
    }
  })
})

describe('spawn 超时', () => {
  it('★ 超时回 124(对齐 timeout(1)),并在 stderr 里说人话', async () => {
    const r = await spawn('sleep 30', opts({ timeoutMs: 200 }))
    expect(r.code).toBe(124)
    expect(r.stderr).toContain('超时')
  })

  it('超时时也把整个进程组带走,不留下孤儿', async () => {
    const pidFile = join(root, 'timeout.pid')
    await spawn(`sleep 30 & echo $! > ${pidFile}; wait`, opts({ timeoutMs: 300 }))
    const pid = await waitPidFile(pidFile)
    await expect(waitGone(pid)).resolves.toBe(true)
  })
})

describe('spawn 中断', () => {
  it('★ 中断**抛出** AbortError,不返回一个普通结果', async () => {
    const ac = new AbortController()
    const p = spawn('sleep 30', opts({ signal: ac.signal }))
    // 等进程真的起来了再中断,否则测的是 spawn 之前那条早退分支
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await expect(p).rejects.toSatisfy(isAbortError)
  })

  it('signal 进来时已经 aborted:立刻抛,连进程都不起', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(spawn('echo hi', opts({ signal: ac.signal }))).rejects.toSatisfy(isAbortError)
  })

  it('★ 杀的是**整个进程组** —— 孙子进程也必须死', async () => {
    /*
      这条对应 §八 的 3 号风险:只杀那一个 shell 的话,`sh -c "npm run dev"` 里的
      node 还活着、端口还占着,用户看到的是「停止了但项目跑不起来」。
      所以断言的不是 spawn 的返回值,而是**孙子进程的 pid 真的 ESRCH 了**。
    */
    const pidFile = join(root, 'group.pid')
    const ac = new AbortController()
    const p = spawn(`sleep 30 & echo $! > ${pidFile}; wait`, opts({ signal: ac.signal }))
    const pid = await waitPidFile(pidFile)
    // 先确认它真的活着,否则这条测试可能因为进程压根没起来而白绿
    expect(() => process.kill(pid, 0)).not.toThrow()

    ac.abort()
    await expect(p).rejects.toSatisfy(isAbortError)
    await expect(waitGone(pid)).resolves.toBe(true)
  })
})

describe('spawn 的输出预算', () => {
  it('★ 输出撑爆预算后仍然抽干管道 —— 不抽干的话子进程会阻塞在 write 上永不退出', async () => {
    /*
      这是**行为测试**:断言的核心是「它返回了」。不继续读管道的实现会在这里挂死,
      并被 timeoutMs 兜成 124 —— 所以 code 必须是 0。
    */
    const r = await spawn("head -c 2000000 /dev/zero | tr '\\0' 'a'", opts({ timeoutMs: 20_000 }))
    expect(r.code).toBe(0)
    // 封了顶(最多溢出一个 chunk),而不是把 2MB 全塞进来
    expect(r.stdout.length).toBeGreaterThanOrEqual(512 * 1024)
    expect(r.stdout.length).toBeLessThan(2_000_000)
  }, 30_000)
})
