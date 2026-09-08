import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { editTool, lsTool, readTool, writeTool } from '../fs'
import { resetReadTrackerForTest } from '../read-tracker'

/**
 * 文件四件套的真 IO 测试 —— 真临时目录、真符号链接,不打桩 fs。
 *
 * 打桩 fs 会把这几个工具最容易出错的地方全部测没:realpath 之后的路径比较、
 * 断链软链、目录 vs 文件、二进制探测。那些恰恰是**只有真文件系统才会暴露**的。
 */

let root = ''
/** 工作区**外面**的一个目录 —— 逃逸用例的靶子 */
let outside = ''

/** 越界时绝对不能出现在错误信息里的那串东西 */
const SECRET = 'AKIA-TOTALLY-SECRET-CONTENT-9f3c'

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {},
    ...over
  }
}

/** 先 Read 再写 —— 大多数用例都要走这一步,单独抽出来 */
async function readFirst(rel: string, c = ctx()): Promise<void> {
  const r = await readTool.execute({ file_path: join(root, rel) }, c)
  expect(r.isError, `预备 Read 失败:${r.output.content}`).toBeFalsy()
}

beforeEach(() => {
  resetReadTrackerForTest()
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ncw-fs-')))
  root = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), SECRET)
})

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true })
})

// ────────────────────────────── Read ──────────────────────────────

describe('Read', () => {
  it('输出是 cat -n 格式:右对齐 6 位行号 + 制表符', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo')
    const r = await readTool.execute({ file_path: join(root, 'a.txt') }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toBe('     1\tone\n     2\ttwo')
  })

  it('接受工作区相对路径(围栏本来就两种都认)', async () => {
    writeFileSync(join(root, 'a.txt'), 'hi')
    const r = await readTool.execute({ file_path: 'a.txt' }, ctx())
    expect(r.output.content).toBe('     1\thi')
  })

  it('offset / limit 分段读,并说明还剩多少', async () => {
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'))
    const r = await readTool.execute({ file_path: join(root, 'big.txt'), offset: 3, limit: 2 }, ctx())
    expect(r.output.content).toContain('     3\tL3')
    expect(r.output.content).toContain('     4\tL4')
    expect(r.output.content).not.toContain('L5')
    // 续读的指引必须给出**下一个** offset,不然模型只能猜
    expect(r.output.content).toContain('offset=5')
  })

  it('offset 越界时报错并说明总行数', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo')
    const r = await readTool.execute({ file_path: join(root, 'a.txt'), offset: 99 }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('only 2 lines')
  })

  it('超长的行被截断,并标注出来', async () => {
    writeFileSync(join(root, 'min.js'), 'x'.repeat(5000))
    const r = await readTool.execute({ file_path: join(root, 'min.js') }, ctx())
    expect(r.output.content).toContain('[line truncated]')
    expect(r.output.content.length).toBeLessThan(3000)
  })

  it('文件不存在时给出下一步(LS / Glob),不是一句干巴巴的 ENOENT', async () => {
    const r = await readTool.execute({ file_path: join(root, 'nope.txt') }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('LS')
    expect(r.output.content).toContain('Glob')
  })

  it('目录被拒绝,并指向 LS', async () => {
    mkdirSync(join(root, 'dir'))
    const r = await readTool.execute({ file_path: join(root, 'dir') }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('LS')
  })

  it('二进制文件被拒绝', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    const r = await readTool.execute({ file_path: join(root, 'blob.bin') }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('binary file')
  })

  it('空文件不是错误 —— 说清楚它存在但是空的', async () => {
    writeFileSync(join(root, 'empty.txt'), '')
    const r = await readTool.execute({ file_path: join(root, 'empty.txt') }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('empty')
  })

  it('太大的文件被拒绝,并指向 Grep / sed', async () => {
    writeFileSync(join(root, 'huge.txt'), 'a'.repeat(9 * 1024 * 1024))
    const r = await readTool.execute({ file_path: join(root, 'huge.txt') }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Grep')
    expect(r.output.content).toContain('sed')
  })
})

// ────────────────────────────── Write ──────────────────────────────

describe('Write', () => {
  it('新建文件,父目录自动创建', async () => {
    const r = await writeTool.execute(
      { file_path: join(root, 'a/b/c.ts'), content: 'export const x = 1\n' },
      ctx()
    )
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('Created')
    const back = await readTool.execute({ file_path: join(root, 'a/b/c.ts') }, ctx())
    expect(back.output.content).toContain('export const x = 1')
  })

  /**
   * ★ 这是 CC 的那条硬规则。防的是「模型凭记忆整体覆盖一个文件、把没看见的
   * 内容一起抹掉」—— 那种错误在转录里看起来完全正常。
   */
  it('★ 覆盖已有文件之前必须先 Read', async () => {
    writeFileSync(join(root, 'a.txt'), '原有内容')
    const r = await writeTool.execute({ file_path: join(root, 'a.txt'), content: '新的' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Read')
    // 真的没写进去
    const back = await readTool.execute({ file_path: join(root, 'a.txt') }, ctx())
    expect(back.output.content).toContain('原有内容')
  })

  it('Read 过之后就能覆盖', async () => {
    writeFileSync(join(root, 'a.txt'), '原有内容')
    const c = ctx()
    await readFirst('a.txt', c)
    const r = await writeTool.execute({ file_path: join(root, 'a.txt'), content: '新的' }, c)
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('Overwrote')
  })

  /** ★ 状态按 run 分桶 —— 换一次运行就要重新确认文件的当下内容 */
  it('★ 另一次运行读过不算数', async () => {
    writeFileSync(join(root, 'a.txt'), '原有内容')
    await readFirst('a.txt', ctx({ runId: 'run_A' }))
    const r = await writeTool.execute(
      { file_path: join(root, 'a.txt'), content: '新的' },
      ctx({ runId: 'run_B' })
    )
    expect(r.isError).toBe(true)
  })

  it('写完之后同一次运行里可以直接 Edit', async () => {
    const c = ctx()
    await writeTool.execute({ file_path: join(root, 'a.txt'), content: 'hello world' }, c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.txt'), old_string: 'world', new_string: 'there' },
      c
    )
    expect(r.isError).toBeFalsy()
  })

  it('目录不能当文件写', async () => {
    mkdirSync(join(root, 'dir'))
    const r = await writeTool.execute({ file_path: join(root, 'dir'), content: 'x' }, ctx())
    expect(r.isError).toBe(true)
  })
})

// ────────────────────────────── Edit ──────────────────────────────

describe('Edit', () => {
  it('唯一命中时替换成功', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconst b = 2\n')
    const c = ctx()
    await readFirst('a.ts', c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: 'const b = 2', new_string: 'const b = 3' },
      c
    )
    expect(r.isError).toBeFalsy()
    const back = await readTool.execute({ file_path: join(root, 'a.ts') }, c)
    expect(back.output.content).toContain('const b = 3')
    expect(back.output.content).not.toContain('const b = 2')
  })

  it('★ 编辑之前必须先 Read', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: 'x', new_string: 'y' },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Read')
  })

  it('不唯一时**一处都不改**,并给出出现次数', async () => {
    writeFileSync(join(root, 'a.ts'), 'foo\nfoo\nfoo\n')
    const c = ctx()
    await readFirst('a.ts', c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: 'foo', new_string: 'bar' },
      c
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('appears 3 times')
    const back = await readTool.execute({ file_path: join(root, 'a.ts') }, c)
    expect(back.output.content).not.toContain('bar')
  })

  it('replace_all 时全部替换', async () => {
    writeFileSync(join(root, 'a.ts'), 'foo\nfoo\nfoo\n')
    const c = ctx()
    await readFirst('a.ts', c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: 'foo', new_string: 'bar', replace_all: true },
      c
    )
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('3 occurrence')
  })

  /**
   * ★ 失败信息里**不能**附上文件内容。两个理由:模型会以为那是它该抄的原文;
   * 以及一次失败的编辑不该把整个文件塞进上下文窗。
   */
  it('★ 没找到时给的是排查方向,不是文件内容', async () => {
    writeFileSync(join(root, 'a.ts'), `const token = "${SECRET}"\n`)
    const c = ctx()
    await readFirst('a.ts', c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: '不存在的原文', new_string: 'x' },
      c
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).not.toContain(SECRET)
    expect(r.output.content).toContain('line-number prefix')
  })

  it('old_string 和 new_string 一样时直接拒绝', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    const c = ctx()
    await readFirst('a.ts', c)
    const r = await editTool.execute(
      { file_path: join(root, 'a.ts'), old_string: 'x', new_string: 'x' },
      c
    )
    expect(r.isError).toBe(true)
  })

  it('文件不存在时指向 Write', async () => {
    const r = await editTool.execute(
      { file_path: join(root, 'nope.ts'), old_string: 'a', new_string: 'b' },
      ctx()
    )
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Write')
  })
})

// ────────────────────────────── LS ──────────────────────────────

describe('LS', () => {
  it('目录在前、文件在后', async () => {
    mkdirSync(join(root, 'zdir'))
    writeFileSync(join(root, 'a.txt'), 'x')
    const r = await lsTool.execute({ path: root }, ctx())
    expect(r.isError).toBeFalsy()
    const body = r.output.content
    expect(body.indexOf('zdir/')).toBeLessThan(body.indexOf('a.txt'))
  })

  it('ignore 按名字模式过滤', async () => {
    writeFileSync(join(root, 'keep.ts'), 'x')
    writeFileSync(join(root, 'drop.log'), 'x')
    const r = await lsTool.execute({ path: root, ignore: ['*.log'] }, ctx())
    expect(r.output.content).toContain('keep.ts')
    expect(r.output.content).not.toContain('drop.log')
  })

  it('空目录说清楚是空的', async () => {
    mkdirSync(join(root, 'empty'))
    const r = await lsTool.execute({ path: join(root, 'empty') }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('empty directory')
  })

  it('传文件时指向 Read', async () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    const r = await lsTool.execute({ path: join(root, 'a.txt') }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.content).toContain('Read')
  })

  it('断链软链仍然列出来,不让整次调用失败', async () => {
    symlinkSync(join(root, 'nothing-here'), join(root, 'dangling'))
    const r = await lsTool.execute({ path: root }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('dangling')
  })
})

// ────────────────────────────── 工作区外的路径 ──────────────────────────────

/**
 * ★ 工作区**不再是围栏** —— 「谁能碰哪个文件」由权限档位决定(见 `path-guard.ts` 文件头)。
 *
 * 这一组钉的是放开之后仍然必须成立的三件事:真的能碰到、**回执里的路径一律是绝对形式**
 * (相对形式对不上任何一个根,模型再喂回来时基准全看运气)、没有工作区时绝对路径照样能用。
 */
describe('★ 工作区外的路径', () => {
  const escapes = (): Array<[string, string]> => [
    ['相对路径向上', '../outside/secret.txt'],
    ['绝对路径', join(outside, 'secret.txt')]
  ]

  it('Read 读得到,且回执里的路径是绝对形式', async () => {
    for (const [why, p] of escapes()) {
      const r = await readTool.execute({ file_path: p }, ctx())
      expect(r.isError, why).toBeFalsy()
      expect(r.output.content, why).toContain(SECRET)
    }
  })

  it('Write 写得出去', async () => {
    const target = join(outside, 'planted.txt')
    const r = await writeTool.execute({ file_path: target, content: 'x' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(readFileSync(target, 'utf8')).toBe('x')
    // ★ 路径按绝对形式回报,不是 `../outside/planted.txt`
    expect(r.output.content).toContain(target)
  })

  it('Edit 改得动,但仍然要先 Read', async () => {
    const target = join(outside, 'secret.txt')
    const before = await editTool.execute({ file_path: target, old_string: 'AKIA', new_string: 'B' }, ctx())
    expect(before.isError, '没读过就编辑必须被拒').toBe(true)

    const c = ctx()
    expect((await readTool.execute({ file_path: target }, c)).isError).toBeFalsy()
    const r = await editTool.execute({ file_path: target, old_string: 'AKIA', new_string: 'B' }, c)
    expect(r.isError).toBeFalsy()
    expect(readFileSync(target, 'utf8')).toContain('B-TOTALLY-SECRET')
  })

  it('LS 列得出来', async () => {
    const r = await lsTool.execute({ path: outside }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain('secret.txt')
  })

  /** 词法上完全在根里面,realpath 之后在外面 —— 现在跟着目标走,而不是被拦下 */
  it('★ 软链指到外面也跟着走', async () => {
    symlinkSync(outside, join(root, 'link'))
    const r = await readTool.execute({ file_path: join(root, 'link/secret.txt') }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.output.content).toContain(SECRET)
  })

  /**
   * ★ 没绑定工作区时,**相对路径**才没有基准。绝对路径本来就不需要基准,照样能用。
   * `runtime.ts` 的 `workspaceRootFor` 查不到时给的就是空串。
   */
  it('★ 空工作区根:相对路径被拒,绝对路径可用', async () => {
    const c = ctx({ workspaceRoot: '' })
    const rejected: Array<[string, Promise<{ isError?: boolean; output: { content: string } }>]> = [
      ['Read', readTool.execute({ file_path: 'x.txt' }, c)],
      ['Write', writeTool.execute({ file_path: 'x.txt', content: 'y' }, c)],
      ['Edit', editTool.execute({ file_path: 'x.txt', old_string: 'a', new_string: 'b' }, c)],
      ['LS', lsTool.execute({ path: 'x' }, c)]
    ]
    for (const [name, p] of rejected) {
      const r = await p
      expect(r.isError, name).toBe(true)
      expect(r.output.content, name).toContain('workspace')
    }

    const r = await readTool.execute({ file_path: join(outside, 'secret.txt') }, c)
    expect(r.isError, r.output.content).toBeFalsy()
    expect(r.output.content).toContain(SECRET)
  })
})
