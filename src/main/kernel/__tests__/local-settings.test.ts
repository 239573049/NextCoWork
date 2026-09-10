import { beforeEach, describe, expect, it } from 'vitest'
import { addLocalPermissionRule, clearLocalSettingsCache, localSettingsPath, readLocalSettings } from '../local-settings'
import type { KernelFs } from '../host'

function memoryFs(): KernelFs & { files: Map<string, string>; reads: number } {
  const files = new Map<string, string>()
  let clock = 0
  const fs = {
    files,
    reads: 0,
    readFile: (path: string) => {
      const content = files.get(path)
      if (content === undefined) return Promise.reject(new Error('ENOENT'))
      fs.reads += 1
      return Promise.resolve(content)
    },
    writeFile: (path: string, content: string) => {
      files.set(path, content)
      clock += 1
      return Promise.resolve()
    },
    stat: (path: string) => {
      const content = files.get(path)
      if (content === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ size: content.length, mtimeMs: clock, isDir: false })
    },
    exists: (path: string) => Promise.resolve(files.has(path)),
    mkdirp: () => Promise.resolve(),
    readDir: () => Promise.reject(new Error('unused')),
    realpath: (path: string) => Promise.resolve(path),
    readFileBytes: () => Promise.reject(new Error('unused'))
  } as unknown as KernelFs & { files: Map<string, string>; reads: number }
  return fs
}

const ROOT = '/ws'
const PATH = localSettingsPath(ROOT)

beforeEach(() => { clearLocalSettingsCache() })

describe('readLocalSettings', () => {
  it('文件不存在 = 没有规则,不是错误', async () => {
    const fs = memoryFs()
    expect((await readLocalSettings(fs, ROOT)).permissions).toEqual({ allow: [], ask: [], deny: [] })
  })

  it('没有工作区时不碰磁盘', async () => {
    const fs = memoryFs()
    await readLocalSettings(fs, '')
    expect(fs.reads).toBe(0)
  })

  it('★ 坏掉的 JSON 按「没有规则」处理,不能因此拦下一次运行', async () => {
    const fs = memoryFs()
    fs.files.set(PATH, '{ not json')
    expect((await readLocalSettings(fs, ROOT)).permissions.allow).toEqual([])
  })

  it('缓存按 mtime+size 失效 —— 用户手改完下一次调用就生效', async () => {
    const fs = memoryFs()
    await fs.writeFile(PATH, JSON.stringify({ permissions: { allow: ['Bash'] } }))
    expect((await readLocalSettings(fs, ROOT)).permissions.allow).toEqual(['Bash'])
    await readLocalSettings(fs, ROOT)
    expect(fs.reads).toBe(1)

    await fs.writeFile(PATH, JSON.stringify({ permissions: { allow: ['Read'] } }))
    expect((await readLocalSettings(fs, ROOT)).permissions.allow).toEqual(['Read'])
    expect(fs.reads).toBe(2)
  })
})

describe('addLocalPermissionRule', () => {
  it('建出目录、写下规则,并让下一次读立刻看见', async () => {
    const fs = memoryFs()
    const result = await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash(git status:*)')
    expect(result).toEqual({ ok: true, rule: 'Bash(git status:*)', path: PATH, added: true })
    expect(JSON.parse(fs.files.get(PATH) as string)).toEqual({
      version: 1, permissions: { allow: ['Bash(git status:*)'], ask: [], deny: [] }
    })
    expect((await readLocalSettings(fs, ROOT)).permissions.allow).toEqual(['Bash(git status:*)'])
  })

  it('重复的规则不再写一遍', async () => {
    const fs = memoryFs()
    await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash')
    const again = await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash')
    expect(again).toMatchObject({ ok: true, added: false })
    expect(JSON.parse(fs.files.get(PATH) as string).permissions.allow).toEqual(['Bash'])
  })

  it('★ 未知键原样保留 —— 新版本写下的段,旧版本改一次规则不能抹掉', async () => {
    const fs = memoryFs()
    await fs.writeFile(PATH, JSON.stringify({
      version: 2, futureSection: { a: 1 }, permissions: { allow: ['Read'], futureBucket: ['x'] }
    }))
    await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash')
    const written = JSON.parse(fs.files.get(PATH) as string)
    expect(written.futureSection).toEqual({ a: 1 })
    expect(written.permissions.futureBucket).toEqual(['x'])
    expect(written.permissions.allow).toEqual(['Read', 'Bash'])
  })

  it('★ 读不懂的文件拒绝覆盖 —— 用户点的只是一颗按钮,不是「清空我的配置」', async () => {
    const fs = memoryFs()
    await fs.writeFile(PATH, '{ not json')
    expect(await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash')).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.files.get(PATH)).toBe('{ not json')
  })

  it('没有工作区时明说存不下,而不是静默丢弃', async () => {
    expect(await addLocalPermissionRule(memoryFs(), '', 'allow', 'Bash')).toEqual({ ok: false, reason: 'no-workspace' })
  })

  it('并行的写入串起来,后一条看得见前一条', async () => {
    const fs = memoryFs()
    await Promise.all([
      addLocalPermissionRule(fs, ROOT, 'allow', 'Bash(a:*)'),
      addLocalPermissionRule(fs, ROOT, 'allow', 'Bash(b:*)'),
      addLocalPermissionRule(fs, ROOT, 'deny', 'Bash(c:*)')
    ])
    const written = JSON.parse(fs.files.get(PATH) as string)
    expect(written.permissions.allow).toEqual(['Bash(a:*)', 'Bash(b:*)'])
    expect(written.permissions.deny).toEqual(['Bash(c:*)'])
  })
})
