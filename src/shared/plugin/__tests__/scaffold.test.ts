/**
 * 脚手架产出的骨架,**宿主认不认**。
 *
 * ## 为什么这条测试值得单独存在
 *
 * 计划里插件系统的唯一验收标准是:「作者只读公开文档、只用公开工具链,
 * 就能从零做出一个能上架的插件」。那条标准里最容易悄悄失守的一环是
 * **脚手架与宿主校验器之间的漂移** —— 它们在两个目录里、由两拨改动推进,
 * 而漂移的症状是「照着官方模板写的插件装不上」。
 *
 * 没有比这更劝退的第一印象了。所以这里直接拿模板里那份 `package.json`
 * 喂给宿主真正用的那个校验器。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest'
import { PLUGIN_API_VERSION, engineCompatibility } from '../api-version'
import { MENU_ICON_NAMES } from '../contribution'
import { PLUGIN_PERMISSIONS } from '../permission'

const TEMPLATE_DIR = join(process.cwd(), 'packages', 'create-nextcowork-plugin', 'template')
const CLI_ENTRY = join(process.cwd(), 'packages', 'create-nextcowork-plugin', 'index.mjs')

/**
 * 脚手架真正会填进去的那个 engines 默认值。
 *
 * ★ **从 `index.mjs` 里读**,不在这里抄一份。抄一份的话,这个文件描述的
 * 「脚手架与校验器不许漂移」就只剩一半 —— 默认值改了而模板测试照过,
 * 而那正是「照着官方模板写的插件装不上」的来源。
 */
function defaultEngines(): string {
  const source = readFileSync(CLI_ENTRY, 'utf8')
  const match = /const DEFAULT_ENGINES = '([^']+)'/.exec(source)
  if (match?.[1] === undefined) throw new Error('DEFAULT_ENGINES not found in create-nextcowork-plugin/index.mjs')
  return match[1]
}

/** 脚手架填进去的那几个占位符。和 `create-nextcowork-plugin/index.mjs` 一一对应。 */
function scaffold(): unknown {
  const raw = readFileSync(join(TEMPLATE_DIR, 'package.json'), 'utf8')
  const filled = raw
    .replaceAll('__PUBLISHER__', 'acme')
    .replaceAll('__NAME__', 'hello')
    .replaceAll('__DISPLAY_NAME__', 'Hello')
    .replaceAll('__DESCRIPTION__', 'A NextCoWork plugin')
    .replaceAll('__ENGINES__', defaultEngines())
  return JSON.parse(filled)
}

describe('脚手架模板', () => {
  it('★ 生成出来的清单直接过宿主校验器 —— 不然「照着模板写装不上」', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true)
  })

  it('没有遗留占位符 —— 漏替换一个的症状是界面上显示一串下划线', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.manifest)).not.toContain('__')
  })

  it('★ id 由 publisher 与 name 拼出来,和 ZIP 顶层目录用的是同一个', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.id).toBe('acme.hello')
  })

  it('★ 默认 engines 能装在这一版宿主上 —— 装不上的模板等于没有模板', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    /*
      ★ 比的是**插件 API 版本**,不是应用版本。这条断言存在的理由就是那个
      「模板默认 `^0.2.0` vs 宿主 `app.getVersion()` = 2.x → 恒不匹配」的 bug:
      当时这里拿 '0.2.0' 当宿主版本传进来,于是测试是绿的而真机上全红。
    */
    expect(engineCompatibility(result.manifest.engines, PLUGIN_API_VERSION)).toBe('ok')
  })

  it('★ 两种语言的 l10n 都在,且 key 集合一致', () => {
    const zh = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'l10n', 'zh-CN.json'), 'utf8')) as Record<string, string>
    const en = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'l10n', 'en-US.json'), 'utf8')) as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    // 两边给的是不同的串 —— 不然只是把中文抄进了英文那份
    for (const key of Object.keys(zh)) expect(en[key], key).not.toBe(zh[key])
  })

  it('★ 贡献点引用的 l10n key 在 bundle 里真的存在', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const zh = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'l10n', 'zh-CN.json'), 'utf8')) as Record<string, string>
    for (const command of result.manifest.contributes.commands) {
      // `%cmd.hello%` → `cmd.hello`
      expect(zh[command.title.slice(1, -1)], command.title).toBeDefined()
    }
  })

  it('声明的能力与图标都在宿主的白名单里', () => {
    const result = parsePluginManifest(scaffold())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const permission of result.manifest.permissions) expect(PLUGIN_PERMISSIONS).toContain(permission)
    for (const command of result.manifest.contributes.commands) {
      if (command.icon === undefined) continue
      expect(MENU_ICON_NAMES, command.icon).toContain(command.icon)
    }
  })

  it('★ 模板里的代码用的是完整 l10n key —— 只替换清单会让消息显示成一串 key', () => {
    const source = readFileSync(join(TEMPLATE_DIR, 'src', 'extension.ts'), 'utf8')
    // 宿主拼的是 `plugin.<publisher>.<name>.<key>`,模板里必须写成这个形状
    expect(source).toContain('plugin.__PUBLISHER__.__NAME__.')
  })
})

/**
 * `--view` 那一份(`template-view/`)。
 *
 * 它比主模板更容易悄悄坏掉:生成逻辑在 `index.mjs` 里**拼 JSON**,
 * 而不是像主模板那样替换占位符 —— 拼错了模板文件本身看不出来。
 */
describe('脚手架的 React 视图(--view)', () => {
  const VIEW_TEMPLATE_DIR = join(process.cwd(), 'packages', 'create-nextcowork-plugin', 'template-view')

  /** 复刻 `index.mjs` 里 `--view` 那段对清单做的事。改了那边,这里要一起改。 */
  function scaffoldWithView(): unknown {
    const pkg = scaffold() as {
      views?: unknown
      activationEvents: string[]
      contributes: Record<string, unknown>
    }
    const viewType = 'acme.hello.editor'
    pkg.views = { 'view/editor.tsx': 'dist/view/editor.js' }
    pkg.contributes.customEditors = [
      { viewType, displayName: '%editor.displayName%', selector: [{ filenamePattern: '*.hello' }], priority: 'default' }
    ]
    pkg.contributes.views = [
      { id: viewType, title: '%editor.displayName%', icon: 'file-pen', path: 'dist/view/editor.html' }
    ]
    pkg.activationEvents = [...new Set([...pkg.activationEvents, `onCustomEditor:${viewType}`])]
    return pkg
  }

  it('★ 带视图的清单同样过校验器', () => {
    const result = parsePluginManifest(scaffoldWithView())
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true)
  })

  it('★★ 生成的是**自定义编辑器**,不是一个点不开的面板', () => {
    /*
      插件视图想被打开,当前只有两条路:绑定到某类文件(customEditors),
      或者是一个网址(webApps)。`contributes.views` 里 location 为 sidebar/panel
      的那种解析得了、装得上,但界面上**没有任何地方能打开它**。
      脚手架要是生成了那种,作者会以为是自己写错了 —— 比不生成更糟。
    */
    const result = parsePluginManifest(scaffoldWithView())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.contributes.customEditors).toHaveLength(1)
    expect(result.manifest.activationEvents).toContain('onCustomEditor:acme.hello.editor')
    // 视图声明的 location 必须是 editor(缺省)—— 别的值现在打不开
    for (const view of result.manifest.contributes.views) {
      expect(view.location ?? 'editor').toBe('editor')
    }
  })

  it('★ 视图源码把 react 与宿主控件当成外部模块 —— 打进去就是两份 React', () => {
    const source = readFileSync(join(VIEW_TEMPLATE_DIR, 'view', 'editor.tsx'), 'utf8')
    expect(source).toContain("from 'nextcowork/ui'")
    expect(source).toContain("from 'nextcowork/view'")
    // 相对路径 import 一个自带的 react 副本 = 两份实例,症状是 Invalid hook call
    expect(source).not.toMatch(/from '\.\.?\/.*react/)
  })

  it('★ HTML 不自己引样式,也不自己写 CSP —— 两样都由宿主注入', () => {
    const html = readFileSync(join(VIEW_TEMPLATE_DIR, 'view', 'editor.html'), 'utf8')
    expect(html).not.toContain('<meta http-equiv="Content-Security-Policy"')
    // 判的是**有没有 link 标签**,不是有没有提到那个文件名 —— 注释里说明它由宿主注入是对的
    expect(html).not.toMatch(/<link[^>]+stylesheet/i)
    // 入口脚本必须是 module —— import map 只对 module 生效
    expect(html).toContain('type="module"')
  })
})
