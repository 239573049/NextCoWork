import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeHost } from '../host'

/**
 * `KernelFs` 的真 IO 测试。
 *
 * ★ **不打桩 fs**。这一层要证明的恰恰是「我们对 node 的 fs 语义的理解是对的」——
 * 断链软链、readdir 的 lstat 语义、read(n) 只读前 n 字节。把 fs 桩掉,
 * 被测的东西就跟着一起被桩掉了,剩下的只是在测我们自己写的假对象。
 * (`path-guard.test.ts` 出于同样的理由用真临时目录。)
 */

const fs = nodeHost().fs

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-hostfs-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'hello 世界\n')
  writeFileSync(join(root, 'sub', 'b.txt'), 'b')
  // 指向目录的软链:readdir 报它是「文件」,stat 之后才知道是目录
  symlinkSync(join(root, 'sub'), join(root, 'link-to-dir'))
  // 断链:stat 会抛 —— 这一项必须被吞掉,不能让整次列目录失败
  symlinkSync(join(root, 'nope'), join(root, 'broken-link'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('KernelFs 读', () => {
  it('readFile 按 utf8 解码', async () => {
    await expect(fs.readFile(join(root, 'a.txt'))).resolves.toBe('hello 世界\n')
  })

  it('★ 指向目录的软链要报成目录 —— readdir 是 lstat 语义,单靠它会漏', async () => {
    const entries = await fs.readDir(root)
    const link = entries.find((e) => e.name === 'link-to-dir')
    expect(link).toEqual({ name: 'link-to-dir', isDir: true })
  })

  it('★ 断掉的软链仍然出现在列表里,不让整次 readDir 失败', async () => {
    const entries = await fs.readDir(root)
    expect(entries.map((e) => e.name)).toContain('broken-link')
    expect(entries.find((e) => e.name === 'broken-link')?.isDir).toBe(false)
  })

  it('stat 给出大小与目录标记', async () => {
    const st = await fs.stat(join(root, 'a.txt'))
    expect(st.isDir).toBe(false)
    expect(st.size).toBeGreaterThan(0)
    expect(st.mtimeMs).toBeGreaterThan(0)
    await expect(fs.stat(join(root, 'sub'))).resolves.toMatchObject({ isDir: true })
  })

  it('realpath 穿透软链', async () => {
    await expect(fs.realpath(join(root, 'link-to-dir'))).resolves.toBe(
      await fs.realpath(join(root, 'sub'))
    )
  })
})

describe('KernelFs.readFileBytes', () => {
  it('★ 只读前 n 个字节 —— 二进制探测不该把整个文件解码一遍', async () => {
    const big = join(root, 'big.bin')
    writeFileSync(big, Buffer.alloc(1024 * 64, 0x41))
    const head = await fs.readFileBytes(big, 16)
    expect(head.length).toBe(16)
    expect([...head]).toEqual(Array<number>(16).fill(0x41))
  })

  it('文件比取样长度短时,只回实际读到的那么多', async () => {
    const bytes = await fs.readFileBytes(join(root, 'sub', 'b.txt'), 4096)
    expect(bytes.length).toBe(1)
    expect(bytes[0]).toBe(0x62)
  })

  it('原样给出 NUL 字节 —— 这是二进制探测唯一的依据', async () => {
    const p = join(root, 'nul.bin')
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x00, 0x0a]))
    const bytes = await fs.readFileBytes(p)
    expect([...bytes]).toEqual([0x89, 0x50, 0x00, 0x0a])
  })
})

describe('KernelFs 写', () => {
  it('writeFile 覆盖已有内容', async () => {
    const p = join(root, 'w.txt')
    await fs.writeFile(p, 'one')
    await fs.writeFile(p, 'two')
    await expect(fs.readFile(p)).resolves.toBe('two')
  })

  it('★ mkdirp 建的是**父目录** —— 否则模型写 a/b/c.ts 永远 ENOENT', async () => {
    const p = join(root, 'deep', 'deeper', 'c.ts')
    await fs.mkdirp(p)
    expect(existsSync(join(root, 'deep', 'deeper'))).toBe(true)
    // 建的是父目录,不是把 c.ts 自己建成目录
    expect(existsSync(p)).toBe(false)
    await fs.writeFile(p, 'ok')
    await expect(fs.readFile(p)).resolves.toBe('ok')
  })

  it('mkdirp 对已存在的目录是幂等的', async () => {
    const p = join(root, 'sub', 'again.txt')
    await fs.mkdirp(p)
    await expect(fs.mkdirp(p)).resolves.toBeUndefined()
  })
})

describe('KernelFs.exists', () => {
  it('★ 存在性是个问句,不是个异常', async () => {
    await expect(fs.exists(join(root, 'a.txt'))).resolves.toBe(true)
    await expect(fs.exists(join(root, 'sub'))).resolves.toBe(true)
    await expect(fs.exists(join(root, 'nope.txt'))).resolves.toBe(false)
  })

  it('断链软链算不存在 —— access 跟随软链,和 stat 同一套语义', async () => {
    await expect(fs.exists(join(root, 'broken-link'))).resolves.toBe(false)
  })
})
