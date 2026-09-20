/**
 * `kind: "webapp"` —— **零代码插件**这条路的规则。
 *
 * 这一族断言钉的是同一件事:一个没有代码的插件,要么被完整接受、要么被明确拒绝,
 * **不许出现「接受了但那部分不生效」**。后者正是插件系统最糟的失败方式:
 * 作者写了 `contributes.tools`,装上、启用、什么都没发生,而日志里一个字都没有。
 */
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest'

const BASE = {
  publisher: 'ncw',
  name: 'demo',
  displayName: 'Demo',
  description: 'demo',
  version: '1.0.0',
  engines: { nextcowork: '^0.3.0' }
}

function parse(extra: Record<string, unknown>): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest({ ...BASE, ...extra })
}

function errorFields(result: ReturnType<typeof parsePluginManifest>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.field)
}

describe('kind: webapp', () => {
  it('★ 不要求 main —— 这条就是「零代码」本身', () => {
    const result = parse({
      kind: 'webapp',
      contributes: { webApps: [{ id: 'home', title: '%app.home%', url: 'https://example.com/' }] }
    })
    expect(result.ok, JSON.stringify(errorFields(result))).toBe(true)
    if (!result.ok) return
    expect(result.manifest.kind).toBe('webapp')
    expect(result.manifest.main).toBe('')
  })

  it('★ 写了 main 的 webapp **整份拒绝**,而不是忽略那个字段', () => {
    /*
      忽略的话,作者会以为自己的代码在跑,然后对着一个永远不执行的 activate()
      排查打包、排查路径 —— 而真正的原因是「这类插件根本不跑代码」。
    */
    const result = parse({
      kind: 'webapp',
      main: './dist/extension.js',
      contributes: { webApps: [{ id: 'home', title: '%app.home%', url: 'https://example.com/' }] }
    })
    expect(errorFields(result)).toContain('main')
  })

  it('★ webapp 不能贡献需要代码的东西 —— 那会是一个永远没有处理函数的注册', () => {
    const result = parse({
      kind: 'webapp',
      contributes: {
        webApps: [{ id: 'home', title: '%app.home%', url: 'https://example.com/' }],
        commands: [{ command: 'demo.run', title: '%cmd.run%' }],
        tools: [{ name: 'do_it', title: '%tool.doIt%' }]
      }
    })
    expect(errorFields(result)).toEqual(expect.arrayContaining(['contributes.commands', 'contributes.tools']))
  })

  it('认不出的 kind 报错,而不是悄悄当成 extension', () => {
    expect(errorFields(parse({ kind: 'plugin', main: './dist/extension.js' }))).toContain('kind')
  })

  it('老清单(没有 kind)解析成 extension,行为一个字节都不变', () => {
    const result = parse({ main: './dist/extension.js' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.kind).toBe('extension')
    expect(result.manifest.main).toBe('./dist/extension.js')
  })
})

describe('contributes.webApps', () => {
  const webapp = (app: Record<string, unknown>): ReturnType<typeof parsePluginManifest> =>
    parse({ kind: 'webapp', contributes: { webApps: [app] } })

  it('★ 地址在装载期就判,不留到点开那一刻', () => {
    /*
      留到运行期的话,一个写错地址的插件会安静地装上、在侧边栏占一个位置,
      点下去才什么都不发生 —— 而作者收不到任何提示。
    */
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'http://example.com/' }))).toContain('contributes.webApps.a.url')
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'ftp://example.com/' }))).toContain('contributes.webApps.a.url')
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'not a url' }))).toContain('contributes.webApps.a.url')
    // ★ 带凭据的地址同样拒:webapp 的 cookie 住在工作区浏览器分区里
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'https://u:p@example.com/' }))).toContain('contributes.webApps.a.url')
  })

  it('标题必须是 %key%,不是裸文案', () => {
    expect(errorFields(webapp({ id: 'a', title: '哔哩哔哩', url: 'https://example.com/' })))
      .toContain('contributes.webApps.a.title')
  })

  it('认不出的 open / entry 取值报错 —— 静默回落会让「我明明写了 right」无从解释', () => {
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'https://example.com/', open: 'window' })))
      .toContain('contributes.webApps.a.open')
    expect(errorFields(webapp({ id: 'a', title: '%t%', url: 'https://example.com/', entry: 'dock' })))
      .toContain('contributes.webApps.a.entry')
  })

  it('缺省值不落进结果里 —— 老清单的解析结果不该因为新增字段而改变形状', () => {
    const result = webapp({ id: 'a', title: '%t%', url: 'https://example.com/' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const app = result.manifest.contributes.webApps[0]
    expect(app).toEqual({ id: 'a', title: '%t%', url: 'https://example.com/' })
  })
})

describe('contributes.slashCommands', () => {
  it('★ 必须指向一条已声明的命令 —— 指不到的话,用户选中它之后什么都不会发生', () => {
    const result = parse({
      main: './dist/extension.js',
      contributes: {
        commands: [{ command: 'demo.run', title: '%cmd.run%' }],
        slashCommands: [{ name: 'run', command: 'demo.nope', title: '%slash.run%' }]
      }
    })
    expect(errorFields(result)).toContain('contributes.slashCommands.run.command')
  })

  it('名字会**原样出现在输入框里**,所以不许有空格和大写', () => {
    const bad = parse({
      main: './dist/extension.js',
      contributes: {
        commands: [{ command: 'demo.run', title: '%cmd.run%' }],
        slashCommands: [{ name: 'Run It', command: 'demo.run', title: '%slash.run%' }]
      }
    })
    expect(errorFields(bad)).toContain('contributes.slashCommands')
  })
})

describe('contributes.views[].location', () => {
  it('缺省是 editor —— 改缺省会让已经装着的编辑器类插件当场打不开文件', () => {
    const result = parse({
      main: './dist/extension.js',
      contributes: { views: [{ id: 'v', title: '%v%', path: 'dist/view.html' }] }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 不写就**不落这个字段**:落了的话老清单的解析结果会变
    expect(result.manifest.contributes.views[0]).toEqual({ id: 'v', title: '%v%', path: 'dist/view.html' })
  })

  it('认不出的 location 报错', () => {
    const result = parse({
      main: './dist/extension.js',
      contributes: { views: [{ id: 'v', title: '%v%', path: 'dist/view.html', location: 'float' }] }
    })
    expect(errorFields(result)).toContain('contributes.views.v.location')
  })
})
