/**
 * 插件 `documents.*` RPC(`document-rpc.ts`)的门与租约。
 *
 * 用真的 `DocumentSessionManager` + 假引擎(文档 = 一段文本)驱动:会话、串行队列、
 * 修订号、保存的冲突检查都是真的,只有 LibreOffice 被换掉。钉住的是插件侧那几道门 ——
 * 句柄归属、路径收窄、引擎只来自清单、导出不许写回原文件、放下租约不丢脏改动。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocumentCapabilities } from '../../../shared/document-engine/protocol'
import type { PluginManifest } from '../../../shared/plugin/manifest'
import { DocumentSessionManager, type DocumentEngineHandle, type DocumentEngineProvider } from '../../document-engine/manager'
import { PluginDocuments, engineCandidates, toCapabilityError, type DocumentCallScope } from '../document-rpc'
import { DocumentEngineError } from '../../../shared/document-engine/protocol'

let root: string
let workspace: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ncw-doc-rpc-'))
  workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'report.docx'), 'hello')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 假引擎:`text.replace` 追加文字,保存 / 导出写出当前文本 */
class FakeEngine implements DocumentEngineProvider {
  readonly formats = ['docx'] as const
  opened = 0
  constructor(readonly id: string) {}

  async open(input: { workingPath: string }): Promise<DocumentEngineHandle> {
    this.opened += 1
    let text = readFileSync(input.workingPath, 'utf8')
    const capabilities: DocumentCapabilities = {
      format: 'docx', engineVersion: 'fake-1', operations: ['text.replace'], canSave: true, canExport: ['pdf'], canUndo: false, macros: { list: false, run: false }
    }
    return {
      capabilities,
      apply: async (operations) => {
        for (const op of operations) if (op.kind === 'text.replace') text += op.text
        return { warnings: [], undoable: false }
      },
      saveTo: async (outputPath) => { writeFileSync(outputPath, text) },
      exportTo: async (outputPath, format) => { writeFileSync(outputPath, `${format}:${text}`) },
      close: async () => undefined
    }
  }
}

const ENGINE = 'ncw.office-runtime/office'

/** 最小清单:只填 document-rpc 读到的字段 */
function manifestOf(over: { dependencies?: Record<string, string>; editorEngine?: string; engines?: string[] } = {}): PluginManifest {
  return {
    dependencies: over.dependencies ?? { 'ncw.office-runtime': '^1.0.0' },
    contributes: {
      customEditors: over.editorEngine === undefined ? [] : [{ viewType: 'ncw.writer', documentEngine: over.editorEngine }],
      documentEngines: (over.engines ?? []).map((id) => ({ id, component: 'helper', formats: ['docx'] }))
    }
  } as unknown as PluginManifest
}

const WRITER = manifestOf({ editorEngine: ENGINE })

function setup(): { docs: PluginDocuments; engine: FakeEngine; sessions: DocumentSessionManager; scope: DocumentCallScope } {
  const sessions = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 1000 })
  const engine = new FakeEngine(ENGINE)
  sessions.registerProvider(engine)
  const docs = new PluginDocuments({
    sessions,
    ensureProvider: (id) => (id === ENGINE ? engine : null),
    retireEngines: async () => undefined,
    accountScope: () => 'acct'
  })
  return { docs, engine, sessions, scope: { workspaceId: 'ws1', workspaceRoot: workspace } }
}

const replace = (text: string): unknown[] => [{ kind: 'text.replace', target: { generation: 1, ref: 'p:0' }, text }]

async function openReport(docs: PluginDocuments, scope: DocumentCallScope, pluginId = 'ncw.writer', manifest = WRITER): Promise<string> {
  const { data } = await docs.handle(pluginId, manifest, 'documents.open', { path: 'report.docx' }, scope)
  return (data as { sessionId: string }).sessionId
}

describe('PluginDocuments', () => {
  it('opens through the editor-bound engine, applies, and saves back with a change notice', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    const applied = await docs.handle('ncw.writer', WRITER, 'documents.apply', { sessionId, generation: 1, modelRevision: 0, operationId: 'op1', operations: replace(' world') }, scope)
    expect(applied.data).toMatchObject({ appliedRevision: 1, dirty: true })
    expect(readFileSync(join(workspace, 'report.docx'), 'utf8')).toBe('hello')
    const saved = await docs.handle('ncw.writer', WRITER, 'documents.save', { sessionId }, scope)
    expect(readFileSync(join(workspace, 'report.docx'), 'utf8')).toBe('hello world')
    expect(saved.changed).toEqual({ path: 'report.docx', kind: 'modified' })
  })

  it('does not report a change when saving a document that has no edits', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    const saved = await docs.handle('ncw.writer', WRITER, 'documents.save', { sessionId }, scope)
    expect(saved.changed).toBeUndefined()
  })

  it('reuses one lease when the same plugin reopens the same file through a different spelling', async () => {
    const { docs, engine, scope } = setup()
    const first = await openReport(docs, scope)
    const { data } = await docs.handle('ncw.writer', WRITER, 'documents.open', { path: './sub/../report.docx' }, scope)
    expect((data as { sessionId: string }).sessionId).toBe(first)
    expect(engine.opened).toBe(1)
  })

  it('refuses a sessionId held by another plugin with the same error as an unknown one', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    const other = manifestOf({ editorEngine: ENGINE })
    await expect(docs.handle('evil.plugin', other, 'documents.apply', { sessionId, generation: 1, modelRevision: 0, operationId: 'x', operations: replace('!') }, scope))
      .rejects.toMatchObject({ code: 'rejected', message: expect.stringContaining('[session_closed]') })
    await expect(docs.handle('evil.plugin', other, 'documents.getState', { sessionId: 'nope' }, scope))
      .rejects.toMatchObject({ code: 'rejected', message: expect.stringContaining('[session_closed]') })
  })

  it('refuses a sessionId from another workspace scope even for the same plugin', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    await expect(docs.handle('ncw.writer', WRITER, 'documents.getState', { sessionId }, { ...scope, workspaceId: 'ws2' }))
      .rejects.toMatchObject({ message: expect.stringContaining('[session_closed]') })
  })

  it('rejects paths that escape the workspace, lexically or through a symlink', async () => {
    const { docs, scope } = setup()
    writeFileSync(join(root, 'outside.docx'), 'secret')
    symlinkSync(join(root, 'outside.docx'), join(workspace, 'link.docx'))
    await expect(docs.handle('ncw.writer', WRITER, 'documents.open', { path: '../outside.docx' }, scope)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(docs.handle('ncw.writer', WRITER, 'documents.open', { path: 'link.docx' }, scope))
      .rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('symlinks') })
  })

  it('only uses engines named by the manifest: own, editor-bound, or from a declared dependency', async () => {
    const { docs, scope } = setup()
    const noDeps = manifestOf({ dependencies: {} })
    await expect(docs.handle('ncw.writer', noDeps, 'documents.open', { path: 'report.docx', engine: ENGINE }, scope))
      .rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('dependencies') })
    await expect(docs.handle('ncw.writer', noDeps, 'documents.open', { path: 'report.docx' }, scope))
      .rejects.toMatchObject({ code: 'internal_error', message: expect.stringContaining('[engine_unavailable]') })
    const viaDependency = manifestOf()
    const { data } = await docs.handle('ncw.writer', viaDependency, 'documents.open', { path: 'report.docx', engine: ENGINE }, scope)
    expect(data).toMatchObject({ path: 'report.docx' })
  })

  it('surfaces stale revisions as rejected with the document code, without touching the model', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    await docs.handle('ncw.writer', WRITER, 'documents.apply', { sessionId, generation: 1, modelRevision: 0, operationId: 'a', operations: replace('1') }, scope)
    await expect(docs.handle('ncw.writer', WRITER, 'documents.apply', { sessionId, generation: 1, modelRevision: 0, operationId: 'b', operations: replace('2') }, scope))
      .rejects.toMatchObject({ code: 'rejected', message: expect.stringContaining('[stale_revision]') })
  })

  it('exports to another workspace file but refuses to export over the document itself', async () => {
    const { docs, scope } = setup()
    const sessionId = await openReport(docs, scope)
    const exported = await docs.handle('ncw.writer', WRITER, 'documents.export', { sessionId, path: 'out.pdf', format: 'pdf' }, scope)
    expect(readFileSync(join(workspace, 'out.pdf'), 'utf8')).toBe('pdf:hello')
    expect(exported.changed).toEqual({ path: 'out.pdf', kind: 'created' })
    await expect(docs.handle('ncw.writer', WRITER, 'documents.export', { sessionId, path: 'report.docx', format: 'docx', overwrite: true }, scope))
      .rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('documents.save') })
    await expect(docs.handle('ncw.writer', WRITER, 'documents.export', { sessionId, path: 'missing/out.pdf', format: 'pdf' }, scope))
      .rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('answers getOperation for its own session and reports another session\'s receipt as missing', async () => {
    const { docs, scope } = setup()
    writeFileSync(join(workspace, 'other.docx'), 'x')
    const mine = await openReport(docs, scope)
    const { data } = await docs.handle('ncw.writer', WRITER, 'documents.open', { path: 'other.docx' }, scope)
    const other = (data as { sessionId: string }).sessionId
    await docs.handle('ncw.writer', WRITER, 'documents.apply', { sessionId: other, generation: 1, modelRevision: 0, operationId: 'on-other', operations: replace('y') }, scope)
    expect((await docs.handle('ncw.writer', WRITER, 'documents.getOperation', { sessionId: other, operationId: 'on-other' }, scope)).data)
      .toMatchObject({ status: 'applied' })
    expect((await docs.handle('ncw.writer', WRITER, 'documents.getOperation', { sessionId: mine, operationId: 'on-other' }, scope)).data)
      .toEqual({ status: 'missing' })
  })

  it('keeps unsaved edits alive after close so a later open joins the dirty session', async () => {
    const { docs, engine, scope } = setup()
    const sessionId = await openReport(docs, scope)
    await docs.handle('ncw.writer', WRITER, 'documents.apply', { sessionId, generation: 1, modelRevision: 0, operationId: 'a', operations: replace('!') }, scope)
    const closed = await docs.handle('ncw.writer', WRITER, 'documents.close', { sessionId }, scope)
    expect(closed.data).toEqual({ closed: false, dirty: true })
    const reopened = await docs.handle('ncw.writer', WRITER, 'documents.open', { path: 'report.docx' }, scope)
    expect(reopened.data).toMatchObject({ sessionId, snapshot: { modelRevision: 1, savedRevision: 0 } })
    expect(engine.opened).toBe(1)
  })

  it('drops idle leases on sweep and closes clean sessions', async () => {
    let now = 0
    const sessions = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 1000 })
    const engine = new FakeEngine(ENGINE)
    sessions.registerProvider(engine)
    const docs = new PluginDocuments({ sessions, ensureProvider: () => engine, retireEngines: async () => undefined, accountScope: () => 'acct', leaseIdleMs: 100, now: () => now })
    const scope = { workspaceId: 'ws1', workspaceRoot: workspace }
    const sessionId = await openReport(docs, scope)
    now = 500
    await docs.sweepIdle()
    await expect(docs.handle('ncw.writer', WRITER, 'documents.getState', { sessionId }, scope)).rejects.toMatchObject({ message: expect.stringContaining('[session_closed]') })
    await openReport(docs, scope)
    expect(engine.opened).toBe(2)
  })

  it('releases every lease of a disabled plugin and retires the engines it carries', async () => {
    const retired: string[] = []
    const sessions = new DocumentSessionManager({ privateDir: join(root, 'private'), timeoutMs: 1000 })
    const engine = new FakeEngine(ENGINE)
    sessions.registerProvider(engine)
    const docs = new PluginDocuments({ sessions, ensureProvider: () => engine, retireEngines: async (id) => { retired.push(id) }, accountScope: () => 'acct' })
    const scope = { workspaceId: 'ws1', workspaceRoot: workspace }
    const sessionId = await openReport(docs, scope)
    await docs.releasePlugin('ncw.writer')
    expect(retired).toEqual(['ncw.writer'])
    await expect(docs.handle('ncw.writer', WRITER, 'documents.getState', { sessionId }, scope)).rejects.toMatchObject({ message: expect.stringContaining('[session_closed]') })
  })
})

describe('engineCandidates / toCapabilityError', () => {
  it('orders editor-bound engines before the plugin\'s own and qualifies bare ids', () => {
    const manifest = manifestOf({ editorEngine: ENGINE, engines: ['local'] })
    expect(engineCandidates('acme.writer', manifest)).toEqual([ENGINE, 'acme.writer/local'])
  })

  it('maps document codes onto the fixed plugin error codes by how the caller should react', () => {
    expect(toCapabilityError(new DocumentEngineError('invalid_operation', 'm')).code).toBe('invalid_argument')
    expect(toCapabilityError(new DocumentEngineError('result_unknown', 'm')).code).toBe('rejected')
    expect(toCapabilityError(new DocumentEngineError('engine_crashed', 'm'))).toMatchObject({ code: 'internal_error', message: '[engine_crashed] m' })
  })
})
