/**
 * v2 配置同步的双设备闭环。
 *
 * 假服务端严格照 `EncryptedConfigSyncEndpoints` 的公开 DTO:GET/POST vault、
 * devices/register、push、pull、preview。测试不碰真实网络,但会检查网络 body
 * 从未出现 provider key —— 它只能藏在 syncEnvelope.payload.ciphertext 中。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncEnvelope, SyncEvent, SyncVault } from '../../shared/domain/config-sync'
import { closeDatabase, openDatabase } from '../db'
import * as repo from '../db/repo'
import { nodeHost } from '../kernel/host'
import { installHost, resetRuntimeForTest } from '../runtime'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../window/registry', () => ({ windows: { emitToAll: vi.fn() } }))

import {
  confirmInitialConfigSync,
  getConfigSyncPreview,
  setupConfigSync,
  shutdownConfigSync,
  startConfigSync
} from '../ipc/config-sync'

const password = 'shared sync password 2026'
const secret = 'sk-cross-device-secret'
const dirs: string[] = []

interface PushBody { mutations: SyncEnvelope[] }

class FakeSyncServer {
  vault: SyncVault | null = null
  revision = 0
  cursor = 0
  current: SyncEvent | null = null
  legacyDocuments: Array<Record<string, unknown>> = []
  legacyEvents: Array<Record<string, unknown>> = []
  legacyConflicts: Array<Record<string, unknown>> = []
  readonly resources = new Set<string>()
  readonly requestBodies: string[] = []

  private get migrationPending(): boolean {
    return this.legacyDocuments.length > 0
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof URL ? input.href : String(input))
    const path = url.pathname.replace('/api/client/config-sync/v2', '')
    const method = init?.method ?? 'GET'
    const raw = typeof init?.body === 'string' ? init.body : ''
    if (raw !== '') this.requestBodies.push(raw)

    if (path === '/vault' && method === 'GET') {
      return Response.json({
        vault: this.vault,
        legacyExists: this.migrationPending,
        migrationRequired: this.vault !== null && this.migrationPending
      })
    }
    if (path === '/vault' && method === 'POST') {
      const body = JSON.parse(raw) as { vault: SyncVault }
      this.vault = body.vault
      return Response.json(body.vault)
    }
    if (path === '/devices/register' && method === 'POST') {
      return Response.json({ ok: true })
    }
    if (path === '/legacy' && method === 'GET') {
      if (!this.migrationPending) {
        return Response.json({ error: 'migrationRequired' }, { status: 409 })
      }
      const after = Number(url.searchParams.get('cursor') ?? 0)
      const events = this.legacyEvents.filter((event) => Number(event['cursor']) > after)
      return Response.json({
        cursor: events.at(-1) === undefined ? after : Number(events.at(-1)?.['cursor']),
        hasMore: false,
        documents: this.legacyDocuments,
        events,
        conflicts: this.legacyConflicts,
        counts: {
          documents: this.legacyDocuments.length,
          events: this.legacyEvents.length,
          conflicts: this.legacyConflicts.length,
          secrets: 0,
          maxEventId: this.legacyEvents.length,
          maxRevision: 3
        }
      })
    }
    if (path.startsWith('/resources/') && method === 'POST') {
      this.resources.add(path.slice('/resources/'.length))
      return Response.json({ ok: true })
    }
    if (path === '/migration/commit' && method === 'POST') {
      const body = JSON.parse(raw) as {
        archiveIds: string[]
        deleteLegacy: boolean
        expected: { documents: number; events: number; conflicts: number; maxEventId: number; maxRevision: number }
      }
      if (!body.deleteLegacy || body.archiveIds.some((id) => !this.resources.has(id))) {
        return Response.json({ error: 'invalidData' }, { status: 400 })
      }
      if (
        body.expected.documents !== this.legacyDocuments.length ||
        body.expected.events !== this.legacyEvents.length ||
        body.expected.conflicts !== this.legacyConflicts.length
      ) {
        return Response.json({ error: 'conflict' }, { status: 409 })
      }
      this.legacyDocuments = []
      this.legacyEvents = []
      this.legacyConflicts = []
      return Response.json({ ok: true })
    }
    if (path === '/preview' && method === 'GET') {
      return Response.json({ events: this.current === null ? [] : [this.current] })
    }
    if (path === '/push' && method === 'POST') {
      const body = JSON.parse(raw) as PushBody
      const accepted: Array<{ mutationId: string; revision: number }> = []
      const conflicts: Array<{ mutationId: string; remote: SyncEvent | null }> = []
      for (const mutation of body.mutations) {
        if (mutation.baseRevision !== this.revision) {
          conflicts.push({ mutationId: mutation.mutationId, remote: this.current })
          continue
        }
        this.revision += 1
        this.cursor += 1
        this.current = {
          ...mutation,
          revision: this.revision,
          cursor: this.cursor,
          deviceId: new Headers(init?.headers).get('x-sync-device-id') ?? 'unknown'
        }
        accepted.push({ mutationId: mutation.mutationId, revision: this.revision })
      }
      return Response.json({ accepted, conflicts })
    }
    if (path === '/pull' && method === 'GET') {
      const after = Number(url.searchParams.get('cursor') ?? 0)
      const events = this.current !== null && this.current.cursor > after ? [this.current] : []
      return Response.json({ cursor: events.at(-1)?.cursor ?? after, hasMore: false, events })
    }
    return Response.json({ error: 'unsupported' }, { status: 404 })
  }
}

function openDevice(server: FakeSyncServer): ReturnType<typeof nodeHost> {
  closeDatabase()
  const dir = mkdtempSync(join(tmpdir(), 'nextcowork-sync-device-'))
  dirs.push(dir)
  openDatabase(dir)
  resetRuntimeForTest()
  const host = nodeHost({ fetch: server.fetch })
  installHost(host)
  return host
}

function putProvider(): void {
  repo.putProvider({
    id: 'acme', name: 'Acme', protocol: 'openai-chat', baseUrl: 'https://acme.invalid/v1',
    credentialRef: 'provider:acme', priority: 1, enabled: true
  })
  repo.putAlias({
    alias: 'model', providerId: 'acme', upstreamModel: 'model',
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
    contextWindow: 4096, maxOutputTokens: 1024
  })
}

afterEach(() => {
  shutdownConfigSync()
  resetRuntimeForTest()
  closeDatabase()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('v2 provider credential synchronization', () => {
  it('encrypts on device A and rehydrates the same key on device B without plaintext on the wire', async () => {
    const server = new FakeSyncServer()

    const deviceA = openDevice(server)
    await deviceA.secrets.set('nextcowork:client-access-token', 'account-access-a')
    putProvider()
    await deviceA.secrets.set('provider:acme', secret)
    startConfigSync('1')
    await setupConfigSync({ password, remember: true })

    expect(server.vault).not.toBeNull()
    expect(server.current?.kind).toBe('providers')
    expect(server.requestBodies.join('\n')).not.toContain(secret)
    expect(server.requestBodies.join('\n')).not.toContain('https://acme.invalid/v1')
    shutdownConfigSync()

    const deviceB = openDevice(server)
    await deviceB.secrets.set('nextcowork:client-access-token', 'account-access-b')
    startConfigSync('1')
    const unlocked = await setupConfigSync({ password, remember: false })
    expect(unlocked.control?.phase).toBe('review')
    const preview = await getConfigSyncPreview()
    expect(preview.count).toBe(3) // provider + alias + credential

    await confirmInitialConfigSync()
    expect(repo.listProviders().map((provider) => provider.id)).toContain('acme')
    expect(repo.listAliases().map((alias) => alias.alias)).toContain('model')
    await expect(deviceB.secrets.get('provider:acme')).resolves.toBe(secret)
  })

  it('migrates v1 plaintext cloud data through an encrypted archive and merges it locally', async () => {
    const server = new FakeSyncServer()
    server.legacyDocuments = [
      {
        workspaceId: 0, kind: 'provider', entityId: 'legacy-cloud', revision: 3,
        updatedAt: '2026-01-01T00:00:00Z', updatedByDeviceId: 'old-device',
        payload: { id: 'legacy-cloud', name: 'Legacy Cloud', protocol: 'anthropic', baseUrl: 'https://legacy.invalid', priority: 5, enabled: true }
      },
      {
        workspaceId: 0, kind: 'modelAlias', entityId: 'legacy-cloud/legacy-model', revision: 3,
        updatedAt: '2026-01-01T00:00:00Z', updatedByDeviceId: 'old-device',
        payload: {
          alias: 'legacy-model', providerId: 'legacy-cloud', upstreamModel: 'legacy-model',
          capabilities: { tools: true, vision: false, thinking: false, caching: false },
          contextWindow: 8192, maxOutputTokens: 2048
        }
      },
      {
        workspaceId: 0, kind: 'appPreferences', entityId: 'global', revision: 2,
        updatedAt: '2025-12-01T00:00:00Z', updatedByDeviceId: 'old-device',
        payload: { theme: 'dark' }
      }
    ]
    server.legacyEvents = [
      { cursor: 1, workspaceId: 0, kind: 'provider', entityId: 'legacy-cloud', operation: 'upsert', payload: {}, revision: 3, createdAt: '2026-01-01T00:00:00Z', deviceId: 'old-device', mutationId: '00000000-0000-4000-8000-000000000001' }
    ]

    const deviceA = openDevice(server)
    await deviceA.secrets.set('nextcowork:client-access-token', 'account-access-a')
    putProvider()
    await deviceA.secrets.set('provider:acme', secret)
    startConfigSync('1')
    const status = await setupConfigSync({ password, remember: true })

    // v1 明文已被归档替换删除
    expect(server.legacyDocuments).toEqual([])
    expect(server.legacyEvents).toEqual([])
    expect(server.resources.size).toBeGreaterThan(0)
    // 归档与提交请求里没有任何 v1 明文原文
    expect(server.requestBodies.join('\n')).not.toContain('https://legacy.invalid')
    expect(server.requestBodies.join('\n')).not.toContain('legacy-model')
    // 本机并入旧云 provider/alias(本机 acme 同步保留)
    expect(repo.listProviders().map((provider) => provider.id)).toContain('legacy-cloud')
    expect(repo.listAliases().map((alias) => alias.alias)).toContain('legacy-model')
    await expect(deviceA.secrets.get('provider:acme')).resolves.toBe(secret)
    // 迁移完成后不再显示阻塞,首个 v2 快照已推送
    expect(status.control?.errorCode).toBeNull()
    expect(server.current?.kind).toBe('providers')
    shutdownConfigSync()

    // 第二台设备直接进入 v2 世界,无需再迁移
    const deviceB = openDevice(server)
    await deviceB.secrets.set('nextcowork:client-access-token', 'account-access-b')
    startConfigSync('1')
    const unlocked = await setupConfigSync({ password, remember: false })
    expect(unlocked.control?.phase).toBe('review')
    await confirmInitialConfigSync()
    expect(repo.listProviders().map((provider) => provider.id)).toContain('legacy-cloud')
    await expect(deviceB.secrets.get('provider:acme')).resolves.toBe(secret)
  })

  it('rejects a wrong sync password before registering or applying credentials', async () => {
    const server = new FakeSyncServer()
    const deviceA = openDevice(server)
    await deviceA.secrets.set('nextcowork:client-access-token', 'access-a')
    putProvider()
    await deviceA.secrets.set('provider:acme', secret)
    startConfigSync('1')
    await setupConfigSync({ password, remember: true })
    shutdownConfigSync()

    const deviceB = openDevice(server)
    await deviceB.secrets.set('nextcowork:client-access-token', 'access-b')
    startConfigSync('1')
    await expect(setupConfigSync({ password: 'wrong password 2026', remember: false }))
      .rejects.toThrow('configSync.password')
    expect(repo.listProviders()).toEqual([])
    await expect(deviceB.secrets.get('provider:acme')).resolves.toBeNull()
  })
})
