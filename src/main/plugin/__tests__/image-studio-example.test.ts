/**
 * Image Studio 示例插件的**包级验收** —— 与 `excalidraw-example.test.ts` 同一立场:
 * 走真正的 `installPluginZip`,挡「示例包与安装器的约定悄悄分叉」。
 *
 * 这个示例比 Excalidraw 多挡两件事:
 * - 接管图片打开靠 8 条 `filenamePattern`,少一条就是「某类图双击还是文本 Tab」;
 * - 它声明**零权限** —— 读写全走宿主代理的文档通道。哪天清单里冒出
 *   `workspace.write`,要么是有人改了架构,要么是有人绕了通道,都该被看见。
 *
 * ★ 没打包时跳过而不是失败(同 Excalidraw 那份的理由:ZIP 是构建产物)。
 */
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginZip } from '../installer'

const EXAMPLE = resolve(__dirname, '../../../../examples/acme.image-studio')

function currentZip(): string | null {
  if (!existsSync(EXAMPLE)) return null
  const zip = readdirSync(EXAMPLE)
    .filter((name) => /^acme\.image-studio-\d+\.\d+\.\d+\.zip$/.test(name))
    .sort()
    .pop()
  return zip === undefined ? null : join(EXAMPLE, zip)
}

const ZIP = currentZip()

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(ZIP === null)('示例插件 acme.image-studio', () => {
  it('能被真正的安装器装上,图片接管选择器与视图文件齐全', async () => {
    if (ZIP === null) return
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-image-studio-'))
    roots.push(root)

    const installed = await installPluginZip(ZIP, root)

    expect(installed.manifest.id).toBe('acme.image-studio')
    expect(installed.manifest.permissions).toEqual([])
    expect(installed.manifest.activationEvents).toEqual(['onCustomEditor:image-studio.editor'])

    // 认领的扩展名一张表对齐 —— 少一条就有一类图打不开(退回内置 doc)
    const editor = installed.manifest.contributes.customEditors[0]
    expect(editor?.viewType).toBe('image-studio.editor')
    expect(editor?.selector.map((item) => item.filenamePattern)).toEqual([
      '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.bmp', '*.avif', '*.ico'
    ])
    expect(editor?.priority).toBe('default')

    // 编辑器视图:HTML/JS/CSS 三样,少 CSS 时控件都在但没有样式
    const view = installed.manifest.contributes.views[0]
    expect(view?.path).toBe('dist/view/index.html')
    expect(existsSync(join(installed.target, 'dist/view/index.html'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/main.js'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/main.css'))).toBe(true)

    expect(existsSync(join(installed.target, 'l10n/zh-CN.json'))).toBe(true)
    expect(existsSync(join(installed.target, 'l10n/en-US.json'))).toBe(true)

    expect(installed.manifest.icon).toBe('assets/icon.png')
    expect(existsSync(join(installed.target, 'assets/icon.png'))).toBe(true)
  })
})
