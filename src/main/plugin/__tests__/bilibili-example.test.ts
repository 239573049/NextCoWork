/**
 * `ncw.bilibili` 示例的**包级验收** —— 同 `excalidraw-example.test.ts` 的立场:
 * 走真正的安装器,挡「示例包与校验器悄悄分叉」。
 *
 * 这一份挡的是**零代码那条路**整条是否成立:
 *
 * 1. 没有 `main` 的清单能被解析、能被安装器接受(`assertPackageFiles` 不再查入口);
 * 2. `kind: 'webapp'` 在装载后仍然是 webapp —— 它决定了宿主**永不为它起进程**;
 * 3. 声明的网址过 URL 门(https、无凭据);
 * 4. 零能力。哪天这里冒出一条权限,要么是有人改了模型,要么是示例被改坏了,
 *    两种都该被看见。
 *
 * ★ 与那两份不同:这里装的是**目录**而不是 ZIP,所以不需要 skipIf ——
 * 零代码包没有构建产物,目录本身就是成品,这正是它存在的意义。
 */
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginDirectory } from '../installer'

const EXAMPLE = resolve(__dirname, '../../../../examples/ncw.bilibili')

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('示例插件 ncw.bilibili(零代码网页应用)', () => {
  it('★ 没有 main 的清单能装上,并且仍然是 webapp —— 这条断言就是「零代码」本身', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-bilibili-'))
    roots.push(root)

    const installed = await installPluginDirectory(EXAMPLE, root)

    expect(installed.manifest.id).toBe('ncw.bilibili')
    expect(installed.manifest.kind).toBe('webapp')
    // ★ main 必须是空串。不是空串意味着有人给零代码包补了个入口,
    //   而那会让宿主开始为它起进程 —— 正是这个 kind 要避免的事。
    expect(installed.manifest.main).toBe('')
    expect(installed.manifest.permissions).toEqual([])
    expect(installed.manifest.optionalPermissions).toEqual([])
  })

  it('两条入口的地址都在 hostPermissions 之内 —— 否则站内跳转会被自己拦下来', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-bilibili-'))
    roots.push(root)

    const { manifest } = await installPluginDirectory(EXAMPLE, root)
    const { matchesHostPermission } = await import('../../../shared/plugin/manifest')

    expect(manifest.contributes.webApps.map((app) => app.id)).toEqual(['home', 'feed'])
    for (const app of manifest.contributes.webApps) {
      expect(app.url.startsWith('https://'), app.url).toBe(true)
      /*
        ★ 首页地址必须命中自己的 hostPermissions:webview 的第一跳就是它,
        而 `PluginWebAppView` 的导航门按同一张表判定 —— 不命中的话,
        用户点开看到的是一条「已交给系统浏览器」的提示,而不是页面。
      */
      expect(matchesHostPermission(manifest.hostPermissions, app.url), app.url).toBe(true)
    }
  })

  it('两种语言的 l10n 都在,且贡献点引用的 key 真的存在', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ncw-bilibili-'))
    roots.push(root)

    const installed = await installPluginDirectory(EXAMPLE, root)
    expect(existsSync(join(installed.target, 'l10n/zh-CN.json'))).toBe(true)
    expect(existsSync(join(installed.target, 'l10n/en-US.json'))).toBe(true)

    const zh = JSON.parse(await fs.readFile(join(installed.target, 'l10n/zh-CN.json'), 'utf8')) as Record<string, string>
    const en = JSON.parse(await fs.readFile(join(installed.target, 'l10n/en-US.json'), 'utf8')) as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const app of installed.manifest.contributes.webApps) {
      // `%app.home%` → `app.home`
      expect(zh[app.title.slice(1, -1)], app.title).toBeDefined()
    }
  })
})
