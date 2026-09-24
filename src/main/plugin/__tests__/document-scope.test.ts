/**
 * `documents.*` 在 PluginManager 里的作用域派生(`resolveDocumentScope`)。
 *
 * 需求:Agent 在后台工作区里跑的工具,改的必须是那个工作区的文档,哪怕用户此刻在看
 * 另一个。所以带 callId 的文档调用按**内核给这次工具调用的 workspaceId** 定作用域,
 * 且 callId 必须正在跑、属于这个插件。文档实现用替身,只看它收到了什么作用域。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from '../../../shared/plugin/manifest'
import type { PluginMethod } from '../../../shared/plugin/protocol'
import type { ToolContext } from '../../kernel/tool/registry'
import type { DocumentCallScope, PluginDocumentsBridge } from '../document-rpc'
import { PluginManager, type PluginRuntime } from '../manager'

const MANIFEST = {
  name: 'writer',
  publisher: 'acme',
  displayName: 'Writer',
  description: 'document scope fixture',
  version: '1.0.0',
  engines: { nextcowork: '^1.0.0' },
  main: './dist/extension.js',
  activationEvents: ['onTool:edit_doc'],
  permissions: ['workspace.read', 'workspace.write'],
  contributes: { tools: [{ name: 'edit_doc', title: '%t%' }] }
}

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true })
})

interface Seen { method: PluginMethod; scope: DocumentCallScope }

function ctx(callId: string, workspaceId: string | undefined): ToolContext {
  return {
    callId, signal: new AbortController().signal, emit: () => {}, workspaceRoot: '/w', permissionMode: 'default', depth: 0, runId: 'r', host: {},
    ...(workspaceId === undefined ? {} : { workspaceId })
  } as unknown as ToolContext
}

async function makeManager(
  runtime: PluginRuntime,
  seen: Seen[],
  workspaces: Record<string, string> = { bg: '/ws/background' }
): Promise<PluginManager> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ncw-doc-scope-'))
  roots.push(root)
  const dir = join(root, 'acme.writer')
  await fs.mkdir(join(dir, 'dist'), { recursive: true })
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify(MANIFEST))
  await fs.writeFile(join(dir, 'dist', 'extension.js'), 'export function activate(){}')
  const kv = new Map<string, unknown>()
  const documents: PluginDocumentsBridge = {
    handle: async (_pluginId: string, _manifest: PluginManifest, method: PluginMethod, _params: unknown, scope: DocumentCallScope) => {
      seen.push({ method, scope })
      return { data: {}, summary: method }
    },
    releasePlugin: async () => undefined
  }
  const manager = new PluginManager({
    host: { logger: { warn() {}, info() {}, error() {} } } as never,
    runtime,
    pluginRoot: root,
    hostVersion: '1.0.0',
    apiVersion: '1.0.0',
    getKv: (key, fallback) => (kv.has(key) ? (kv.get(key) as typeof fallback) : fallback),
    setKv: (key, value) => { kv.set(key, value) },
    currentWorkspace: () => ({ id: 'fg', rootPath: '/ws/foreground' }),
    currentAppearance: () => 'dark' as const,
    approve: async () => true,
    trash: async () => {},
    openExternal: async () => {},
    clipboard: { readText: async () => '', writeText: async () => {} },
    scmFor: () => { throw new Error('scm adapter is not wired in this test') },
    openTab: () => {},
    requestInteraction: async () => null,
    emitProgress: () => {},
    emitChanged: () => {},
    publishMessages: () => {},
    unpublishMessages: () => {},
    requestPermissions: async () => true,
    onToolsChanged: () => {},
    reserveName: (id) => id,
    showMessage: () => {},
    openCustomEditor: () => {},
    documents,
    resolveWorkspace: (id) => (workspaces[id] === undefined ? null : { id, rootPath: workspaces[id] })
  })
  await manager.start()
  manager.grant('acme.writer', ['workspace.read', 'workspace.write'])
  await manager.setEnabled('acme.writer', true)
  await manager.wake('acme.writer')
  await manager.handleRequest('acme.writer', {
    id: 1,
    method: 'tools.register',
    params: { name: 'edit_doc', description: 'd', inputSchema: { type: 'object' }, readOnly: false, destructive: false, needsNetwork: false, interactive: false }
  })
  return manager
}

/** 工具执行期间,以 `asPlugin` 的身份带着这次的 callId 发一条文档请求;失败信封记进 outcome */
function runtimeCalling(get: () => PluginManager, asPlugin: string, outcome: { error?: unknown }): PluginRuntime {
  return {
    spawn: async () => {},
    dispose: () => {},
    disposeAll: () => {},
    invoke: async (_pluginId, invocation) => {
      if (invocation.kind === 'tool.execute') {
        const callId = (invocation.payload as { callId: string }).callId
        const response = await get().handleRequest(asPlugin, { id: 7, method: 'documents.open', params: { path: 'a.docx', callId } })
        if (!response.ok) outcome.error = response.error
        return { content: [{ text: 'done' }] }
      }
      return {}
    }
  }
}

function tool(manager: PluginManager): NonNullable<ReturnType<PluginManager['contributedTools']>[number]> {
  const reg = manager.contributedTools().find((t) => t.internalId.endsWith('edit_doc'))
  if (reg === undefined) throw new Error('tool not registered')
  return reg
}

describe('documents.* scope', () => {
  it('scopes a tool-call document request to the run\'s workspace, not the foreground one', async () => {
    const seen: Seen[] = []
    const outcome: { error?: unknown } = {}
    let manager: PluginManager | null = null
    manager = await makeManager(runtimeCalling(() => manager!, 'acme.writer', outcome), seen)
    await tool(manager).execute({}, ctx('call-1', 'bg'))
    expect(outcome.error).toBeUndefined()
    expect(seen).toEqual([{ method: 'documents.open', scope: { workspaceId: 'bg', workspaceRoot: '/ws/background' } }])
  })

  it('uses the foreground workspace for requests without a callId', async () => {
    const seen: Seen[] = []
    const manager = await makeManager({ spawn: async () => {}, dispose: () => {}, disposeAll: () => {}, invoke: async () => ({}) }, seen)
    await manager.handleRequest('acme.writer', { id: 3, method: 'documents.open', params: { path: 'a.docx' } })
    expect(seen[0]?.scope).toEqual({ workspaceId: 'fg', workspaceRoot: '/ws/foreground' })
  })

  it('★ rejects another plugin reusing this call\'s callId instead of falling back to the foreground', async () => {
    const seen: Seen[] = []
    const outcome: { error?: unknown } = {}
    let manager: PluginManager | null = null
    manager = await makeManager(runtimeCalling(() => manager!, 'evil.plugin', outcome), seen)
    await tool(manager).execute({}, ctx('call-1', 'bg'))
    expect(seen).toEqual([])
    expect(outcome.error).toBeDefined()
  })

  it('rejects a callId that is no longer running', async () => {
    const seen: Seen[] = []
    const manager = await makeManager({ spawn: async () => {}, dispose: () => {}, disposeAll: () => {}, invoke: async () => ({ content: [{ text: 'ok' }] }) }, seen)
    await tool(manager).execute({}, ctx('call-done', 'bg'))
    const response = await manager.handleRequest('acme.writer', { id: 4, method: 'documents.open', params: { path: 'a.docx', callId: 'call-done' } })
    expect(response).toMatchObject({ ok: false, error: { code: 'rejected' } })
    expect(seen).toEqual([])
  })

  it('refuses tool calls from a remote workspace, which resolveWorkspace does not return', async () => {
    const seen: Seen[] = []
    const outcome: { error?: unknown } = {}
    let manager: PluginManager | null = null
    manager = await makeManager(runtimeCalling(() => manager!, 'acme.writer', outcome), seen, {})
    await tool(manager).execute({}, ctx('call-1', 'remote'))
    expect(seen).toEqual([])
    expect(outcome.error).toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('[unsupported_environment]') })
  })
})
