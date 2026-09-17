#!/usr/bin/env node
/**
 * 构建 + 打包。
 *
 * ## 两个产物,两套规则
 *
 * | 产物 | 形态 | `nextcowork` |
 * |---|---|---|
 * | `dist/extension.js` | 单文件 ESM,跑在插件宿主窗口 | **external**(宿主经 import map 注入) |
 * | `dist/view/main.js` | 单文件 ESM,跑在主窗口的 iframe | 用不到它 —— 画布只和宿主 postMessage |
 *
 * ★ 视图那一份**必须把 React 与 Excalidraw 全打进去**。`ncw-plugin://` 的 CSP
 * 里 `connect-src` 不给外网,`script-src` 只给 `'self'` —— 从 CDN 取一个字节都不行。
 *
 * ## 字体为什么要复制而不是打包
 *
 * Excalidraw 的字体是 209 个按需加载的 woff2 子集,运行期用
 * `window.EXCALIDRAW_ASSET_PATH` 拼 URL 去取。打进 JS 是不可能的(二进制),
 * 所以原样复制进包,并把那个全局指向包内 —— 于是取字体走的是
 * `ncw-plugin://` 协议,仍然不出网。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
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

// ─────────────────── 2. 画布视图 ───────────────────

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
  /*
    ★ Excalidraw 的 `exports` 里,`.` 与 `./index.css` 都只给了
    `development` / `production` 两个条件(CSS 那条连 `default` 都没有)。
    不指定条件 esbuild 解析不到 CSS,报的是「Could not resolve」——
    而那条信息完全不提「你缺一个 condition」。
  */
  conditions: ['production'],
  loader: { '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
  define: {
    'process.env.NODE_ENV': '"production"',
    // Excalidraw 读它决定去哪儿取字体。指向包内,于是走 ncw-plugin:// 协议。
    'window.EXCALIDRAW_ASSET_PATH': '"./"'
  }
})

cpSync(join(here, 'view/index.html'), join(dist, 'view/index.html'))

// ─────────────────── 3. 字体与运行期资源 ───────────────────

/*
  从已安装的 @excalidraw/excalidraw 里取 prod 产物的 fonts 目录。

  ★ 不能 `require.resolve('@excalidraw/excalidraw/package.json')` —— 它的
  `exports` 里没有 `./package.json` 这一条,Node 会直接拒绝(ERR_PACKAGE_PATH_NOT_EXPORTED)。
  解析主入口再往上走一层是**不依赖 exports 细节**的那条路。
*/
const excalidrawEntry = require.resolve('@excalidraw/excalidraw', { paths: [here] })
const excalidrawDist = dirname(excalidrawEntry)
if (!existsSync(join(excalidrawDist, 'fonts'))) {
  console.error(`✗ 找不到 Excalidraw 的 fonts 目录(看的是 ${excalidrawDist}),先 npm install`)
  process.exit(1)
}
cpSync(join(excalidrawDist, 'fonts'), join(dist, 'view/fonts'), { recursive: true })

console.log('✓ dist/')

// ─────────────────── 4. 打包 ───────────────────

if (process.argv.includes('--package')) {
  const zipName = `${id}-${pkg.version}.zip`
  const staging = join(here, '.ncw-package')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, id), { recursive: true })

  // ★ 顶层目录必须是 `<publisher>.<name>` —— 服务端与客户端校验的第一条。
  for (const entry of ['package.json', 'dist', 'l10n']) {
    cpSync(join(here, entry), join(staging, id, entry), { recursive: true })
  }
  // 包里那份清单不该带开发依赖与脚本:它们对装的人没有意义,只会让审核多读两屏。
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