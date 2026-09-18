/**
 * `installPluginZip` 的路径大小写回归。
 *
 * ## 这条测试钉的是一个真实缺陷
 *
 * 安装器原来用**同一个小写集合**做两件事:查重(必须小写 —— 大小写不敏感的
 * 文件系统上 `A.js` 和 `a.js` 会互相覆盖)、以及回答「清单指的文件在不在包里」。
 * 后者用小写集合就永远查不到带大写的文件名。
 *
 * 而 l10n 的两个 bundle **必须**叫 `zh-CN.json` / `en-US.json` —— 带大写。
 * 于是任何一个带 l10n 的插件都会以「l10n bundle is required」被拒装,而包里明明有。
 *
 * 这个缺陷藏了很久,因为 `plugin-cli dev` 装的是**目录**,走 `collectFiles`
 * (原样大小写),完全不经过这条路。只有装 ZIP 时才炸 —— 也就是从市场装的时候。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginDirectory, installPluginZip } from '../installer'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ncw-zipcase-'))
  dirs.push(dir)
  return dir
}

const MANIFEST = {
  name: 'demo',
  publisher: 'acme',
  displayName: 'Demo',
  description: 'case sensitivity fixture',
  version: '1.0.0',
  engines: { nextcowork: '^0.1.0' },
  main: './dist/Extension.js',
  l10n: './l10n',
  activationEvents: ['onCommand:acme.demo.hi'],
  permissions: [],
  contributes: { commands: [{ command: 'acme.demo.hi', title: '%cmd.hi%' }] }
}

/** 用系统 `zip` 造一个包 —— 与作者真实的打包方式一致。 */
async function buildZip(): Promise<string> {
  const work = await scratch()
  const root = join(work, 'acme.demo')
  await fs.mkdir(join(root, 'dist'), { recursive: true })
  await fs.mkdir(join(root, 'l10n'), { recursive: true })
  await fs.writeFile(join(root, 'package.json'), JSON.stringify(MANIFEST))
  // ★ 带大写的入口文件名,和 l10n 的两个 bundle 一样会踩到那条路径
  await fs.writeFile(join(root, 'dist/Extension.js'), 'export function activate() {}')
  await fs.writeFile(join(root, 'l10n/zh-CN.json'), '{"cmd.hi":"你好"}')
  await fs.writeFile(join(root, 'l10n/en-US.json'), '{"cmd.hi":"Hi"}')

  const { spawnSync } = await import('node:child_process')
  const zipPath = join(work, 'acme.demo-1.0.0.zip')
  const result = spawnSync('zip', ['-qr', zipPath, 'acme.demo'], { cwd: work })
  if (result.status !== 0) throw new Error('zip failed')
  return zipPath
}

describe('installPluginZip 的路径大小写', () => {
  it('带大写的 l10n bundle 与入口文件照样认得出来', async () => {
    const zipPath = await buildZip()
    const root = await scratch()

    const installed = await installPluginZip(zipPath, root)

    expect(installed.manifest.id).toBe('acme.demo')
    // 真正落盘的也得是原样大小写,而不是被小写化过的名字
    const entries = await fs.readdir(join(installed.target, 'dist'))
    expect(entries).toContain('Extension.js')
    const bundles = await fs.readdir(join(installed.target, 'l10n'))
    expect(bundles).toEqual(expect.arrayContaining(['zh-CN.json', 'en-US.json']))
  })

  it('只有大小写不同的两个条目仍然算重复 —— 查重不能跟着一起放宽', async () => {
    const work = await scratch()
    const root = join(work, 'acme.demo')
    await fs.mkdir(join(root, 'dist'), { recursive: true })
    await fs.writeFile(join(root, 'package.json'), JSON.stringify({ ...MANIFEST, l10n: undefined }))
    await fs.writeFile(join(root, 'dist/Extension.js'), 'export function activate() {}')

    const { spawnSync } = await import('node:child_process')
    const zipPath = join(work, 'dup.zip')
    expect(spawnSync('zip', ['-qr', zipPath, 'acme.demo'], { cwd: work }).status).toBe(0)
    /*
      再塞一个只有大小写不同的同名条目。大小写不敏感的文件系统上它会覆盖前一个,
      所以安装器必须拒绝 —— 这一条是上面那个修复**不能**顺手放宽的边界。
    */
    await fs.writeFile(join(work, 'acme.demo/dist/extension.js'), 'export function activate() {}')
    expect(spawnSync('zip', ['-q', zipPath, 'acme.demo/dist/extension.js'], { cwd: work }).status).toBe(0)

    await expect(installPluginZip(zipPath, await scratch())).rejects.toThrow(/duplicate/i)
  })
})

describe('installPluginDirectory · 贡献点文件存在性', () => {
  it('★ cardViews 指向不存在的文件 → 拒装(和 views 同级的守卫)', async () => {
    const src = await fs.mkdtemp(join(tmpdir(), 'ncw-cardview-'))
    dirs.push(src)
    await fs.mkdir(join(src, 'dist'), { recursive: true })
    await fs.writeFile(join(src, 'dist/extension.js'), 'export function activate() {}')
    await fs.writeFile(
      join(src, 'package.json'),
      JSON.stringify({
        name: 'demo',
        publisher: 'acme',
        displayName: 'Demo',
        description: 'cardView fixture',
        version: '1.0.0',
        engines: { nextcowork: '^0.1.0' },
        main: './dist/extension.js',
        activationEvents: ['onTool:make_thing'],
        permissions: [],
        contributes: {
          tools: [{ name: 'make_thing', title: '%t%' }],
          cardViews: [{ viewType: 'task.card', path: './dist/card.html' }] // 文件不存在
        }
      })
    )
    await expect(installPluginDirectory(src, await scratch())).rejects.toThrow(/cardView.*missing/i)
  })
})