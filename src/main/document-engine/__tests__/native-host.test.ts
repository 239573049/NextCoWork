/**
 * 原生 helper 适配层 —— 用一个**真的子进程**(node 跑的假 helper,说同一套分帧协议)
 * 钉住握手、请求配对、错误码收窄、崩溃通知、环境白名单与收尾。
 *
 * 不起真 LibreOffice:那要插件携带的原生构建(计划 §12 A,尚未完成)。这里测的是
 * 宿主这一侧的协议与进程管理,任何一个真 helper 都必须满足同样的契约。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentSessionManager } from '../manager'
import { NativeDocumentEngineProvider, NativeHelperConnection, helperEnv, parseCapabilities } from '../native-host'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ncw-native-host-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 假 helper:MODE 环境不可用(白名单会过滤),所以行为由 argv 决定。 */
const FAKE_HELPER = String.raw`
const fs = require('node:fs')
const mode = process.argv[2] || 'ok'
const protocol = mode === 'badproto' ? 99 : 1
function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 0); header.writeUInt8(0, 4)
  process.stdout.write(Buffer.concat([header, payload]))
}
if (mode === 'silent') { setInterval(() => {}, 1000); return }
send({ v: 1, event: 'hello', data: { protocol, engineVersion: 'fake-lok-1' } })
let text = ''
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(0)
    if (buf.length < 5 + len) break
    const msg = JSON.parse(buf.subarray(5, 5 + len).toString('utf8'))
    buf = buf.subarray(5 + len)
    handle(msg)
  }
})
function handle(msg) {
  const { id, method, params } = msg
  if (method === 'document.open') {
    text = fs.readFileSync(params.path, 'utf8')
    return send({ v: 1, id, ok: true, result: { capabilities: { operations: ['text.replace', 'bogus.op'], canSave: true, canExport: ['pdf', 'exe'], macros: { list: true } } } })
  }
  if (method === 'document.apply') {
    if (mode === 'crash-on-apply') process.exit(3)
    if (params.operations[0].text === 'REJECT') return send({ v: 1, id, ok: false, error: { code: 'invalid_operation', message: 'ref not found' } })
    if (params.operations[0].text === 'WEIRD') return send({ v: 1, id, ok: false, error: { code: 'rm -rf', message: 'x' } })
    for (const op of params.operations) text += op.text
    return send({ v: 1, id, ok: true, result: { warnings: ['simplified'], undoable: true } })
  }
  if (method === 'document.saveAs') { fs.writeFileSync(params.path, text); return send({ v: 1, id, ok: true, result: {} }) }
  if (method === 'document.render') {
    const size = params.width * params.height * 4
    const binary = (bytes) => { const h = Buffer.alloc(5); h.writeUInt32BE(bytes.length, 0); h.writeUInt8(1, 4); process.stdout.write(Buffer.concat([h, bytes])) }
    const reply = { v: 1, id, ok: true, result: { width: params.width, height: params.height, format: 'rgba', attachment: true } }
    if (mode === 'render-missing') return send(reply)
    if (mode === 'render-short') { binary(Buffer.alloc(size - 4, 9)); return send(reply) }
    if (mode === 'render-double') { binary(Buffer.alloc(size, 9)); binary(Buffer.alloc(size, 9)); return send(reply) }
    binary(Buffer.alloc(size, 9))
    return send(reply)
  }
  if (method === 'env') return send({ v: 1, id, ok: true, result: Object.keys(process.env) })
  if (method === 'shutdown') { send({ v: 1, id, ok: true, result: {} }); process.exit(0) }
}
`

function helperScript(): string {
  const path = join(root, 'fake-helper.cjs')
  writeFileSync(path, FAKE_HELPER)
  return path
}

function provider(mode = 'ok'): NativeDocumentEngineProvider {
  const script = helperScript()
  return new NativeDocumentEngineProvider({
    id: 'ncw.office-runtime/office',
    formats: ['docx'],
    resolveEntry: async () => process.execPath,
    args: [script, mode],
    workRoot: join(root, 'helpers'),
    startupTimeoutMs: 5000
  })
}

const SCOPE = { accountScope: 'a', workspaceId: 'w' }

describe('NativeHelperConnection', () => {
  it('rejects a helper that never says hello within the startup timeout', async () => {
    await expect(NativeHelperConnection.start({ command: process.execPath, args: [helperScript(), 'silent'], workDir: join(root, 'h1'), startupTimeoutMs: 300 }))
      .rejects.toMatchObject({ code: 'engine_unavailable' })
  })

  it('rejects a helper speaking another protocol version', async () => {
    await expect(NativeHelperConnection.start({ command: process.execPath, args: [helperScript(), 'badproto'], workDir: join(root, 'h2') }))
      .rejects.toThrow(/protocol 99/)
  })

  it('gives the helper only whitelisted environment variables and private HOME/TMP', async () => {
    process.env.NCW_SECRET_TOKEN_FOR_TEST = 'leak'
    try {
      const workDir = join(root, 'h3')
      const connection = await NativeHelperConnection.start({ command: process.execPath, args: [helperScript()], workDir })
      const keys = await connection.request('env', {}) as string[]
      expect(keys).not.toContain('NCW_SECRET_TOKEN_FOR_TEST')
      expect(keys).toContain('HOME')
      expect(helperEnv(workDir).HOME).toBe(join(workDir, 'home'))
      // 随包运行时装好后不能被 Python 字节码缓存改写(索引与 macOS 签名都依赖它不变)
      expect(helperEnv(workDir).PYTHONDONTWRITEBYTECODE).toBe('1')
      await connection.close()
      expect(existsSync(workDir)).toBe(false)
    } finally {
      delete process.env.NCW_SECRET_TOKEN_FOR_TEST
    }
  })
})

describe('NativeDocumentEngineProvider through the session manager', () => {
  it('opens, applies, saves through a real helper process and filters unknown capabilities', async () => {
    const file = join(root, 'a.docx')
    writeFileSync(file, 'hello')
    const manager = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 5000 })
    manager.registerProvider(provider())
    const { snapshot, capabilities, viewId } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: 'ncw.office-runtime/office' })
    expect(capabilities).toMatchObject({ engineVersion: 'fake-lok-1', operations: ['text.replace'], canExport: ['pdf'], macros: { list: true, run: false } })
    const applied = await manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'o1', generation: 1, modelRevision: 0, operations: [{ kind: 'text.replace', target: { generation: 1, ref: 'p' }, text: ' world' }] })
    expect(applied).toMatchObject({ warnings: ['simplified'], undoable: true })
    await manager.save({ sessionId: snapshot.sessionId, scope: SCOPE })
    expect((await import('node:fs')).readFileSync(file, 'utf8')).toBe('hello world')
    await manager.release({ sessionId: snapshot.sessionId, scope: SCOPE, viewId })
  })

  it('maps explicit engine rejections to rejected operations and unknown codes to io', async () => {
    const file = join(root, 'b.docx')
    writeFileSync(file, 'x')
    const manager = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 5000 })
    manager.registerProvider(provider())
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: 'ncw.office-runtime/office' })
    const op = (text: string): unknown[] => [{ kind: 'text.replace', target: { generation: 1, ref: 'p' }, text }]
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'r', generation: 1, modelRevision: 0, operations: op('REJECT') })).rejects.toMatchObject({ code: 'invalid_operation' })
    expect(manager.getOperation('r')?.status).toBe('rejected')
    expect(manager.snapshot(snapshot.sessionId, SCOPE).status).toBe('ready')
    // 未知错误码不可信 → io → 管理器按结果未知处理
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'w', generation: 1, modelRevision: 0, operations: op('WEIRD') })).rejects.toMatchObject({ code: 'result_unknown' })
    await manager.closeAll()
  })

  it('reports result_unknown and a crashed session when the helper dies mid-apply', async () => {
    const file = join(root, 'c.docx')
    writeFileSync(file, 'x')
    const manager = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 5000 })
    manager.registerProvider(provider('crash-on-apply'))
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: 'ncw.office-runtime/office' })
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'k', generation: 1, modelRevision: 0, operations: [{ kind: 'text.replace', target: { generation: 1, ref: 'p' }, text: 'y' }] }))
      .rejects.toMatchObject({ code: 'result_unknown' })
    expect(manager.snapshot(snapshot.sessionId, SCOPE).status).toBe('crashed')
    await manager.closeAll()
  })
})

describe('rendering through a real helper process', () => {
  const RENDER = { x: 0, y: 0, tileWidth: 100, tileHeight: 100, width: 3, height: 2 }

  async function openWith(mode: string): Promise<{ manager: DocumentSessionManager; sessionId: string }> {
    const file = join(root, `render-${mode}.docx`)
    writeFileSync(file, 'x')
    const manager = new DocumentSessionManager({ privateDir: join(root, `private-${mode}`), timeoutMs: 5000 })
    manager.registerProvider(provider(mode))
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: 'ncw.office-runtime/office' })
    return { manager, sessionId: snapshot.sessionId }
  }

  it('pairs the binary frame with its response and returns straight RGBA of the requested size', async () => {
    const { manager, sessionId } = await openWith('ok')
    const image = await manager.render({ sessionId, scope: SCOPE, request: RENDER })
    expect(image).toMatchObject({ width: 3, height: 2, format: 'rgba', generation: 1, modelRevision: 0 })
    expect(image.bytes.byteLength).toBe(24)
    expect(image.bytes[0]).toBe(9)
    // 附件配对之后通道仍正常:接着查一次状态
    expect(manager.snapshot(sessionId, SCOPE).status).toBe('ready')
    await manager.closeAll()
  })

  it('rejects oversized renders before they reach the engine', async () => {
    const { manager, sessionId } = await openWith('ok')
    await expect(manager.render({ sessionId, scope: SCOPE, request: { ...RENDER, width: 4096 } })).rejects.toMatchObject({ code: 'invalid_operation' })
    expect(manager.snapshot(sessionId, SCOPE).status).toBe('ready')
    await manager.closeAll()
  })

  it('treats a missing or short attachment as an engine fault', async () => {
    for (const mode of ['render-missing', 'render-short']) {
      const { manager, sessionId } = await openWith(mode)
      await expect(manager.render({ sessionId, scope: SCOPE, request: RENDER })).rejects.toMatchObject({ code: 'io' })
      expect(manager.snapshot(sessionId, SCOPE).status).toBe('crashed')
      await manager.closeAll()
    }
  })

  it('★ kills a helper that sends two attachments for one response rather than mispairing them', async () => {
    const { manager, sessionId } = await openWith('render-double')
    await expect(manager.render({ sessionId, scope: SCOPE, request: RENDER })).rejects.toBeDefined()
    expect(manager.snapshot(sessionId, SCOPE).status).toBe('crashed')
    await manager.closeAll()
  })
})

describe('parseCapabilities', () => {
  it('pins the format to the opened file and drops unknown fields', () => {
    expect(parseCapabilities({ capabilities: { format: 'pdf', operations: ['x', 'cells.set'] } }, 'xlsx', 'v')).toEqual({
      format: 'xlsx', engineVersion: 'v', operations: ['cells.set'], canSave: false, canExport: [], canUndo: false, macros: { list: false, run: false }
    })
    expect(parseCapabilities(null, 'docx', '').operations).toEqual([])
  })
})
