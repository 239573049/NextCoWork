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
import { parsePluginManifest, satisfiesEngine } from '../manifest'
import { MENU_ICON_NAMES } from '../contribution'
import { PLUGIN_PERMISSIONS } from '../permission'

const TEMPLATE_DIR = join(process.cwd(), 'packages', 'create-nextcowork-plugin', 'template')

/** 脚手架填进去的那几个占位符。和 `create-nextcowork-plugin/index.mjs` 一一对应。 */
function scaffold(): unknown {
  const raw = readFileSync(join(TEMPLATE_DIR, 'package.json'), 'utf8')
  const filled = raw
    .replaceAll('__PUBLISHER__', 'acme')
    .replaceAll('__NAME__', 'hello')
    .replaceAll('__DISPLAY_NAME__', 'Hello')
    .replaceAll('__DESCRIPTION__', 'A NextCoWork plugin')
    .replaceAll('__ENGINES__', '^0.2.0')
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
    expect(satisfiesEngine(result.manifest.engines, '0.2.0')).toBe(true)
    expect(satisfiesEngine(result.manifest.engines, '0.2.99')).toBe(true)
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
