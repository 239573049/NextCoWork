#!/usr/bin/env node
/**
 * 把设备服务的构建产物打成**可独立部署**的包:`out/agent-package/` + `out/aidotnet-nextcowork-device-service-<version>.tgz`
 * (清单里的名字是 npm 上的 `@aidotnet/nextcowork-device-service`,装完即有 `ncw-device-service` 命令)。
 *
 * `build:agent` 的产物里依赖是外部 import(原生模块不打进包),所以单独拷贝 bin.mjs 在没有仓库的机器上跑不起来。
 * 这里生成一份**只含服务实际引用的运行时依赖**的 package.json(版本取自仓库 package.json,不是猜的),
 * 部署方在包目录里 `npm install --omit=dev` 即可,不需要 Electron、不需要仓库源码。
 *
 * 用法:
 *   npm run package:agent            先要有 out/agent/bin.mjs(`npm run build:agent`)
 *   npm run package:agent -- --verify  另外在临时目录真实安装依赖并启动一次服务,确认它真能在仓库之外跑起来
 *
 * 不发布、不上传:产物只落在 out/(已在 .gitignore)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const agentDir = join(root, 'out', 'agent')
const packageDir = join(root, 'out', 'agent-package')

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * 产物里的裸说明符(非 node: 内建、非相对路径),归一到包名。只认真正的 import/export/require 语句:
 * 静态 import 必须在语句开头,所以字符串里的 `from "sat"` 这类文字、`https://…` 都不算。
 */
export function bareSpecifiers(code) {
  const found = new Set()
  const patterns = [
    /(?:^|[;}\n])\s*(?:import|export)(?=[\s{*])[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|[;}\n])\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const spec = match[1]
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue
      const parts = spec.split('/')
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      if (NPM_NAME.test(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * 产物实际引用了哪些 `dependencies` 里的包。导出以便单元测试。
 */
export function runtimeDependencies(code, dependencies) {
  const imported = new Set(bareSpecifiers(code))
  return Object.fromEntries(Object.entries(dependencies).filter(([name]) => imported.has(name)).sort(([a], [b]) => a.localeCompare(b)))
}

export function buildPackageJson(pkg, code) {
  const dependencies = runtimeDependencies(code, pkg.dependencies ?? {})
  const declared = new Set(Object.keys(pkg.dependencies ?? {}))
  // 裸说明符里既不是依赖、也不是产物自带的,说明包会在目标机上缺模块 —— 打包就该失败,而不是发出去才发现。
  const missing = bareSpecifiers(code).filter((name) => !declared.has(name))
  return {
    manifest: {
      // 发布到 npm 的 aidotnet 作用域下(与 GitHub 上的 AIDotNet 同一个归属),`npm i -g` 装得到;
      // 作用域包首发必须显式 `--access public`(npm 默认按私有算,会被拒)。
      name: '@aidotnet/nextcowork-device-service',
      version: pkg.version,
      description: 'NextCoWork standalone device service (no Electron)',
      type: 'module',
      main: 'bin.mjs',
      // 命令名与 bin.ts 里的用法一致:`ncw-device-service --data-dir <d>`(或 service/diagnose/takeover 子命令)。
      bin: { 'ncw-device-service': 'bin.mjs' },
      engines: { node: '>=24' },
      files: ['bin.mjs', 'bin.mjs.map', 'RUNTIME.json'],
      dependencies
    },
    missing
  }
}

/**
 * `npm pack --json` 的产物文件名。npm ≥ 12 输出的是**按包名索引的对象**,npm ≤ 11 是数组 —— 两种都认,
 * 认不出来就当失败(报出原文),而不是让 `.filename` 抛一个看不出所以然的 TypeError。
 */
export function packedFilename(stdout) {
  const parsed = JSON.parse(stdout)
  const first = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (typeof first?.filename !== 'string') throw new Error(`npm pack produced no filename:\n${stdout}`)
  return first.filename
}

function main() {
  const entry = join(agentDir, 'bin.mjs')
  if (!existsSync(entry)) throw new Error('out/agent/bin.mjs not found; run `npm run build:agent` first')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const code = readFileSync(entry, 'utf8')
  const { manifest, missing } = buildPackageJson(pkg, code)
  if (missing.length > 0) throw new Error(`bundle imports packages that package.json does not declare: ${missing.join(', ')}`)

  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(packageDir, { recursive: true })
  for (const file of readdirSync(agentDir)) copyFileSync(join(agentDir, file), join(packageDir, file))
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const packed = spawnSync('npm', ['pack', '--pack-destination', join(root, 'out'), '--json'], { cwd: packageDir, encoding: 'utf8', shell: process.platform === 'win32' })
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)
  const tarball = packedFilename(packed.stdout)
  console.log(`device service package ready: ${join(root, 'out', tarball)} (${Object.keys(manifest.dependencies).length} runtime dependencies)`)
  return { tarball: join(root, 'out', tarball) }
}

/** 在仓库之外装依赖并真实启动一次:证明包是自洽的,不是「在仓库里碰巧能跑」。 */
async function verify(tarball) {
  const work = mkdtempSync(join(tmpdir(), 'ncw-agent-verify-'))
  let child = null
  try {
    const shell = process.platform === 'win32'
    /*
      `npm run` 会把用户 .npmrc 里的配置导出成 `npm_config_*` 交给脚本。用户 npmrc 里若写了
      `allow-scripts=…`(npm ≥ 12 的常见配置),嵌套的 npm 会把它当成命令行上的 `--allow-scripts`,
      而项目级安装里那个标志是**直接报错**的:与被装的包无关,却会让 verify 永远跑不通。
      只摘这一个变量:registry / 镜像等其它配置(本机与镜像站都靠它们)照旧继承。
    */
    const env = { ...process.env }
    delete env.npm_config_allow_scripts
    const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', work, tarball], { encoding: 'utf8', shell, env })
    if (install.status !== 0) throw new Error(`install failed:\n${install.stderr}`)
    const entry = join(work, 'node_modules', '@aidotnet', 'nextcowork-device-service', 'bin.mjs')
    child = spawn(process.execPath, [entry, '--data-dir', join(work, 'data')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const deadline = Date.now() + 30_000
    while (!/listening on 127\.0\.0\.1:\d+/.test(output)) {
      if (child.exitCode !== null) throw new Error(`service exited early (${child.exitCode}):\n${output}`)
      if (Date.now() > deadline) throw new Error(`service did not start in time:\n${output}`)
      await sleep(100)
    }
    console.log('verified: the packaged service installs and starts outside the repository')
  } finally {
    child?.kill('SIGKILL')
    await sleep(200)
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { tarball } = main()
    if (process.argv.includes('--verify')) await verify(tarball)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
