import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bareSpecifiers, buildPackageJson, packedFilename, runtimeDependencies } from './package-agent.mjs'

const deps = { ws: '8.22.0', zod: '^4.5.4', 'node-pty': '^1.1.0', '@msgpack/msgpack': '3.1.3', unused: '1.0.0' }

test('keeps only the dependencies the bundle really imports, in every import spelling', () => {
  const code = 'import WebSocket from "ws";\nimport{z}from\'zod\';\nconst pty = await import("node-pty");\nimport { x } from "@msgpack/msgpack/dist/x.js";'
  assert.deepEqual(runtimeDependencies(code, deps), { '@msgpack/msgpack': '3.1.3', 'node-pty': '^1.1.0', ws: '8.22.0', zod: '^4.5.4' })
})

test('ignores the names of packages that only appear inside strings or comments', () => {
  const code = 'const url = "https://example.test/ws/zod"; // unused is mentioned\nconst label = "node-pty";'
  assert.deepEqual(runtimeDependencies(code, deps), {})
})

test('does not match a package whose name merely starts with a dependency name', () => {
  assert.deepEqual(runtimeDependencies('import x from "ws-extra";', deps), {})
})

test('lists bare specifiers but not builtins or relative imports', () => {
  const code = 'import a from "node:fs";\nimport b from "./x.js";\nimport c from "@scope/pkg/sub";\nimport d from "ws";'
  assert.deepEqual(bareSpecifiers(code), ['@scope/pkg', 'ws'])
})

test('fails the package when the bundle imports something package.json does not declare', () => {
  const result = buildPackageJson({ version: '1.2.3', dependencies: deps }, 'import a from "ws";\nimport b from "left-pad";')
  assert.deepEqual(result.missing, ['left-pad'])
})

test('produces a manifest that pins the Node floor and the repository versions', () => {
  const { manifest, missing } = buildPackageJson({ version: '1.2.3', dependencies: deps }, 'import a from "ws";\nimport "node:sqlite";')
  assert.deepEqual(missing, [])
  assert.equal(manifest.name, '@aidotnet/nextcowork-device-service')
  assert.equal(manifest.version, '1.2.3')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines.node, '>=24')
  // 装完得有命令可跑:只有 main 时用户还得自己拼 node_modules 里的路径。
  assert.deepEqual(manifest.bin, { 'ncw-device-service': 'bin.mjs' })
  assert.deepEqual(manifest.dependencies, { ws: '8.22.0' })
})

test('reads the tarball name from either `npm pack --json` shape', () => {
  const entry = { filename: 'aidotnet-nextcowork-device-service-1.2.3.tgz' }
  assert.equal(packedFilename(JSON.stringify([entry])), entry.filename) // npm ≤ 11
  assert.equal(packedFilename(JSON.stringify({ '@aidotnet/nextcowork-device-service': entry })), entry.filename) // npm ≥ 12
  assert.throws(() => packedFilename('{}'), /no filename/)
})
