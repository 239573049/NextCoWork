/**
 * 「谁来打开这个文件」的测试。
 *
 * 这一块守着两条错了不会报错、只会悄悄变形的规则:
 * 1. 模式匹配**不能编译成正则** —— 它吃的是第三方清单里的任意字符串;
 * 2. 多个插件认领同一后缀时,结果**必须确定** —— 否则装一个不相干的插件
 *    就可能让已经开着的文件换一个编辑器。
 */
import { describe, expect, it } from 'vitest'
import { matchesFilenamePattern, pickCustomEditor } from '../custom-editor'
import type { InstalledPlugin, PluginStatus } from '../state'
import type { PluginCustomEditorContribution } from '../manifest'

describe('matchesFilenamePattern', () => {
  it('后缀模式匹得上,也匹得上子目录里的同后缀文件', () => {
    expect(matchesFilenamePattern('*.excalidraw', 'a.excalidraw')).toBe(true)
    expect(matchesFilenamePattern('*.excalidraw', 'drawings/a.excalidraw')).toBe(true)
    expect(matchesFilenamePattern('*.excalidraw', 'a.md')).toBe(false)
  })

  it('★ 带 / 的模式匹整条路径,不带的只匹文件名', () => {
    // 不带 `/`:`drawings/` 这一段不参与比对
    expect(matchesFilenamePattern('*.excalidraw', 'deep/nested/a.excalidraw')).toBe(true)
    // 带 `/`:必须整条对上,而 `*` 不跨目录分隔符也匹不到更深的层级
    expect(matchesFilenamePattern('drawings/*.excalidraw', 'drawings/a.excalidraw')).toBe(true)
    expect(matchesFilenamePattern('drawings/*.excalidraw', 'other/a.excalidraw')).toBe(false)
  })

  it('大小写不敏感 —— 同一个文件换个大小写不该突然打不开', () => {
    expect(matchesFilenamePattern('*.excalidraw', 'A.EXCALIDRAW')).toBe(true)
    expect(matchesFilenamePattern('*.EXCALIDRAW', 'a.excalidraw')).toBe(true)
  })

  it('Windows 反斜杠路径归一之后一样匹', () => {
    expect(matchesFilenamePattern('*.excalidraw', 'drawings\\a.excalidraw')).toBe(true)
  })

  it('空模式 / 空路径一律不匹,而不是匹一切', () => {
    expect(matchesFilenamePattern('', 'a.excalidraw')).toBe(false)
    expect(matchesFilenamePattern('*.excalidraw', '')).toBe(false)
  })

  it('★ 灾难性回溯的模式不会把它挂住 —— 这是不编译成正则的全部理由', () => {
    // `(a*)*b` 那一类模式喂给正则引擎会指数爆炸;两指针最坏 O(n·m)
    const evil = '*'.repeat(40) + 'b'
    const started = Date.now()
    expect(matchesFilenamePattern(evil, 'a'.repeat(4000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('纯 * 匹一切非空名字,连续 * 不改变语义', () => {
    expect(matchesFilenamePattern('*', 'a.excalidraw')).toBe(true)
    expect(matchesFilenamePattern('**.excalidraw', 'a.excalidraw')).toBe(true)
  })
})

function plugin(
  id: string,
  editors: PluginCustomEditorContribution[],
  extra: { enabled?: boolean; status?: PluginStatus } = {}
): InstalledPlugin {
  return {
    id,
    status: extra.status ?? 'active',
    enabled: extra.enabled ?? true,
    scope: 'global',
    path: `/plugins/${id}`,
    permissions: { required: [], optional: [], granted: [] },
    diagnostics: [],
    unsupported: [],
    installedAt: 0,
    updatedAt: 0,
    statusBar: [],
    manifest: {
      id,
      name: id.split('.')[1] ?? id,
      publisher: id.split('.')[0] ?? id,
      kind: 'extension',
      displayName: id,
      description: '',
      version: '1.0.0',
      categories: [],
      keywords: [],
      engines: '^1.0.0',
      main: './dist/extension.js',
      activationEvents: [],
      permissions: [],
      optionalPermissions: [],
      hostPermissions: [],
      allowedCommands: [],
      dependencies: {},
      contributes: {
        commands: [],
        menus: {},
        customEditors: editors,
        views: [],
        webApps: [],
        tools: [],
        cardViews: [],
        keybindings: [],
        slashCommands: [],
        skills: [],
        agents: [],
        modes: [],
        themes: [],
        unsupported: []
      }
    }
  }
}

const EXCALIDRAW: PluginCustomEditorContribution = {
  viewType: 'excalidraw.editor',
  displayName: '%editor.displayName%',
  selector: [{ filenamePattern: '*.excalidraw' }],
  priority: 'default'
}

describe('pickCustomEditor', () => {
  it('命中时同时给出 pluginId 和 viewType —— 两样都要落盘', () => {
    const picked = pickCustomEditor([plugin('acme.excalidraw', [EXCALIDRAW])], 'a.excalidraw')
    expect(picked).toEqual({ pluginId: 'acme.excalidraw', viewType: 'excalidraw.editor' })
  })

  it('没人认领就返回 null,由调用方退回内置 doc', () => {
    expect(pickCustomEditor([plugin('acme.excalidraw', [EXCALIDRAW])], 'README.md')).toBeNull()
    expect(pickCustomEditor([], 'a.excalidraw')).toBeNull()
  })

  it('★ 禁用 / 装载失败 / 待批准的插件不参与认领', () => {
    for (const extra of [
      { enabled: false },
      { status: 'error' as const },
      { status: 'pending-approval' as const }
    ]) {
      const catalog = [plugin('acme.excalidraw', [EXCALIDRAW], extra)]
      expect(pickCustomEditor(catalog, 'a.excalidraw'), JSON.stringify(extra)).toBeNull()
    }
  })

  it('休眠的插件照样认领 —— 打开文件本身就是把它叫醒的理由', () => {
    const catalog = [plugin('acme.excalidraw', [EXCALIDRAW], { status: 'asleep' })]
    expect(pickCustomEditor(catalog, 'a.excalidraw')?.pluginId).toBe('acme.excalidraw')
  })

  it("★ priority: 'default' 压过 'option'", () => {
    const option = plugin('aaa.first', [{ ...EXCALIDRAW, viewType: 'a.editor', priority: 'option' }])
    const preferred = plugin('zzz.last', [{ ...EXCALIDRAW, viewType: 'z.editor', priority: 'default' }])
    // 故意让 'option' 那个排在数组前面、id 也更小 —— 只有 priority 该起作用
    expect(pickCustomEditor([option, preferred], 'a.excalidraw')?.viewType).toBe('z.editor')
  })

  it('★ 同优先级时按插件 id 定序,不跟着 catalog 的顺序走', () => {
    const a = plugin('aaa.one', [{ ...EXCALIDRAW, viewType: 'a.editor' }])
    const z = plugin('zzz.two', [{ ...EXCALIDRAW, viewType: 'z.editor' }])
    expect(pickCustomEditor([z, a], 'a.excalidraw')?.pluginId).toBe('aaa.one')
    expect(pickCustomEditor([a, z], 'a.excalidraw')?.pluginId).toBe('aaa.one')
  })

  it('一个插件贡献多个编辑器时,按 selector 分别认领', () => {
    const multi = plugin('acme.multi', [
      EXCALIDRAW,
      { viewType: 'acme.sketch', displayName: '%x%', selector: [{ filenamePattern: '*.sketch' }] }
    ])
    expect(pickCustomEditor([multi], 'a.sketch')?.viewType).toBe('acme.sketch')
    expect(pickCustomEditor([multi], 'a.excalidraw')?.viewType).toBe('excalidraw.editor')
  })

  it('priority 省略时按 default 算 —— 解析那一层就是这么定的', () => {
    const noPriority = plugin('aaa.plain', [{ viewType: 'p.editor', displayName: '%x%', selector: [{ filenamePattern: '*.excalidraw' }] }])
    const option = plugin('aaa.opt', [{ ...EXCALIDRAW, viewType: 'o.editor', priority: 'option' }])
    expect(pickCustomEditor([option, noPriority], 'a.excalidraw')?.viewType).toBe('p.editor')
  })
})
