import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentEngineError, type DocumentCapabilities, type DocumentOperation } from '../../../shared/document-engine/protocol'
import type { DocumentSessionSnapshot } from '../../../shared/document-engine/session'
import { commitSave, createWorkingCopy, digestFile } from '../file-store'
import { DocumentSessionManager, type DocumentEngineHandle, type DocumentEngineProvider } from '../manager'
import { FrameDecoder, FrameProtocolError, MAX_FRAME_BYTES, encodeBinaryFrame, encodeJsonFrame } from '../native-frame'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ncw-doc-engine-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// ─────────────────────────── fake engine ───────────────────────────

/**
 * 假引擎:把文档当成一段文本,`text.replace` 追加文字,`saveTo` 写出当前文本。
 * 可控制「挂起不回」与「中途崩溃」,用来钉住结果未知与崩溃路径。
 */
class FakeEngine implements DocumentEngineProvider {
  readonly id = 'ncw.office-runtime/office'
  readonly formats = ['docx', 'xlsx'] as const
  opened = 0
  hang = false
  crashNext = false
  applied: DocumentOperation[][] = []
  private crash: (() => void) | null = null

  async open(input: { workingPath: string; onCrash: () => void }): Promise<DocumentEngineHandle> {
    this.opened += 1
    this.crash = input.onCrash
    let text = readFileSync(input.workingPath, 'utf8')
    const capabilities: DocumentCapabilities = {
      format: 'docx', engineVersion: 'fake-1', operations: ['text.replace'], canSave: true, canExport: [], canUndo: false, macros: { list: false, run: false }
    }
    return {
      capabilities,
      apply: async (operations) => {
        if (this.crashNext) { this.crashNext = false; this.crash?.(); throw new Error('helper exited') }
        if (this.hang) await new Promise(() => undefined)
        this.applied.push(operations)
        for (const op of operations) if (op.kind === 'text.replace') text += op.text
        return { warnings: [], undoable: false }
      },
      saveTo: async (outputPath) => { writeFileSync(outputPath, text) },
      close: async () => undefined
    }
  }
}

const SCOPE = { accountScope: 'acct', workspaceId: 'ws1' }

function setup(options: { timeoutMs?: number } = {}): { manager: DocumentSessionManager; engine: FakeEngine; file: string; events: DocumentSessionSnapshot[] } {
  const file = join(root, 'report.docx')
  writeFileSync(file, 'hello')
  const events: DocumentSessionSnapshot[] = []
  const manager = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: options.timeoutMs ?? 1000, onChange: (s) => { events.push(s) } })
  const engine = new FakeEngine()
  manager.registerProvider(engine)
  return { manager, engine, file, events }
}

const replace = (text: string): unknown[] => [{ kind: 'text.replace', target: { generation: 1, ref: 'p:0' }, text }]

describe('DocumentSessionManager', () => {
  it('shares one live model when the same file is opened twice (no second engine instance)', async () => {
    const { manager, engine, file } = setup()
    const [a, b] = await Promise.all([
      manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id }),
      manager.open({ scope: { ...SCOPE, workspaceId: 'ws2' }, absolutePath: file, providerId: engine.id })
    ])
    expect(a.snapshot.sessionId).toBe(b.snapshot.sessionId)
    expect(a.viewId).not.toBe(b.viewId)
    expect(engine.opened).toBe(1)
  })

  it('does not touch the original file bytes or mtime on open', async () => {
    const { manager, engine, file } = setup()
    utimesSync(file, new Date(1_000_000), new Date(1_000_000))
    const before = statSync(file).mtimeMs
    await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    expect(statSync(file).mtimeMs).toBe(before)
    expect(readFileSync(file, 'utf8')).toBe('hello')
  })

  it('applies, marks dirty, saves atomically and becomes clean', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    const result = await manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'op1', generation: 1, modelRevision: 0, operations: replace(' world') })
    expect(result).toMatchObject({ appliedRevision: 1, dirty: true })
    expect(readFileSync(file, 'utf8')).toBe('hello')
    const saved = await manager.save({ sessionId: snapshot.sessionId, scope: SCOPE })
    expect(readFileSync(file, 'utf8')).toBe('hello world')
    expect(saved.savedRevision).toBe(1)
    expect(saved.diskRevision).toBe(await digestFile(file))
  })

  it('rejects stale revisions so an old plan cannot write at outdated positions', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'op1', generation: 1, modelRevision: 0, operations: replace('a') })
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'op2', generation: 1, modelRevision: 0, operations: replace('b') }))
      .rejects.toMatchObject({ code: 'stale_revision' })
    expect(engine.applied).toHaveLength(1)
  })

  it('returns the recorded result for a repeated operationId instead of applying twice', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    const input = { sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'same', generation: 1, modelRevision: 0, operations: replace('x') }
    const first = await manager.apply(input)
    const second = await manager.apply(input)
    expect(second).toEqual(first)
    expect(engine.applied).toHaveLength(1)
  })

  it('reports result_unknown on timeout, marks the session crashed and never replays', async () => {
    const { manager, engine, file } = setup({ timeoutMs: 20 })
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    engine.hang = true
    const input = { sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'slow', generation: 1, modelRevision: 0, operations: replace('x') }
    await expect(manager.apply(input)).rejects.toMatchObject({ code: 'result_unknown' })
    expect(manager.getOperation('slow')?.status).toBe('unknown')
    expect(manager.snapshot(snapshot.sessionId, SCOPE).status).toBe('crashed')
    await expect(manager.apply(input)).rejects.toMatchObject({ code: 'result_unknown' })
  })

  it('reloads from disk after a crash with a new generation, invalidating old references', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    engine.crashNext = true
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'c', generation: 1, modelRevision: 0, operations: replace('x') }))
      .rejects.toMatchObject({ code: 'result_unknown' })
    const reloaded = await manager.reloadFromDisk({ sessionId: snapshot.sessionId, scope: SCOPE })
    expect(reloaded).toMatchObject({ status: 'ready', generation: 2 })
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'd', generation: 1, modelRevision: 0, operations: replace('y') }))
      .rejects.toMatchObject({ code: 'stale_generation' })
  })

  it('enters conflict instead of overwriting when the file changed on disk', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'op', generation: 1, modelRevision: 0, operations: replace('!') })
    writeFileSync(file, 'someone else')
    await expect(manager.save({ sessionId: snapshot.sessionId, scope: SCOPE })).rejects.toMatchObject({ code: 'disk_conflict' })
    expect(readFileSync(file, 'utf8')).toBe('someone else')
    expect(manager.snapshot(snapshot.sessionId, SCOPE).status).toBe('conflict')
    const reloaded = await manager.reloadFromDisk({ sessionId: snapshot.sessionId, scope: SCOPE })
    expect(reloaded.diskRevision).toBe(await digestFile(file))
  })

  it('keeps a dirty session alive when the last view leaves unless forced', async () => {
    const { manager, engine, file } = setup()
    const { snapshot, viewId } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'op', generation: 1, modelRevision: 0, operations: replace('!') })
    expect(await manager.release({ sessionId: snapshot.sessionId, scope: SCOPE, viewId })).toEqual({ closed: false, dirty: true })
    expect(manager.dirtySessions()).toHaveLength(1)
    expect(await manager.release({ sessionId: snapshot.sessionId, scope: SCOPE, viewId, force: true })).toEqual({ closed: true, dirty: false })
    expect(() => manager.snapshot(snapshot.sessionId, SCOPE)).toThrow(DocumentEngineError)
  })

  it('hides sessions from callers outside their account/workspace scope', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    expect(() => manager.snapshot(snapshot.sessionId, { accountScope: 'acct', workspaceId: 'other' })).toThrow(/no such document session/)
    expect(() => manager.snapshot(snapshot.sessionId, { accountScope: 'other', workspaceId: 'ws1' })).toThrow(/no such document session/)
  })

  it('refuses unsupported formats, unknown engines and unsupported operations', async () => {
    const { manager, engine, file } = setup()
    const pdf = join(root, 'a.pdf')
    writeFileSync(pdf, 'x')
    await expect(manager.open({ scope: SCOPE, absolutePath: join(root, 'a.doc'), providerId: engine.id })).rejects.toMatchObject({ code: 'unsupported_format' })
    await expect(manager.open({ scope: SCOPE, absolutePath: pdf, providerId: engine.id })).rejects.toMatchObject({ code: 'unsupported_format' })
    await expect(manager.open({ scope: SCOPE, absolutePath: file, providerId: 'missing/engine' })).rejects.toMatchObject({ code: 'engine_unavailable' })
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'u', generation: 1, modelRevision: 0, operations: [{ kind: 'slide.move', from: 0, to: 1 }] }))
      .rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(engine.applied).toHaveLength(0)
  })

  it('saving an unmodified document is a no-op that leaves mtime alone', async () => {
    const { manager, engine, file } = setup()
    utimesSync(file, new Date(2_000_000), new Date(2_000_000))
    const before = statSync(file).mtimeMs
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await manager.save({ sessionId: snapshot.sessionId, scope: SCOPE })
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('rejects operation targets from an older engine generation', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await expect(manager.apply({ sessionId: snapshot.sessionId, scope: SCOPE, operationId: 'g', generation: 1, modelRevision: 0, operations: [{ kind: 'text.replace', target: { generation: 0, ref: 'p:0' }, text: 'x' }] }))
      .rejects.toMatchObject({ code: 'stale_generation' })
    expect(engine.applied).toHaveLength(0)
  })

  it('validates queries and reports engines without query support honestly', async () => {
    const { manager, engine, file } = setup()
    const { snapshot } = await manager.open({ scope: SCOPE, absolutePath: file, providerId: engine.id })
    await expect(manager.query({ sessionId: snapshot.sessionId, scope: SCOPE, request: { kind: 'cells', sheet: 'S', range: 'nope' } })).rejects.toMatchObject({ code: 'invalid_operation' })
    await expect(manager.query({ sessionId: snapshot.sessionId, scope: SCOPE, request: { kind: 'outline' } })).rejects.toMatchObject({ code: 'unsupported_operation' })
  })
})

// ─────────────────────────── file store ───────────────────────────

describe('file store', () => {
  it('refuses symlinked documents', async () => {
    const real = join(root, 'real.docx')
    writeFileSync(real, 'x')
    const link = join(root, 'link.docx')
    symlinkSync(real, link)
    await expect(createWorkingCopy(link, join(root, 'p'))).rejects.toMatchObject({ code: 'io' })
  })

  it('never replaces a document with an empty engine output', async () => {
    const target = join(root, 't.docx')
    writeFileSync(target, 'data')
    const produced = join(root, 'out.docx')
    writeFileSync(produced, '')
    await expect(commitSave(target, produced, await digestFile(target))).rejects.toMatchObject({ code: 'io' })
    expect(readFileSync(target, 'utf8')).toBe('data')
  })
})

// ─────────────────────────── frames ───────────────────────────

describe('native frame codec', () => {
  it('reassembles frames split across and packed within chunks', () => {
    const bytes = Buffer.concat([encodeJsonFrame({ a: 1 }), encodeBinaryFrame(new Uint8Array([1, 2, 3])), encodeJsonFrame('z')])
    const decoder = new FrameDecoder()
    const frames = [...decoder.push(bytes.subarray(0, 3)), ...decoder.push(bytes.subarray(3, 12)), ...decoder.push(bytes.subarray(12))]
    expect(frames).toEqual([{ kind: 'json', value: { a: 1 } }, { kind: 'binary', bytes: new Uint8Array([1, 2, 3]) }, { kind: 'json', value: 'z' }])
    expect(decoder.pendingBytes).toBe(0)
  })

  it('rejects oversized lengths before allocating, and stays broken afterwards', () => {
    const header = Buffer.alloc(5)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    const decoder = new FrameDecoder()
    expect(() => decoder.push(header)).toThrow(FrameProtocolError)
    expect(() => decoder.push(encodeJsonFrame(1))).toThrow(FrameProtocolError)
  })

  it('rejects unknown frame types and invalid JSON', () => {
    const bad = Buffer.from([0, 0, 0, 1, 9, 0])
    expect(() => new FrameDecoder().push(bad)).toThrow(/unknown frame type/)
    const notJson = Buffer.concat([Buffer.from([0, 0, 0, 1, 0]), Buffer.from('{')])
    expect(() => new FrameDecoder().push(notJson)).toThrow(/not valid JSON/)
  })
})
