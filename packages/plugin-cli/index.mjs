#!/usr/bin/env node
/**
 * `@aidotnet/plugin-cli` —— build / package / publish / dev。
 *
 * ## 这个 CLI 只做四件事,每一件都对应一次「作者自己做会做错」的操作
 *
 * | 命令 | 替作者挡住的错误 |
 * |---|---|
 * | `build`   | 忘了把 `nextcowork` 标 external → 打进一份假的 API 实现,运行期全是 undefined |
 * | `package` | ZIP 顶层目录不是 `<publisher>.<name>` → 上传被拒,而错误信息只说「顶层目录不对」 |
 * | `publish` | 先上传再提交、两步顺序搞反 → 版本卡在 draft,作者以为提交过了 |
 * | `dev`     | 改一行要手工重打包重装 → 没人会这么调试,于是没人写插件 |
 *
 * ## 它**不替作者校验清单**
 *
 * 校验在两处已经有了:客户端装载时(`shared/plugin/manifest.ts`)和服务端上传时
 * (`PluginEndpoints.InspectPackage`)。这里再写第三份,三份一定会分叉 ——
 * 而分叉的症状是「本地 cli 说没问题,传上去被拒」,那是最消耗作者耐心的一种。
 * 这里只调用服务端的 `/api/plugins/validate`。
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const HELP = `nextcowork-plugin <command>

  build                编译 src/extension.ts → dist/extension.js(nextcowork 标 external)
  package              打成 <publisher>.<name>-<version>.zip
  publish [--token T]  校验 → 上传版本 → 提交审核
  dev                  监听 src/,改一行就重新构建并重装到本机

  --dir <path>         插件目录,默认当前目录
  --api  <origin>      市场地址,默认 https://nextco.work
`

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const dir = resolve(flag('dir', process.cwd()))
const apiOrigin = flag('api', process.env.NEXTCOWORK_MARKET_ORIGIN ?? 'https://nextco.work')

async function manifest() {
  const raw = await readFile(join(dir, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw)
  if (typeof parsed.publisher !== 'string' || typeof parsed.name !== 'string') {
    fail('package.json 缺少 publisher 或 name')
  }
  return parsed
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * 视图(iframe 里那一侧)要标成 external 的模块名。
 *
 * ★ 这几个由**宿主**经 import map 下发,打进 bundle 会得到第二份实例 ——
 * 而两份 React 的症状是 "Invalid hook call",报错位置指向插件自己的组件,
 * 几乎不可能从现象反推到「我把 React 打进去了」。
 * `nextcowork/view` 打进去则更隐蔽:代码跑得通,但它和宿主之间那条
 * postMessage 通道永远不会有人接 —— 编辑器打开后一片空白,零报错。
 */
const VIEW_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'nextcowork/ui',
  'nextcowork/view'
]

/**
 * ★ `nextcowork` 必须标 **external**。
 *
 * 不标的话 esbuild 会去 node_modules 里找一个同名包 —— 找不到就报错(还算好),
 * 找到了(比如作者装了 `@aidotnet/plugin-api` 又建了个 shim)就会把一份
 * **假的实现**打进 bundle,而运行期宿主注入的那份真实现根本不会被用到。
 * 症状是每个 API 调用都返回 undefined,而且没有任何错误。
 */
async function build({ watch = false } = {}) {
  const pkg = await manifest()
  const entry = pkg.source ?? 'src/extension.ts'
  const outfile = pkg.main ?? './dist/extension.js'
  let esbuild
  try { esbuild = require('esbuild') } catch { fail('需要 esbuild:npm i -D esbuild') }

  const options = {
    entryPoints: [join(dir, entry)],
    outfile: join(dir, outfile),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // ★ 见上面那段。
    external: ['nextcowork'],
    sourcemap: false,
    minify: !watch,
    logLevel: 'info'
  }

  /*
    视图入口。清单里写了 `views` 字段才编 —— 它是**可选**的:
    绝大多数插件只有逻辑侧,给它们多跑一次 esbuild 只是白等。

    ```jsonc
    // package.json
    "views": { "src/view/editor.tsx": "dist/view/editor.js" }
    ```

    ★ 开 `splitting`:视图动辄引 CodeMirror / mermaid 这种按需加载的东西,
    不分割会得到两种坏结果之一 —— 全部内联进一个几 MB 的入口(首屏就要解析它),
    或者保留了动态 import 却没有对应 chunk(运行期加载失败,表现为
    「某个功能永远不生效且零报错」)。
  */
  const views = pkg.views ?? {}
  const viewEntries = Object.keys(views)
  const viewOptions = viewEntries.length === 0 ? null : {
    entryPoints: viewEntries.map((from) => ({ in: join(dir, from), out: basename(views[from]).replace(/\.js$/, '') })),
    outdir: join(dir, dirname(views[viewEntries[0]])),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: true,
    jsx: 'automatic',
    external: VIEW_EXTERNALS,
    sourcemap: false,
    minify: !watch,
    logLevel: 'info'
  }

  if (!watch) {
    await esbuild.build(options)
    console.log(`✓ ${outfile}`)
    if (viewOptions !== null) {
      await esbuild.build(viewOptions)
      console.log(`✓ ${viewEntries.length} 个视图入口 → ${dirname(views[viewEntries[0]])}/`)
    }
    return
  }
  const ctx = await esbuild.context(options)
  await ctx.watch()
  if (viewOptions !== null) {
    const viewCtx = await esbuild.context(viewOptions)
    await viewCtx.watch()
  }
  console.log('… watching src/')
}

async function pack() {
  const pkg = await manifest()
  const id = `${pkg.publisher}.${pkg.name}`
  const zipName = `${id}-${pkg.version}.zip`
  /*
    ★ 用系统 `zip` 而不是引一个 JS 压缩库:这个 CLI 的依赖越少,
    「装不上 cli」这件事就越不可能挡住一个想写插件的人。
    顶层目录必须是 `<publisher>.<name>` —— 服务端校验的第一条就是它。
  */
  const staging = join(dir, '.ncw-package')
  await run('rm', ['-rf', staging])
  await run('mkdir', ['-p', join(staging, id)])
  for (const entry of ['package.json', 'dist', 'l10n', 'assets', 'skills', 'themes']) {
    await run('sh', ['-c', `[ -e "${join(dir, entry)}" ] && cp -R "${join(dir, entry)}" "${join(staging, id)}/" || true`])
  }
  await run('sh', ['-c', `cd "${staging}" && zip -q -r "${join(dir, zipName)}" "${id}"`])
  await run('rm', ['-rf', staging])
  const info = await stat(join(dir, zipName))
  const sha = createHash('sha256').update(await readFile(join(dir, zipName))).digest('hex')
  console.log(`✓ ${zipName}  ${(info.size / 1024).toFixed(1)} KB  sha256=${sha.slice(0, 16)}…`)
  return { zipName, id }
}

async function publish() {
  const token = flag('token', process.env.NEXTCOWORK_TOKEN)
  if (!token) fail('需要 --token 或 NEXTCOWORK_TOKEN')
  const pkg = await manifest()
  const { zipName } = await pack()
  const bytes = await readFile(join(dir, zipName))

  /*
    ★ 先 validate 再上传。两步分开是**为了让失败早一步发生**:
    校验不过时作者收到的是一条具体的原因(「l10n 必须同时提供 en-US.json」),
    而不是一个已经落了盘、状态卡在 draft 的版本。
  */
  const validate = await post('/api/plugins/validate', bytes, zipName, token)
  if (!validate.ok) fail(`校验未通过:${validate.message}`)
  console.log(`✓ 校验通过 ${validate.data.pluginId}@${validate.data.version}`)

  const id = await ensurePlugin(token, pkg)
  const version = await post(`/api/plugins/${id}/versions`, bytes, zipName, token)
  if (!version.ok) fail(`上传失败:${version.message}`)
  if (version.data.permissionEscalated) {
    // ★ 作者应该知道这一版会被标红:它要的必选能力比上一个已发布版本多。
    console.log('⚠ 这一版新增了必选能力,审核会标红,用户升级时需要重新批准')
  }
  await postJson(`/api/plugins/${id}/submit`, {}, token)
  console.log(`✓ 已提交审核 ${zipName}`)
}

/**
 * 插件在库里的**自增数字 id** —— 上传版本、提交审核的路径参数要的是它。
 *
 * ★★ 不是 `/api/plugins/mine` 里那个 UUID。列表每一项长这样:
 *
 * ```
 * { internalId: 2, plugin: { id: '<uuid>', pluginId: 'acme.excalidraw', … } }
 * ```
 *
 * 数字 id 挂在**外层**,`plugin` 那一层里只有 UUID —— 而路径上的 UUID
 * 换来的是 `404 接口不存在`,作者看不出这和「插件不存在」有什么区别:
 * 插件明明就在自己的列表里列着,`GET /api/plugins/mine` 也是 200。
 *
 * ★ 顺带一提 `pluginId` 也在里层,所以判「是我的插件吗」要读
 * `plugin.pluginId`,不是外层的 `pluginId`(那一读永远 undefined,
 * 于是每次 publish 都去新建一个已存在的插件)。
 *
 * 查不到返回 `null`:这个动作在「已经建过」和「刚建完」两条路上都要做。
 */
async function findInternalId(token, pluginId) {
  const listing = await json('/api/plugins/mine', token)
  const item = (listing.items ?? []).find((entry) => entry?.plugin?.pluginId === pluginId)
  return typeof item?.internalId === 'number' ? item.internalId : null
}

/**
 * 插件不在自己名下就先建,然后**回头再查一次列表**拿数字 id。
 *
 * ★ 不吃 `POST /api/plugins` 的返回值:那份 DTO 里带不带 `internalId`
 * 没有任何依据(见 `findInternalId` 记的那两层形状),而列表接口的
 * 形状是确定的 —— 与拿一个「大概有」的字段去拼路径相比,多一个往返
 * 换的是「路径必对」。
 */
async function ensurePlugin(token, pkg) {
  const pluginId = `${pkg.publisher}.${pkg.name}`
  const existing = await findInternalId(token, pluginId)
  if (existing !== null) return existing

  await postJson('/api/plugins', { publisher: pkg.publisher, name: pkg.name, displayName: pkg.displayName, description: pkg.description, category: pkg.categories?.[0] }, token)
  const created = await findInternalId(token, pluginId)
  if (created === null) fail(`插件已创建但列表里查不到 ${pluginId},请到市场网页确认它的归属`)
  return created
}

async function dev() {
  await build({ watch: true })
  console.log('提示:在 NextCoWork 的「扩展 › 插件」里用「安装插件」选择这个目录,改完重新点一次启用即可生效。')
}

function run(cmd, args) {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? done() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/**
 * ★ **写请求必须带 `Origin`。** 市场的网关对 POST 做同源校验:不带就一律
 * `403 请求来源无效` —— 这条错误既不说来源哪里不对、也不说该补哪个头,
 * 作者只会怀疑自己的 token 过期了,于是重新登录一遍,而 token 一直是对的。
 *
 * 值就用 `--api` 指向的那个 origin:指向本地市场时发的是本地 origin,
 * 与浏览器发的同源请求是同一个值。`Origin` 不带末尾斜杠。
 *
 * 读请求不校验(带上也无害),所以这里只留一份 header 构造 ——
 * 不给「哪几个调用要记得加」留出错的机会。
 */
function headers(token, jsonBody = false) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: new URL(apiOrigin).origin,
    ...(jsonBody ? { 'content-type': 'application/json' } : {})
  }
}

async function post(path, bytes, fileName, token) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/zip' }), fileName)
  const response = await fetch(new URL(path, apiOrigin), { method: 'POST', headers: headers(token), body: form })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, data: body.data ?? body, message: body.message ?? `HTTP ${response.status}` }
}

async function postJson(path, payload, token) {
  const response = await fetch(new URL(path, apiOrigin), {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(payload)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) fail(body.message ?? `HTTP ${response.status}`)
  return body.data ?? body
}

async function json(path, token) {
  const response = await fetch(new URL(path, apiOrigin), { headers: headers(token) })
  const body = await response.json().catch(() => ({}))
  return body.data ?? body
}

const commands = { build, package: pack, publish, dev }
const handler = commands[command]
if (!handler) {
  console.log(HELP)
  process.exit(command === undefined || command === '--help' ? 0 : 1)
}
handler().catch((error) => fail(error.message))

void basename
