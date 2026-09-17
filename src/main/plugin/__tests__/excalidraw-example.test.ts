/**
 * Excalidraw 示例插件的**包级验收**。
 *
 * 它回答一个问题:`examples/acme.excalidraw` 打出来的 ZIP,能不能被客户端
 * 真正的安装器装上去。
 *
 * ★ 走的是 `installPluginZip` 本尊,不是一份仿制的校验:这份测试要挡的正是
 * 「示例包与安装器的约定悄悄分叉」——而分叉的症状是文档里的例子装不上。
 *
 * ★ 没打包时**跳过**而不是失败:ZIP 是构建产物,不进版本库(见 .gitignore),
 * 在干净检出上让它红着会把「CI 该不该跑构建」这件事伪装成一次测试失败。
 */
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginZip } from '../installer'

const EXAMPLE = resolve(__dirname, '../../../../examples/acme.excalidraw')

/**
 * 示例当前打出来的那个包。
 *
 * ★ **不写死版本号**。写死的话,每次给插件升版本,这条测试就从「跑」变成
 * 「静默跳过」—— 而跳过时它是绿的,没人会注意到示例包已经没人验了。
 */
function currentZip(): string | null {
  if (!existsSync(EXAMPLE)) return null
  const zip = readdirSync(EXAMPLE)
    .filter((name) => /^acme\.excalidraw-\d+\.\d+\.\d+\.zip$/.test(name))
    .sort()
    .pop()
  return zip === undefined ? null : join(EXAMPLE, zip)
}

const ZIP = currentZip()

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(ZIP === null)('示例插件 acme.excalidraw', () => {
  it('能被真正的安装器装上,而且清单与贡献点都读得出来', async () => {
    /*
      `skipIf` 已经在运行期排除掉 null,但类型系统不知道 —— 这一行是给它看的。
      不写成 `ZIP!` 是因为那会把「这里为什么一定不是 null」变成一句无人可查的断言。
    */
    if (ZIP === null) return
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-excalidraw-'))
    roots.push(root)

    const installed = await installPluginZip(ZIP, root)

    expect(installed.manifest.id).toBe('acme.excalidraw')
    expect(installed.manifest.permissions).toEqual(['workspace.read', 'workspace.write'])

    // 自定义编辑器认 .excalidraw —— 这条决定了双击文件能不能落到这个插件身上
    const editor = installed.manifest.contributes.customEditors[0]
    expect(editor?.viewType).toBe('excalidraw.editor')
    expect(editor?.selector[0]?.filenamePattern).toBe('*.excalidraw')

    // 画布视图必须真的在包里:`main` 存在但视图缺席的话,Tab 会降级成只读预览
    const view = installed.manifest.contributes.views[0]
    expect(view?.path).toBe('dist/view/index.html')
    expect(existsSync(join(installed.target, 'dist/view/index.html'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/main.js'))).toBe(true)
    /*
      ★ CSS 与字体一并断言。两者都属于「少了也能装上、但画布是坏的」那一类:
      没有 CSS 工具栏散架,没有 fonts 手写体退化成系统字体,而安装器
      对这两样都不会有任何意见。
    */
    expect(existsSync(join(installed.target, 'dist/view/main.css'))).toBe(true)
    expect(existsSync(join(installed.target, 'dist/view/fonts'))).toBe(true)

    // 两种语言缺一个就该被拒装 —— 这里反过来确认示例包是齐的
    expect(existsSync(join(installed.target, 'l10n/zh-CN.json'))).toBe(true)
    expect(existsSync(join(installed.target, 'l10n/en-US.json'))).toBe(true)

    /*
      ★ 图标。安装器**会**核对它(清单的 `icon` 必须在包里),所以真缺了这条
      测试会因为前面抛错而红 —— 这里显式再断言一次,是为了让「必须带图标」
      成为一条写下来的约定,而不是某次打包漏拷 assets/ 之后才被发现的事故。
    */
    expect(installed.manifest.icon).toBe('assets/icon.png')
    expect(existsSync(join(installed.target, 'assets/icon.png'))).toBe(true)
  })
})