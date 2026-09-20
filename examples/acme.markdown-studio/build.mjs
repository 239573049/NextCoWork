#!/usr/bin/env node
/**
 * 构建 + 打包(结构照抄 `../acme.excalidraw/build.mjs`;视图产物从单文件
 * 改为 esbuild 代码分割的多 chunk —— 理由见第 2 段)。
 *
 * | 产物 | 形态 | `nextcowork` |
 * |---|---|---|
 * | `dist/extension.js` | 单文件 ESM,跑在插件宿主窗口 | **external**(宿主经 import map 注入) |
 * | `dist/view/**` | 入口 + chunk 们,跑在主窗口的 iframe | **全量打包**,CSP 不给出网一个字节 |
 *
 * ## 视图为什么要 code splitting
 *
 * `@codemirror/language-data` 对 ~85 种语言做动态 `import()`,mermaid 也是
 * 按需加载。不打分割会得到两种坏结果之一:全部内联进一个 ~4MB 的 main.js
 * (打开 .md 首屏就要解析它),或保留动态 import 但没有对应 chunk(运行期
 * 加载失败,表现为「代码块永远没有高亮且零报错」)。分割后:首屏只有入口
 * 与 markdown 语法,别的语言和 mermaid 在第一次用到时才取 —— 相对路径的
 * chunk 经 `ncw-plugin://` 协议照常可取。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// ─────────────────── 2. 编辑器视图(分割) ───────────────────

await esbuild.build({
  entryPoints: [join(here, 'view/main.tsx')],
  outdir: join(dist, 'view'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  // KaTeX 的 woff/woff2 字体内联成 dataurl:CSP `font-src 'self' data:` 收,
  // 出包为文件再相对引用也行,但 dataurl 免去 katex/dist/fonts 整目录复制。
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }
})

cpSync(join(here, 'view/index.html'), join(dist, 'view/index.html'))
const viewDir = join(dist, 'view')
const viewEntries = readdirSync(viewDir, { withFileTypes: true }).filter((entry) => entry.isFile())
const totalKiB = viewEntries.reduce((sum, entry) => sum + statSync(join(viewDir, entry.name)).size, 0) / 1024
console.log(`✓ dist/view (${viewEntries.length} files, ${(totalKiB / 1024).toFixed(1)} MiB)`)

// ─────────────────── 3. 打包 ───────────────────

if (process.argv.includes('--package')) {
  const zipName = `${id}-${pkg.version}.zip`
  const staging = join(here, '.ncw-package')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, id), { recursive: true })

  // ★ 顶层目录必须是 `<publisher>.<name>`。views 的 path 指向 dist/view/,
  //   分割出的 chunk 也在里面 —— 打包按目录复制,天然带上,不需要逐个点名。
  for (const entry of ['package.json', 'dist', 'l10n', 'assets']) {
    if (!existsSync(join(here, entry))) continue
    cpSync(join(here, entry), join(staging, id, entry), { recursive: true })
  }
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
