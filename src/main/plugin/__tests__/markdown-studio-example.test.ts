/**
 * Markdown Studio 示例插件的**包级验收** —— 与 `image-studio-example.test.ts`
 * 同一立场:走真正的 `installPluginZip`,挡「示例包与安装器的约定悄悄分叉」。
 *
 * 这个示例多挡两件事:
 * - 接管 .md/.markdown 靠两条 `filenamePattern`,少一条就是「某类 markdown
 *   双击还是内置 doc Tab」;
 * - 它声明**零权限**(读写全走文档通道),且不需要新宿主能力
 * (engines 与 excalidraw 同底线)—— 哪天这两条变了,这里会红。
 *
 * ★ 没打包时跳过而不是失败(ZIP 是构建产物,不进版本库)。
 */
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginZip } from '../installer'

const EXAMPLE = resolve(__dirname, '../../../../examples/acme.markdown-studio')

function currentZip(): string | null {
  if (!existsSync(EXAMPLE)) return null
  const zip = readdirSync(EXAMPLE)
    .filter((name) => /^acme\.markdown-studio-\d+\.\d+\.\d+\.zip$/.test(name))
    .sort()
    .pop()
  return zip === undefined ? null : join(EXAMPLE, zip)
}

const ZIP = currentZip()

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(ZIP === null)('示例插件 acme.markdown-studio', () => {
  it('能被真正的安装器装上,markdown 接管选择器与分割产物齐全', async () => {
    if (ZIP === null) return
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-markdown-studio-'))
    roots.push(root)

    const installed = await installPluginZip(ZIP, root)

    expect(installed.manifest.id).toBe('acme.markdown-studio')
    expect(installed.manifest.permissions).toEqual([])
    expect(installed.manifest.activationEvents).toEqual(['onCustomEditor:markdown-studio.editor'])

    const editor = installed.manifest.contributes.customEditors[0]
    expect(editor?.viewType).toBe('markdown-studio.editor')
    expect(editor?.selector.map((item) => item.filenamePattern)).toEqual(['*.md', '*.markdown'])
    expect(editor?.priority).toBe('default')

    const view = installed.manifest.contributes.views[0]
    expect(view?.path).toBe('dist/view/index.html')
    expect(existsSync(join(installed.target, 'dist/view/index.html'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/main.js'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/main.css'))).toBe(true)
    // 代码分割产物(chunk)必须真的在包里:入口在、语言 chunk 缺失的话,
    // 表现为「代码块永远没有高亮且零报错」。
    const viewFiles = readdirSync(join(installed.target, 'dist/view')).filter((name) => name.endsWith('.js'))
    expect(viewFiles.length).toBeGreaterThan(10)

    expect(existsSync(join(installed.target, 'l10n/zh-CN.json'))).toBe(true)
    expect(existsSync(join(installed.target, 'l10n/en-US.json'))).toBe(true)

    /*
      ★ 图标。与 image-studio 那条同一句约定:安装器会核对清单的 `icon`
      真的在包里 —— 显式断言一次,把「必须带图标」写成纸面约定。
    */
    expect(installed.manifest.icon).toBe('assets/icon.png')
    expect(existsSync(join(installed.target, 'assets/icon.png'))).toBe(true)
  })
})
