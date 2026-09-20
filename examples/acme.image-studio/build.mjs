#!/usr/bin/env node
/**
 * 构建 + 打包(结构照抄 `../acme.excalidraw/build.mjs`,去掉了它特有的字体段)。
 *
 * ## 两个产物,两套规则
 *
 * | 产物 | 形态 | `nextcowork` |
 * |---|---|---|
 * | `dist/extension.js` | 单文件 ESM,跑在插件宿主窗口 | **external**(宿主经 import map 注入) |
 * | `dist/view/main.js` | 单文件 ESM,跑在主窗口的 iframe | **全量打包** —— `ncw-plugin://` 的 CSP `script-src` 只给 `'self'`,从 CDN 取一个字节都不行 |
 *
 * 需求:宿主 >= 0.2.0 才有文档通道的图片支线(dataUrl 下发 + base64 存回),
 * 清单的 `engines` 也写了同一条下限 —— 两处必须一起动,否则老宿主上装得
 * 进去、打开图片却是白屏。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const id = `${pkg.publisher}.${pkg.name}`

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'view'), { recursive: true })

// ─────────────────── 1. 逻辑侧 ───────────────────

await esbuild.build({
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(dist, 'extension.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // ★ 宿主注入的那份实现才是真的。打一份进来会让每个 API 调用都返回 undefined。
  external: ['nextcowork'],
  minify: true,
  logLevel: 'info'
})

// ─────────────────── 2. 编辑器视图 ───────────────────

await esbuild.build({
  entryPoints: [join(here, 'view/main.tsx')],
  outfile: join(dist, 'view/main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
})

cpSync(join(here, 'view/index.html'), join(dist, 'view/index.html'))

console.log('✓ dist/')

// ─────────────────── 3. 打包 ───────────────────

if (process.argv.includes('--package')) {
  const zipName = `${id}-${pkg.version}.zip`
  const staging = join(here, '.ncw-package')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, id), { recursive: true })

  // ★ 顶层目录必须是 `<publisher>.<name>`;`assets` 必须在:清单的 `icon`
  //   指向它,安装器会核对那个文件真的在包里。
  for (const entry of ['package.json', 'dist', 'l10n', 'assets']) {
    if (!existsSync(join(here, entry))) continue
    cpSync(join(here, entry), join(staging, id, entry), { recursive: true })
  }
  // 包里那份清单不该带开发依赖与脚本:对装的人没有意义,只会让审核多读两屏。
  const shipped = { ...pkg }
  delete shipped.devDependencies
  delete shipped.scripts
  delete shipped.source
  writeFileSync(join(staging, id, 'package.json'), JSON.stringify(shipped, null, 2))

  rmSync(join(here, zipName), { force: true })
  const zip = spawnSync('zip', ['-qr', join(here, zipName), id], { cwd: staging, stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })
  if (zip.status !== 0) process.exit(zip.status ?? 1)
  console.log(`✓ ${zipName}`)
}
