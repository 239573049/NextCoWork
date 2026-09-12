import { beforeEach, describe, expect, it } from 'vitest'
import { addLocalPermissionRule, clearLocalSettingsCache, globalSettingsPath, localSettingsPath, readGlobalSettings, readLocalSettings, writeHooks } from '../local-settings'
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
  it('fails closed on unreadable or malformed remote permission rules', async () => {
    const fs = memoryFs()
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const remote = { ...fs, stat: async () => { throw denied } }
    await expect(readLocalSettings(remote, ROOT, undefined, { namespace: 'server:1' })).rejects.toBe(denied)
    await fs.writeFile(PATH, '{ broken')
    await expect(readLocalSettings(fs, ROOT, undefined, { namespace: 'server:1' })).rejects.toBeInstanceOf(SyntaxError)
    const missing = { ...fs, stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }
    expect((await readLocalSettings(missing, ROOT, undefined, { namespace: 'server:1' })).permissions.deny).toEqual([])
  })

  /**
   * ★ 远端**每一次都重读**,不吃缓存。
   *
   * 这是权限判定的 fail-closed 取向在缓存上的那一半:一条缓存的规则说不清它属于哪一次
   * 连接。重连之后拿旧连接的答案当结论,方向是「放行」——用户在服务器上删掉的 deny
   * 规则还在生效,或者刚点的「以后都允许」不认账。判新鲜本来就要一次 stat,
   * 那已经是一趟网络往返,省下的那次 readFile 不值得用这个换。
   */
  it('远端每一次读都重新落盘,不吃缓存', async () => {
    const fs = memoryFs()
    await fs.writeFile(PATH, JSON.stringify({ permissions: { allow: ['Bash'] } }))
    const scope = { namespace: 'server:1' }
    await readLocalSettings(fs, ROOT, undefined, scope)
    await readLocalSettings(fs, ROOT, undefined, scope)
    await readLocalSettings(fs, ROOT, undefined, scope)
    expect(fs.reads, '远端三次读就是三次落盘').toBe(3)
  })

  /**
   * ★ 远端和本机不能共用一把缓存键。
   *
   * 同一条路径在客户端和服务器上都存在是很平常的事(`/home/user/project` 两边都有),
   * 共用一把键就意味着一边的答案会被当成另一边的。这里从本机那一侧观测:
   * 夹在中间的那次远端读**不能**动本机那条缓存。
   *
   * 注:这条和上一条都只拦得住「往后有人把远端缓存打开」。历史上那次
   * 「铸了键、写进去、又永远读不到」的写入是观测不到的 —— 它的代价只有内存,
   * 没有任何行为差异,所以没有能变红的测试,只能靠代码审查。
   */
  it('远端读不污染本机缓存', async () => {
    const fs = memoryFs()
    await fs.writeFile(PATH, JSON.stringify({ permissions: { allow: ['Bash'] } }))
    expect((await readLocalSettings(fs, ROOT)).permissions.allow).toEqual(['Bash'])
    const after = fs.reads
    await readLocalSettings(fs, ROOT, undefined, { namespace: 'server:1' })
    await readLocalSettings(fs, ROOT)
    expect(fs.reads, '本机那次仍然命中缓存,远端读没动它').toBe(after + 1)
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

/**
 * 两段配置共用一份文件。
 *
 * ★ 这一节是整个模块**唯一会静默毁数据**的地方：改一段把另一段抹掉，不报错、
 *   不崩、下一次读才发现少了东西，而那时候已经找不到是谁干的了。
 */
describe('permissions 与 hooks 共存', () => {
  const hooksOf = (fs: ReturnType<typeof memoryFs>, path = PATH): Record<string, unknown> =>
    (JSON.parse(fs.files.get(path) as string) as { hooks: Record<string, unknown> }).hooks

  it('★ 写 hooks 不动 permissions', async () => {
    const fs = memoryFs()
    await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash(git status:*)')
    await writeHooks(fs, PATH, () => ({ PreToolUse: [{ id: 'a', command: 'guard.sh', timeout: 10 }] }))
    const written = JSON.parse(fs.files.get(PATH) as string)
    expect(written.permissions.allow).toEqual(['Bash(git status:*)'])
    expect(written.hooks.PreToolUse).toHaveLength(1)
  })

  it('★ 写 permissions 不动 hooks', async () => {
    const fs = memoryFs()
    await writeHooks(fs, PATH, () => ({ Stop: [{ id: 'a', command: 'notify.sh', timeout: 60 }] }))
    await addLocalPermissionRule(fs, ROOT, 'deny', 'Bash(rm:*)')
    const written = JSON.parse(fs.files.get(PATH) as string)
    expect(written.hooks.Stop).toHaveLength(1)
    expect(written.permissions.deny).toEqual(['Bash(rm:*)'])
  })

  it('未知的顶层键在两种写入下都留着', async () => {
    const fs = memoryFs()
    fs.files.set(PATH, JSON.stringify({ version: 1, futureSection: { keep: true } }))
    await addLocalPermissionRule(fs, ROOT, 'allow', 'Bash')
    await writeHooks(fs, PATH, () => ({ Stop: [{ id: 'a', command: 'x', timeout: 60 }] }))
    expect(JSON.parse(fs.files.get(PATH) as string).futureSection).toEqual({ keep: true })
  })

  it('读不懂的文件拒绝写 hooks —— 和权限那条是同一个取向', async () => {
    const fs = memoryFs()
    fs.files.set(PATH, '{ not json')
    expect(await writeHooks(fs, PATH, () => ({}))).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.files.get(PATH)).toBe('{ not json')
  })

  it('hooks 的并行写入也串起来', async () => {
    const fs = memoryFs()
    await Promise.all([
      writeHooks(fs, PATH, (h) => ({ ...h, PreToolUse: [...(h.PreToolUse ?? []), { id: 'a', command: 'a', timeout: 10 }] })),
      writeHooks(fs, PATH, (h) => ({ ...h, PreToolUse: [...(h.PreToolUse ?? []), { id: 'b', command: 'b', timeout: 10 }] }))
    ])
    expect((hooksOf(fs).PreToolUse as unknown[])).toHaveLength(2)
  })

  it('缓存按 mtime+size 失效，写完立刻读得到新的 hooks', async () => {
    const fs = memoryFs()
    expect((await readLocalSettings(fs, ROOT)).hooks).toEqual({})
    await writeHooks(fs, PATH, () => ({ Stop: [{ id: 'a', command: 'x', timeout: 60 }] }))
    expect((await readLocalSettings(fs, ROOT)).hooks.Stop).toHaveLength(1)
  })
})

describe('全局那一份', () => {
  const USER_DATA = '/appdata'

  it('文件不存在 = 没有钩子，不是错误', async () => {
    expect((await readGlobalSettings(memoryFs(), USER_DATA)).hooks).toEqual({})
  })

  it('★ 全局和项目各自缓存、互不串', async () => {
    const fs = memoryFs()
    await writeHooks(fs, globalSettingsPath(USER_DATA), () => ({ Stop: [{ id: 'g', command: 'global', timeout: 60 }] }))
    await writeHooks(fs, PATH, () => ({ Stop: [{ id: 'p', command: 'project', timeout: 60 }] }))
    expect((await readGlobalSettings(fs, USER_DATA)).hooks.Stop?.[0]?.command).toBe('global')
    expect((await readLocalSettings(fs, ROOT)).hooks.Stop?.[0]?.command).toBe('project')
  })
})
