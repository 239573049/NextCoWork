#!/usr/bin/env node
/**
 * 构建。**这个包没有任何 npm 依赖** —— 连 react 都不装,所以不需要先
 * `npm install`(esbuild 从仓库根拿)。
 *
 * 这正是「宿主下发运行时」的好处:插件的 `node_modules` 从几百兆变成零。
 *
 * | 产物 | external |
 * |---|---|
 * | `dist/extension.js` | `nextcowork`(逻辑侧的 API,由宿主 import map 注入) |
 * | `dist/view/editor.js` | react 系 + `nextcowork/ui` + `nextcowork/view` |
 *
 * ★ 视图那几个名字**必须**标 external。打进去的症状分两种,都不好查:
 * 自带 React → "Invalid hook call"(报错指向你自己的组件);
 * 自带 `nextcowork/view` → 代码跑得通,但它和宿主之间那条 postMessage 通道
 * 永远没人接,编辑器打开后一片空白且零报错。
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
// 仓库根的 esbuild —— 示例不该为了构建自己而引一份依赖
const esbuild = createRequire(join(here, '../../package.json'))('esbuild')

const VIEW_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'nextcowork/ui',
  'nextcowork/view'
]

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, 'view'), { recursive: true })

await esbuild.build({
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(dist, 'extension.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['nextcowork'],
  minify: true,
  logLevel: 'info'
})

await esbuild.build({
  entryPoints: [join(here, 'view/editor.tsx')],
  outfile: join(dist, 'view/editor.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: VIEW_EXTERNALS,
  minify: true,
  logLevel: 'info'
})

// HTML 原样拷过去 —— 它不需要构建,注入在下发时发生
cpSync(join(here, 'view/editor.html'), join(dist, 'view/editor.html'))

console.log('✓ dist/')
