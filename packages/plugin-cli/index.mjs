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
import { basename, join, resolve } from 'node:path'

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

  if (!watch) {
    await esbuild.build(options)
    console.log(`✓ ${outfile}`)
    return
  }
  const ctx = await esbuild.context(options)
  await ctx.watch()
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

  const listing = await json(`/api/plugins/mine`, token)
  const mine = (listing.items ?? []).find((item) => item.pluginId === `${pkg.publisher}.${pkg.name}`)
  const id = mine?.id ?? (await postJson('/api/plugins', { publisher: pkg.publisher, name: pkg.name, displayName: pkg.displayName, description: pkg.description, category: pkg.categories?.[0] }, token)).id
  const version = await post(`/api/plugins/${id}/versions`, bytes, zipName, token)
  if (!version.ok) fail(`上传失败:${version.message}`)
  if (version.data.permissionEscalated) {
    // ★ 作者应该知道这一版会被标红:它要的必选能力比上一个已发布版本多。
    console.log('⚠ 这一版新增了必选能力,审核会标红,用户升级时需要重新批准')
  }
  await postJson(`/api/plugins/${id}/submit`, {}, token)
  console.log(`✓ 已提交审核 ${zipName}`)
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

async function post(path, bytes, fileName, token) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/zip' }), fileName)
  const response = await fetch(new URL(path, apiOrigin), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, data: body.data ?? body, message: body.message ?? `HTTP ${response.status}` }
}

async function postJson(path, payload, token) {
  const response = await fetch(new URL(path, apiOrigin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) fail(body.message ?? `HTTP ${response.status}`)
  return body.data ?? body
}

async function json(path, token) {
  const response = await fetch(new URL(path, apiOrigin), { headers: { Authorization: `Bearer ${token}` } })
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
