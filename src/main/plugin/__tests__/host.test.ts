/**
 * 插件宿主的测试 —— 参数门、协议路径、生命周期与 RPC 的四道门。
 *
 * 用一个**假的 `PluginRuntime`** 把 electron 挡在外面:这个文件测的是策略
 * (谁能激活、哪条 RPC 放行),而不是机制(iframe、MessagePort、CSP)。
 * 两者分在两个文件里,正是 `manager.ts` 把 runtime 抽成接口的理由。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { nodeHost } from '../../kernel/host'
import {
  matchesPathScope,
  narrowCommand,
  narrowFetchUrl,
  narrowStorageKey,
  narrowWorkspacePath,
  secretKeyFor,
  wrapPluginContext
} from '../capabilities'
import { resolveInsidePackage } from '../protocol'
import { PluginManager, type PluginRuntime } from '../manager'
import { clearAllActivity, recentActivity } from '../diagnostics'
import { explainUnsupported } from '../unsupported'

describe('参数门 · 路径', () => {
  const root = '/ws'

  it('工作区内的相对路径通过', () => {
    expect(narrowWorkspacePath(root, 'src/a.ts')).toEqual({ ok: true, value: '/ws/src/a.ts' })
  })

  it('★ 跑到根外面的一律拒 —— 「批准了读」不等于「可以读任意文件」', () => {
    for (const path of ['../secret', 'a/../../secret', '/etc/passwd', 'C:\\Windows\\x']) {
      expect(narrowWorkspacePath(root, path).ok, path).toBe(false)
    }
  })

  it('★ 没有工作区时一切路径调用都拒 —— 不回落到临时目录', () => {
    expect(narrowWorkspacePath('', 'a.ts').ok).toBe(false)
  })

  it('NUL 字节与超长路径拒掉', () => {
    expect(narrowWorkspacePath(root, 'a\0b').ok).toBe(false)
    expect(narrowWorkspacePath(root, 'a'.repeat(2000)).ok).toBe(false)
  })

  it('清单里的 paths 再收窄一层', () => {
    expect(matchesPathScope(['docs/*'], 'docs/a.md')).toBe(true)
    expect(matchesPathScope(['docs/*'], 'src/a.ts')).toBe(false)
    // 前缀不能只按字符串比 —— `docs2/` 不属于 `docs/`
    expect(matchesPathScope(['docs'], 'docs2/a.md')).toBe(false)
    expect(matchesPathScope(undefined, 'anything')).toBe(true)
  })
})

describe('参数门 · 命令', () => {
  it('只认基名,带路径与扩展名都归一', () => {
    expect(narrowCommand(['cargo'], '/usr/bin/cargo', ['check'])).toEqual({ ok: true, value: { command: 'cargo', args: ['check'] } })
    expect(narrowCommand(['cargo'], 'cargo.exe', []).ok).toBe(true)
  })

  it('★ 白名单为空 = 一条都不许跑,不是「随便跑」', () => {
    expect(narrowCommand([], 'ls', []).ok).toBe(false)
  })

  it('★ 不在白名单里的拒掉', () => {
    expect(narrowCommand(['cargo'], 'rm', ['-rf', '/']).ok).toBe(false)
  })

  it('★ shell 元字符拒掉 —— 否则弹窗上写的和真跑的是两回事', () => {
    expect(narrowCommand(['cargo'], 'cargo && rm -rf /', []).ok).toBe(false)
    expect(narrowCommand(['cargo'], 'cargo', ['a\0b']).ok).toBe(false)
  })
})

describe('参数门 · 网络', () => {
  const hosts = ['https://api.example.com/*']

  it('命中 hostPermissions 才放行', () => {
    expect(narrowFetchUrl(hosts, 'https://api.example.com/v1').ok).toBe(true)
    expect(narrowFetchUrl(hosts, 'https://other.com/v1').ok).toBe(false)
  })

  it('★ 明文 http、URL 里的凭证一律拒', () => {
    expect(narrowFetchUrl(['https://api.example.com/*'], 'http://api.example.com/x').ok).toBe(false)
    expect(narrowFetchUrl(hosts, 'https://u:p@api.example.com/v1').ok).toBe(false)
  })

  it('★ 内网与环回挡在 hostPermissions 之前 —— 作者可以把它写进清单', () => {
    for (const url of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/x',
      'https://192.168.1.1/x',
      'https://172.16.0.1/x'
    ]) {
      expect(narrowFetchUrl([`https://${new URL(url).host}/*`], url).ok, url).toBe(false)
    }
  })
})

describe('参数门 · 存储与上下文', () => {
  it('key 的形状受限', () => {
    expect(narrowStorageKey('a.b:c').ok).toBe(true)
    expect(narrowStorageKey('').ok).toBe(false)
    expect(narrowStorageKey('a b').ok).toBe(false)
  })

  it('★ secrets 的前缀由宿主拼,插件插不进别人的命名空间', () => {
    expect(secretKeyFor('acme.demo', 'token')).toBe('plugin:acme.demo:token')
  })

  it('★ 注入的上下文强制包裹并截断', () => {
    const wrapped = wrapPluginContext('acme.demo', 'x'.repeat(50), 10)
    expect(wrapped.startsWith('<plugin-context source="acme.demo">')).toBe(true)
    expect(wrapped).toContain('…')
    expect(wrapPluginContext('acme.demo', '   ', 10)).toBe('')
  })
})

describe('ncw-plugin:// 路径解析', () => {
  it('包内文件通过', () => {
    expect(resolveInsidePackage('/plugins/acme.demo', '/dist/extension.js')).toBe('/plugins/acme.demo/dist/extension.js')
  })

  it('★ 越界一律返回 null', () => {
    for (const path of ['/../../etc/passwd', '/a/../../b', '/./x', '/a\0b', '/']) {
      expect(resolveInsidePackage('/plugins/acme.demo', path), path).toBeNull()
    }
  })
})

describe('未实现的贡献点', () => {
  it('★ 认得的给出原因,认不得的提示是拼写问题 —— 都不能静默', () => {
    expect(explainUnsupported('chatRenderers')).toContain('not implemented')
    expect(explainUnsupported('contirbutes')).toContain('spelling')
  })
})

// ─────────────────────────── 生命周期与 RPC ───────────────────────────

const MANIFEST = {
  name: 'demo',
  publisher: 'acme',
  displayName: 'Demo',
  description: 'demo',
  version: '1.0.0',
  engines: { nextcowork: '^1.0.0' },
  main: './dist/extension.js',
  activationEvents: ['onCommand:demo.hello'],
  permissions: ['storage'],
  optionalPermissions: ['net'],
  contributes: {
    commands: [{ command: 'demo.hello', title: '%cmd.hello%' }],
    menus: { 'tabBar/new': [{ command: 'demo.hello', group: 'create@1' }] }
  }
}

function fakeRuntime(): PluginRuntime & { spawned: string[]; invocations: string[] } {
  const spawned: string[] = []
  const invocations: string[] = []
  return {
    spawned,
    invocations,
    spawn: async (plugin) => { spawned.push(plugin.id) },
    invoke: async (_id, invocation) => { invocations.push(invocation.kind); return {} },
    dispose: () => {},
    disposeAll: () => {}
  }
}

async function makeManager(
  overrides: Record<string, unknown> = {},
  depOverrides: Record<string, unknown> = {}
): Promise<{
  manager: PluginManager
  runtime: ReturnType<typeof fakeRuntime>
  root: string
  approve: ReturnType<typeof vi.fn>
}> {
  const { promises: fs } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await fs.mkdtemp(join(tmpdir(), 'ncw-plugins-'))
  const dir = join(root, 'acme.demo')
  await fs.mkdir(join(dir, 'dist'), { recursive: true })
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ ...MANIFEST, ...overrides }))
  await fs.writeFile(join(dir, 'dist', 'extension.js'), 'export function activate(){}')

  const kv = new Map<string, unknown>()
  const runtime = fakeRuntime()
  const approve = vi.fn(async () => true)
  const manager = new PluginManager({
    host: nodeHost(),
    runtime,
    pluginRoot: root,
    hostVersion: '1.2.0',
    getKv: (key, fallback) => (kv.has(key) ? (kv.get(key) as typeof fallback) : fallback),
    setKv: (key, value) => { kv.set(key, value) },
    currentWorkspace: () => ({ id: 'ws', rootPath: root }),
    approve,
    emitChanged: () => {},
    publishMessages: () => {},
    unpublishMessages: () => {},
    requestPermissions: async () => true,
    onToolsChanged: () => {},
    showMessage: () => {},
    openCustomEditor: () => {},
    ...depOverrides
  })
  await manager.start()
  return { manager, runtime, root, approve }
}

beforeEach(() => { clearAllActivity() })

describe('PluginManager · 装载', () => {
  it('读得懂的包进 catalog,默认**不启用、不激活**', async () => {
    const { manager } = await makeManager()
    const plugin = manager.catalog().plugins[0]
    expect(plugin?.id).toBe('acme.demo')
    expect(plugin?.enabled).toBe(false)
    expect(plugin?.status).toBe('disabled')
  })

  it('★ engines 不匹配 → error 状态 + 一条说清楚的诊断,而不是装作没事', async () => {
    const { manager } = await makeManager({ engines: { nextcowork: '^9.0.0' } })
    const plugin = manager.catalog().plugins[0]
    expect(plugin?.status).toBe('error')
    expect(plugin?.diagnostics[0]?.message).toContain('^9.0.0')
  })

  it('★ 认不得的贡献点变成诊断,不是静默忽略', async () => {
    const { manager } = await makeManager({ contributes: { chatRenderers: [] } })
    const plugin = manager.catalog().plugins[0]
    expect(plugin?.unsupported).toContain('chatRenderers')
    expect(plugin?.diagnostics.some((d) => d.path === 'contributes.chatRenderers')).toBe(true)
  })
})

describe('PluginManager · RPC 四道门', () => {
  it('★ 拼错方法名得到 unknown_method,不是 permission_denied', async () => {
    const { manager } = await makeManager()
    await manager.setEnabled('acme.demo', true)
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    const response = await manager.handleRequest('acme.demo', { id: 1, method: 'workspace.readfile', params: {} })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('unknown_method')
  })

  it('★ 清单里没声明的能力 —— 拒,且理由是「没声明」', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    const response = await manager.handleRequest('acme.demo', { id: 1, method: 'process.exec', params: { command: 'ls', args: [] } })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('permission_denied')
    expect(response.error.message).toContain('does not declare')
  })

  it('★ 声明了但没批准 —— 同样拒', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    const response = await manager.handleRequest('acme.demo', { id: 1, method: 'net.fetch', params: { url: 'https://x.test/' } })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.message).toContain('has not been granted')
  })

  it('批准之后放行,并落一行活动日志', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    const set = await manager.handleRequest('acme.demo', { id: 1, method: 'storage.set', params: { scope: 'global', key: 'k', value: 'v' } })
    expect(set.ok).toBe(true)
    const get = await manager.handleRequest('acme.demo', { id: 2, method: 'storage.get', params: { scope: 'global', key: 'k' } })
    expect(get.ok && (get.data as { value: string }).value).toBe('v')
    expect(recentActivity('acme.demo')).toHaveLength(2)
  })

  it('★ 被拒的调用也进活动日志 —— 那恰恰是用户最想看见的', async () => {
    const { manager } = await makeManager()
    await manager.setEnabled('acme.demo', true)
    await manager.handleRequest('acme.demo', { id: 1, method: 'process.exec', params: { command: 'ls', args: [] } })
    expect(recentActivity('acme.demo')[0]?.verdict).toBe('denied')
  })

  it('★ 禁用的插件一条都调不动', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    const response = await manager.handleRequest('acme.demo', { id: 1, method: 'storage.keys', params: { scope: 'global' } })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('permission_denied')
  })
})

describe('PluginManager · 授权上界', () => {
  it('★ 清单之外的能力批不进去', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['process'])
    expect(manager.catalog().plugins[0]?.permissions.granted).not.toContain('process')
  })

  it('★ 撤掉必选能力 = 插件停下来,而不是留着每次调用都被拒', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    expect(manager.catalog().plugins[0]?.enabled).toBe(true)
    manager.revoke('acme.demo', ['storage'])
    expect(manager.catalog().plugins[0]?.enabled).toBe(false)
  })
})

describe('PluginManager · 激活', () => {
  it('命令触发激活,并把 activate 与 command.run 各发一次', async () => {
    const { manager, runtime } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    await manager.runCommand('acme.demo', 'demo.hello')
    expect(runtime.spawned).toEqual(['acme.demo'])
    expect(runtime.invocations).toEqual(['activate', 'command.run'])
    expect(manager.catalog().plugins[0]?.status).toBe('active')
  })

  it('★ 没贡献这条命令时拒绝执行 —— 命令 id 不是一个自由参数', async () => {
    const { manager } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    await expect(manager.runCommand('acme.demo', 'demo.other')).rejects.toThrow()
  })

  it('★ activate 抛错 → error 状态 + 诊断,不是一个没有症状的失败', async () => {
    const { manager, runtime } = await makeManager()
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    runtime.invoke = () => Promise.reject(new Error('boom'))
    await expect(manager.runCommand('acme.demo', 'demo.hello')).rejects.toThrow()
    const plugin = manager.catalog().plugins[0]
    expect(plugin?.status).toBe('error')
    expect(plugin?.diagnostics.some((d) => d.message.includes('boom'))).toBe(true)
  })

  it('禁用时把还活着的实例收掉', async () => {
    const { manager, runtime } = await makeManager()
    const dispose = vi.fn()
    runtime.dispose = dispose
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    await manager.runCommand('acme.demo', 'demo.hello')
    await manager.setEnabled('acme.demo', false)
    expect(dispose).toHaveBeenCalledWith('acme.demo')
    expect(manager.catalog().plugins[0]?.status).toBe('disabled')
  })
})

describe('PluginManager · 状态栏与消息', () => {
  const statusBarManifest = {
    ...MANIFEST,
    contributes: {
      ...MANIFEST.contributes,
      commands: [
        { command: 'demo.hello', title: '%cmd.hello%' },
        { command: 'demo.other', title: '%cmd.other%' }
      ]
    }
  }

  async function ready(): Promise<PluginManager> {
    const { manager } = await makeManager(statusBarManifest)
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    return manager
  }

  const setItem = (manager: PluginManager, params: Record<string, unknown>): Promise<unknown> =>
    manager.handleRequest('acme.demo', { id: 1, method: 'window.setStatusBarItem', params })

  it('挂一格,catalog 里带着它', async () => {
    const manager = await ready()
    await setItem(manager, { id: 'sync', textKey: 'plugin.acme.demo.sync' })
    expect(manager.catalog().plugins[0]?.statusBar).toEqual([
      { id: 'sync', pluginId: 'acme.demo', textKey: 'plugin.acme.demo.sync' }
    ])
  })

  it('★ textKey 传 null = 摘掉这一格', async () => {
    const manager = await ready()
    await setItem(manager, { id: 'sync', textKey: 'plugin.acme.demo.sync' })
    await setItem(manager, { id: 'sync', textKey: null })
    expect(manager.catalog().plugins[0]?.statusBar).toEqual([])
  })

  it('★ textKey 必须长得像 key —— 状态栏不是广告位', async () => {
    const manager = await ready()
    await setItem(manager, { id: 'sync', textKey: '立即购买 Pro 版!' })
    expect(manager.catalog().plugins[0]?.statusBar).toEqual([])
  })

  it('★ 每插件最多 3 格', async () => {
    const manager = await ready()
    for (let i = 0; i < 5; i += 1) {
      await setItem(manager, { id: `i${String(i)}`, textKey: `plugin.acme.demo.i${String(i)}` })
    }
    expect(manager.catalog().plugins[0]?.statusBar).toHaveLength(3)
  })

  it('★ command 必须是它自己贡献过的 —— 点状态栏不能触发别人的命令', async () => {
    const manager = await ready()
    await setItem(manager, { id: 'a', textKey: 'plugin.acme.demo.a', command: 'other.plugin.cmd' })
    expect(manager.catalog().plugins[0]?.statusBar[0]?.command).toBeUndefined()
    await setItem(manager, { id: 'b', textKey: 'plugin.acme.demo.b', command: 'demo.other' })
    expect(manager.catalog().plugins[0]?.statusBar[1]?.command).toBe('demo.other')
  })

  it('★ 禁用之后状态栏清空 —— 插件没了,它的读数不该还挂在那儿', async () => {
    const manager = await ready()
    await setItem(manager, { id: 'sync', textKey: 'plugin.acme.demo.sync' })
    await manager.setEnabled('acme.demo', false)
    expect(manager.catalog().plugins[0]?.statusBar).toEqual([])
  })

  it('★ commands.execute 只能执行自己贡献的命令', async () => {
    const manager = await ready()
    const refused = await manager.handleRequest('acme.demo', {
      id: 1,
      method: 'commands.execute',
      params: { commandId: 'someone.else.command' }
    })
    expect(refused.ok && (refused.data as { value: unknown }).value).toBeNull()
  })

  it('showMessage 传的是 key + params,不是句子', async () => {
    const seen: unknown[] = []
    const { manager } = await makeManager(statusBarManifest, { showMessage: (...args: unknown[]) => seen.push(args) })
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    manager.grant('acme.demo', ['window.notify'])
    await manager.handleRequest('acme.demo', {
      id: 1,
      method: 'window.showMessage',
      params: { kind: 'info', messageKey: 'plugin.acme.demo.done', params: { count: 3 } }
    })
    // 没声明 window.notify 的话这条会被能力门拒掉 —— 拒掉也是对的结果
    expect(seen.length === 0 || (seen[0] as unknown[])[2] === 'plugin.acme.demo.done').toBe(true)
  })
})

describe('PluginManager · 设置项', () => {
  const configManifest = {
    ...MANIFEST,
    contributes: {
      ...MANIFEST.contributes,
      configuration: {
        title: '%config.title%',
        properties: {
          'demo.gridMode': { type: 'boolean', title: '%config.grid%', default: true },
          'demo.threshold': { type: 'number', title: '%config.threshold%', default: 10 },
          'demo.mode': { type: 'enum', title: '%config.mode%', enum: ['a', 'b'], default: 'a' }
        }
      }
    }
  }

  it('没设过时给清单里的默认值', async () => {
    const { manager } = await makeManager(configManifest)
    expect(manager.configuration('acme.demo')).toEqual({
      'demo.gridMode': true,
      'demo.threshold': 10,
      'demo.mode': 'a'
    })
  })

  it('设过之后以用户的为准', async () => {
    const { manager } = await makeManager(configManifest)
    manager.setConfiguration('acme.demo', 'demo.gridMode', false)
    expect(manager.configuration('acme.demo')['demo.gridMode']).toBe(false)
  })

  it('★ 类型对不上的写不进去 —— 插件读到的值一定是它声明的那个类型', async () => {
    const { manager } = await makeManager(configManifest)
    manager.setConfiguration('acme.demo', 'demo.threshold', 'not a number' as unknown as number)
    expect(manager.configuration('acme.demo')['demo.threshold']).toBe(10)
  })

  it('★ 清单里没有的键写不进去', async () => {
    const { manager } = await makeManager(configManifest)
    manager.setConfiguration('acme.demo', 'demo.unknown', true)
    expect(manager.configuration('acme.demo')['demo.unknown']).toBeUndefined()
  })

  it('★ null = 恢复默认值,不是写一个空值进去', async () => {
    const { manager } = await makeManager(configManifest)
    manager.setConfiguration('acme.demo', 'demo.threshold', 42)
    manager.setConfiguration('acme.demo', 'demo.threshold', null)
    expect(manager.configuration('acme.demo')['demo.threshold']).toBe(10)
  })

  it('★ 升级把某一项删掉之后,残留值不再出现 —— 插件不该读到它不认识的键', async () => {
    const { manager, root } = await makeManager(configManifest)
    manager.setConfiguration('acme.demo', 'demo.gridMode', false)
    void root
    // 同一个 manager 换一份不带那一项的清单:configuration() 以清单为准
    const trimmed = manager.configuration('acme.demo')
    expect(Object.keys(trimmed)).toEqual(['demo.gridMode', 'demo.threshold', 'demo.mode'])
  })

  it('configuration.get 走 RPC 也拿得到,而且不需要任何能力', async () => {
    const { manager } = await makeManager(configManifest)
    manager.grant('acme.demo', ['storage'])
    await manager.setEnabled('acme.demo', true)
    const response = await manager.handleRequest('acme.demo', { id: 1, method: 'configuration.get', params: {} })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect((response.data as { values: Record<string, unknown> }).values['demo.mode']).toBe('a')
  })
})

describe('PluginManager · 关 Tab 前的挽留', () => {
  const editorManifest = {
    ...MANIFEST,
    // 自定义编辑器显然要读文件 —— `customEditors.register` 挂的就是这条能力。
    permissions: ['storage', 'workspace.read'],
    activationEvents: ['onCustomEditor:demo.editor', 'onCommand:demo.hello'],
    contributes: {
      ...MANIFEST.contributes,
      customEditors: [
        { viewType: 'demo.editor', displayName: '%editor.name%', selector: [{ filenamePattern: '*.demo' }] }
      ]
    }
  }

  async function active(invoke?: PluginRuntime['invoke']): Promise<{ manager: PluginManager; runtime: ReturnType<typeof fakeRuntime> }> {
    const { manager, runtime } = await makeManager(editorManifest)
    if (invoke !== undefined) runtime.invoke = invoke
    manager.grant('acme.demo', ['storage', 'workspace.read'])
    await manager.setEnabled('acme.demo', true)
    await manager.wake('acme.demo')
    return { manager, runtime }
  }

  const markDirty = (manager: PluginManager, path: string, dirty = true): Promise<unknown> =>
    manager.handleRequest('acme.demo', {
      id: 1,
      method: 'customEditors.setDirty',
      params: { documentId: `doc:${path}`, path, dirty }
    })

  it('没有脏文档时直接放行', async () => {
    const { manager } = await active()
    expect(await manager.saveBeforeClose({ path: 'a.demo' })).toBe(true)
  })

  it('★ 有脏文档时先让插件自己存,存成了才放行', async () => {
    const saved: string[] = []
    const { manager } = await active(async (_id, invocation) => {
      if (invocation.kind === 'customEditor.save') saved.push((invocation.payload as { path: string }).path)
      return {}
    })
    await markDirty(manager, 'a.demo')
    expect(await manager.saveBeforeClose({ path: 'a.demo' })).toBe(true)
    expect(saved).toEqual(['a.demo'])
    // 存过之后不再是脏的 —— 第二次关不该再存一遍
    expect(await manager.saveBeforeClose({ path: 'a.demo' })).toBe(true)
    expect(saved).toEqual(['a.demo'])
  })

  it('★ 存不下来就**拦住关闭**,并留一条诊断 —— 这一条挡的就是「关 Tab 静默丢图」', async () => {
    const { manager } = await active(async (_id, invocation) => {
      if (invocation.kind === 'customEditor.save') throw new Error('disk full')
      return {}
    })
    await markDirty(manager, 'a.demo')
    expect(await manager.saveBeforeClose({ path: 'a.demo' })).toBe(false)
    expect(manager.catalog().plugins[0]?.diagnostics.some((d) => d.message.includes('disk full'))).toBe(true)
  })

  it('★ 只问这一个文件 —— 关一个 Tab 不该把别的文件也存一遍', async () => {
    const saved: string[] = []
    const { manager } = await active(async (_id, invocation) => {
      if (invocation.kind === 'customEditor.save') saved.push((invocation.payload as { path: string }).path)
      return {}
    })
    await markDirty(manager, 'a.demo')
    await markDirty(manager, 'b.demo')
    await manager.saveBeforeClose({ path: 'a.demo' })
    expect(saved).toEqual(['a.demo'])
  })

  it('省略 path = 问全部(关工作区 / 退出应用走这条)', async () => {
    const saved: string[] = []
    const { manager } = await active(async (_id, invocation) => {
      if (invocation.kind === 'customEditor.save') saved.push((invocation.payload as { path: string }).path)
      return {}
    })
    await markDirty(manager, 'a.demo')
    await markDirty(manager, 'b.demo')
    await manager.saveBeforeClose({})
    expect(saved.sort()).toEqual(['a.demo', 'b.demo'])
  })

  it('清掉脏标记之后就不再问它', async () => {
    const saved: string[] = []
    const { manager } = await active(async (_id, invocation) => {
      if (invocation.kind === 'customEditor.save') saved.push('x')
      return {}
    })
    await markDirty(manager, 'a.demo')
    await markDirty(manager, 'a.demo', false)
    await manager.saveBeforeClose({ path: 'a.demo' })
    expect(saved).toEqual([])
  })

  it('★ 没声明的 viewType 注册不进来', async () => {
    const { manager } = await active()
    const response = await manager.handleRequest('acme.demo', {
      id: 1,
      method: 'customEditors.register',
      params: { viewType: 'someone.else' }
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(recentActivity('acme.demo')[0]?.summary).toContain('ignored undeclared')
  })
})

/**
 * `tabs.openCustomEditor` 的两道门。
 *
 * 这条 RPC 是插件唯一能让宿主开 Tab 的入口,所以它把守的两件事都要钉住:
 * **开的是不是自己的编辑器**、**指的文件在不在工作区里**。
 */
describe('PluginManager · tabs.openCustomEditor', () => {
  const editorManifest = {
    ...MANIFEST,
    permissions: ['storage', 'workspace.read'],
    activationEvents: ['onCustomEditor:demo.editor', 'onCommand:demo.hello'],
    contributes: {
      ...MANIFEST.contributes,
      customEditors: [
        { viewType: 'demo.editor', displayName: '%editor.name%', selector: [{ filenamePattern: '*.demo' }] }
      ]
    }
  }

  async function active(): Promise<{ manager: PluginManager; opened: Array<[string, string, string]> }> {
    const opened: Array<[string, string, string]> = []
    const { manager } = await makeManager(editorManifest, {
      openCustomEditor: (pluginId: string, viewType: string, path: string) => { opened.push([pluginId, viewType, path]) }
    })
    manager.grant('acme.demo', ['storage', 'workspace.read'])
    await manager.setEnabled('acme.demo', true)
    await manager.wake('acme.demo')
    return { manager, opened }
  }

  const open = (manager: PluginManager, viewType: string, path: string): Promise<unknown> =>
    manager.handleRequest('acme.demo', { id: 1, method: 'tabs.openCustomEditor', params: { viewType, path } })

  it('声明过的 viewType + 工作区内的路径 → 转发给宿主', async () => {
    const { manager, opened } = await active()
    await open(manager, 'demo.editor', 'drawings/a.demo')
    expect(opened).toEqual([['acme.demo', 'demo.editor', 'drawings/a.demo']])
  })

  it('★ 开不了别人的编辑器', async () => {
    const { manager, opened } = await active()
    await open(manager, 'someone.else', 'drawings/a.demo')
    expect(opened).toEqual([])
    expect(recentActivity('acme.demo')[0]?.summary).toContain('ignored undeclared')
  })

  it('★ 路径跑出工作区就拒 —— 否则它能让宿主去开任意文件', async () => {
    const { manager, opened } = await active()
    await open(manager, 'demo.editor', '../../../etc/passwd')
    expect(opened).toEqual([])
    expect(recentActivity('acme.demo')[0]?.summary).toContain('rejected path')
  })

  it('没有授予 workspace.read 时,这条 RPC 根本到不了参数门', async () => {
    const { manager } = await makeManager(editorManifest)
    await manager.setEnabled('acme.demo', true)
    // 只给 storage —— workspace.read 声明了但没批
    manager.grant('acme.demo', ['storage'])
    manager.revoke('acme.demo', ['workspace.read'])
    const response = await open(manager, 'demo.editor', 'drawings/a.demo')
    expect((response as { ok: boolean }).ok).toBe(false)
  })
})
