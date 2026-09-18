/**
 * `providers` 端到端同步快照的安全边界。
 *
 * 用真实 SQLite + 两个独立 nodeHost secret store 模拟两台设备。这里不测 HTTP,
 * 只钉最容易回归的事实:密钥在加密前快照里与 provider 元数据分离、平台登录
 * token 不被复制、远端应用后目标设备拿到完全相同的 API Key/OAuth JSON。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from '../db'
import { switchConfigProfile } from '../db/config-profile'
import * as repo from '../db/repo'
import { nodeHost } from '../kernel/host'
import type { KernelHost } from '../kernel/host'
import { CLIENT_PROVIDER_ID } from '../../shared/domain/presets'
import {
  applyProviderSyncData,
  captureProviderSyncData,
  mergeProviderSyncData,
  parseProviderSyncData
} from '../config-sync-provider-snapshot'

let dir = ''
let source: KernelHost
let target: KernelHost

function provider(id: string, credentialRef = `provider:${id}`) {
  return {
    id,
    name: id,
    protocol: 'openai-chat' as const,
    baseUrl: `https://${id}.invalid/v1`,
    credentialRef,
    priority: 10,
    enabled: true
  }
}

beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-sync-provider-'))
  openDatabase(dir)
  source = nodeHost()
  target = nodeHost()
})

afterEach(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('encrypted provider snapshot', () => {
  it('captures API keys without credentialRef and excludes platform login identity', async () => {
    switchConfigProfile('account-a')
    repo.putProvider(provider('acme', 'legacy:custom-ref'))
    repo.putProvider(provider(CLIENT_PROVIDER_ID, 'nextcowork:client-access-token'))
    repo.putAlias({
      alias: 'model', providerId: 'acme', upstreamModel: 'model',
      capabilities: { tools: true, vision: false, thinking: false, caching: false },
      contextWindow: 4096, maxOutputTokens: 1024
    })
    await source.secrets.set('legacy:custom-ref', 'sk-account-a')
    await source.secrets.set('nextcowork:client-access-token', 'platform-login-jwt')

    const snapshot = await captureProviderSyncData(source)
    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]?.id).toBe('acme')
    expect(snapshot.providers[0]).not.toHaveProperty('credentialRef')
    expect(snapshot.credentials).toEqual({ acme: 'sk-account-a' })
    expect(JSON.stringify(snapshot)).not.toContain('platform-login-jwt')
    expect(JSON.stringify(snapshot)).not.toContain('nextcowork:client-access-token')
  })

  it('re-derives local refs and re-encrypts API key/OAuth values into the target host', async () => {
    switchConfigProfile('account-b')
    repo.putProvider(provider('old'))
    await target.secrets.set('provider:old', 'stale-key')

    const oauth = JSON.stringify({
      kind: 'oauth', issuer: 'chatgpt', accessToken: 'access', refreshToken: 'refresh',
      expiresAt: null, accountId: 'account'
    })
    await applyProviderSyncData(target, {
      providers: [
        { id: 'acme', name: 'Acme', protocol: 'openai-chat', baseUrl: 'https://acme.invalid/v1', priority: 1, enabled: true },
        { id: 'oauth', name: 'OAuth', protocol: 'anthropic', baseUrl: 'https://oauth.invalid', priority: 2, enabled: true }
      ],
      aliases: [],
      credentials: { acme: 'sk-remote', oauth }
    })

    expect(repo.listProviders().map((item) => [item.id, item.credentialRef])).toEqual([
      ['acme', 'provider:acme'],
      ['oauth', 'provider:oauth']
    ])
    await expect(target.secrets.get('provider:acme')).resolves.toBe('sk-remote')
    await expect(target.secrets.get('provider:oauth')).resolves.toBe(oauth)
    await expect(target.secrets.get('provider:old')).resolves.toBeNull()
  })

  it('merges first-sync snapshots with local provider and credential values winning same-id conflicts', () => {
    const merged = mergeProviderSyncData(
      {
        providers: [
          { id: 'same', name: 'Remote', protocol: 'openai-chat', baseUrl: 'https://remote.invalid', priority: 1, enabled: true },
          { id: 'remote-only', name: 'Remote only', protocol: 'anthropic', baseUrl: 'https://remote-only.invalid', priority: 2, enabled: true }
        ],
        aliases: [],
        credentials: { same: 'remote-key', 'remote-only': 'remote-only-key' }
      },
      {
        providers: [
          { id: 'same', name: 'Local', protocol: 'openai-chat', baseUrl: 'https://local.invalid', priority: 3, enabled: true }
        ],
        aliases: [],
        credentials: { same: 'local-key' }
      }
    )
    expect(merged.providers.map((item) => [item.id, item.name])).toEqual([
      ['same', 'Local'],
      ['remote-only', 'Remote only']
    ])
    expect(merged.credentials).toEqual({ same: 'local-key', 'remote-only': 'remote-only-key' })
    expect(JSON.stringify(merged.providers)).not.toContain('credentialRef')
  })

  it('rejects credential refs, unknown credential owners and malformed providers before touching storage', async () => {
    expect(() => parseProviderSyncData({
      providers: [{ ...provider('acme'), credentialRef: 'provider:other' }],
      aliases: [], credentials: { other: 'sk-leak' }
    })).toThrow('供应商记录无效')

    await expect(applyProviderSyncData(target, {
      providers: [{ id: 'bad', name: 'Bad', protocol: 'openai-chat', baseUrl: 'file:///etc/passwd', priority: 1, enabled: true }],
      aliases: [], credentials: {}
    })).rejects.toThrow('供应商记录无效')
    expect(repo.listProviders()).toEqual([])
  })
})
