import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { abortError } from '../../../abort'
import type { KernelHost, SpawnResult } from '../../../host'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { BASH_LIMITS, bashTool } from '../bash'

/**
 * `Bash` **工具层**的测试。
 *
 * ★ 进程真的死没死、管道会不会堵,已经由 `kernel/__tests__/host-spawn.test.ts`
 * 在 `SpawnFn` 那一层钉死了。这里只测工具自己负责的那几件事:
 * 有没有工作区、退出码怎么翻译成给模型的话、中断有没有被原样抛上去。
 * 两层测同一件事的话,`SpawnFn` 换实现时会有一堆无关的红。
 */

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ncw-bash-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    permissionMode: 'full',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {},
    ...over
  }
}

/** 把 spawn 换成一个可控的假实现 —— 用来造真进程不好造的那几种结果 */
function withSpawn(fn: KernelHost['spawn']): ToolHostOverride {
  return { host: nodeHost({ spawn: fn }) }
}
type ToolHostOverride = Pick<ToolContext, 'host'>

const spawned = (over: Partial<SpawnResult> = {}): SpawnResult => ({
  stdout: '',
  stderr: '',
  code: 0,
  ...over
})

describe('Bash · 标记', () => {
  it('★ destructive —— 一条 shell 命令能做的事没有上界,auto 档要走到「需要询问」', () => {
    expect(bashTool.destructive).toBe(true)
    expect(bashTool.readOnly).toBe(false)
    expect(bashTool.needsNetwork).toBe(false)
  })
})

describe('Bash · 前置条件', () => {
  it('没有工作区时直接拒,不起进程', async () => {
    let called = false
    const r = await bashTool.execute(
      { command: 'echo hi' },
      ctx({
        workspaceRoot: '',
        ...withSpawn(() => {
          called = true
          return Promise.resolve(spawned())
        })
      })
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('workspace')
    expect(called).toBe(false)
  })

  it('空命令过不了 schema', async () => {
    const r = await bashTool.execute({ command: '' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })

  it(`timeout 超过上限 ${String(BASH_LIMITS.MAX_TIMEOUT_MS)} 时被 schema 挡回`, async () => {
    const r = await bashTool.execute(
      { command: 'echo hi', timeout: BASH_LIMITS.MAX_TIMEOUT_MS + 1 },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Invalid arguments')
  })
})

describe('Bash · 真的跑一条命令', () => {
  it('拿到 stdout', async () => {
    const r = await bashTool.execute({ command: 'echo hello-from-bash' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('hello-from-bash')
    expect(r.output.content).toContain('<stdout>')
  })

  it('cwd 是工作区根 —— 模型不用自己 cd', async () => {
    const r = await bashTool.execute({ command: 'pwd' }, ctx())
    expect(r.output.content).toContain(root.replace(/^\/private/, ''))
  })

  it('能写文件(证明它确实在跑,不是被打桩了)', async () => {
    const r = await bashTool.execute({ command: 'printf abc > written.txt' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(readFileSync(join(root, 'written.txt'), 'utf8')).toBe('abc')
  })

  it('非零退出码是 toolFail,并带上退出码', async () => {
    const r = await bashTool.execute({ command: 'echo out; echo err >&2; exit 3' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('exited with code 3')
    // ★ 失败时 stdout 和 stderr 都要给 —— 只给 stderr 的话模型看不到它做到哪一步了
    expect(r.output.content).toContain('out')
    expect(r.output.content).toContain('err')
  })

  it('★ 成功但没输出时说「没有任何输出」,不是一段静默的空白', async () => {
    const r = await bashTool.execute({ command: 'true' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('no output')
  })

  it('失败且没输出时也说清楚', async () => {
    const r = await bashTool.execute({ command: 'exit 7' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('exited with code 7')
    expect(r.output.content).toContain('no output')
  })

  it('stdout 和 stderr 分开装,不混成一坨', async () => {
    const r = await bashTool.execute({ command: 'echo AAA; echo BBB >&2' }, ctx())
    const c = r.output.content
    expect(c.indexOf('<stdout>')).toBeLessThan(c.indexOf('<stderr>'))
    expect(c.slice(c.indexOf('<stdout>'), c.indexOf('</stdout>'))).toContain('AAA')
    expect(c.slice(c.indexOf('<stderr>'), c.indexOf('</stderr>'))).toContain('BBB')
  })
})

describe('Bash · 超时', () => {
  it('★ 超时(code 124)时明说是超时、且进程组已经被带走', async () => {
    const r = await bashTool.execute(
      { command: 'x' },
      ctx(withSpawn(() => Promise.resolve(spawned({ code: 124, stderr: '超时' }))))
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('timed out')
    expect(r.output.content).toContain('process group')
  })

  it('真的会超时 —— sleep 撞上 200ms 预算', async () => {
    const r = await bashTool.execute({ command: 'sleep 5', timeout: 200 }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('timed out')
  }, 10_000)

  it('超时提示里带上实际用的那个毫秒数', async () => {
    const r = await bashTool.execute(
      { command: 'x', timeout: 4321 },
      ctx(withSpawn(() => Promise.resolve(spawned({ code: 124 }))))
    )
    expect(r.output.content).toContain('4321')
  })
})

describe('Bash · 输出预算', () => {
  it(`★ 超过 ${String(BASH_LIMITS.MAX_OUTPUT_CHARS)} 字符被截断`, async () => {
    const huge = 'x'.repeat(BASH_LIMITS.MAX_OUTPUT_CHARS * 2)
    const r = await bashTool.execute(
      { command: 'x' },
      ctx(withSpawn(() => Promise.resolve(spawned({ stdout: huge }))))
    )
    expect(r.output.content.length).toBeLessThan(BASH_LIMITS.MAX_OUTPUT_CHARS + 500)
  })
})

describe('Bash · 中断', () => {
  /**
   * ★ 这一条钉的是「停止按钮不能失效」。
   *
   * `SpawnFn` 被中断时抛的是 abortError,而 `defineTool` 的契约是**原样往上抛**。
   * 在工具里包一层 catch 转成 `toolFail` 的话,「用户点了停止」会表现成
   * 「命令失败了」—— 模型于是换个写法再试一次,停止按钮就形同虚设。
   */
  it('★ 中断原样抛出,不会变成一个普通的 toolFail', async () => {
    const p = bashTool.execute(
      { command: 'sleep 30' },
      ctx(withSpawn(() => Promise.reject(abortError())))
    )
    await expect(p).rejects.toThrow()
  })

  it('真进程 + 真中断:也是抛,不是返回', async () => {
    const ac = new AbortController()
    const p = bashTool.execute({ command: 'sleep 30' }, ctx({ signal: ac.signal }))
    setTimeout(() => {
      ac.abort()
    }, 50)
    await expect(p).rejects.toThrow()
  }, 10_000)
})

describe('Bash · 描述里那三处和 CC 的差异', () => {
  const d = bashTool.description

  it('★ 说清了每次调用都是新 shell —— 不说的话模型会先 cd 再在下一次调用里写相对路径', () => {
    expect(d).toContain('FRESH SHELL')
    expect(d).toContain('cd')
  })

  it('★ 说清了 stdin 是关的 —— 不说的话 git commit 不带 -m 会挂到超时', () => {
    expect(d).toContain('STDIN IS CLOSED')
    expect(d).toContain('-m')
  })

  it('★ 没有声明 run_in_background —— 声明一个不生效的开关比缺功能坏得多', () => {
    expect(JSON.stringify(bashTool.inputSchema)).not.toContain('run_in_background')
    expect(Object.keys((bashTool.inputSchema as { properties: object }).properties).sort()).toEqual([
      'command',
      'description',
      'timeout'
    ])
  })

  it('把搜索和读文件引导回专门的工具', () => {
    for (const name of ['Grep', 'Glob', 'Read', 'LS']) expect(d, name).toContain(name)
  })
})
