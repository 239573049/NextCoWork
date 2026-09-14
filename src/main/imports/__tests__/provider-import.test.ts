import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listClaudeProviders } from '../claude-code'
import { collectImportableProviders } from '../provider-import'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ncw-provimport-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true })
})

describe('importable providers', () => {
  it('parses a custom Anthropic endpoint from Claude Code settings.json without reading the token', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test/v1',
          ANTHROPIC_AUTH_TOKEN: 'sk-super-secret-token',
          ANTHROPIC_DEFAULT_MODEL: 'claude-opus-4-8'
        }
      })
    )
    const providers = await listClaudeProviders(dir)
    expect(providers).toHaveLength(1)
    expect(providers[0]?.baseUrl).toBe('https://gateway.example.test/v1')
    expect(providers[0]?.defaultModel).toBe('claude-opus-4-8')
    expect(providers[0]?.hasLocalKey).toBe(true)
    expect(JSON.stringify(providers)).not.toContain('sk-super-secret-token')
  })

  it('returns nothing when Claude Code has no custom base URL', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }))
    expect(await listClaudeProviders(dir)).toEqual([])
  })

  it('normalizes a Codex provider (wire_api → protocol) and never carries secret values', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, 'config.toml'),
      [
        'model = "gpt-5-codex"',
        'model_provider = "demo"',
        '[model_providers.demo]',
        'name = "Demo"',
        'base_url = "https://api.example.test/v1"',
        'wire_api = "chat"',
        'env_key = "DEMO_KEY"',
        '[model_providers.demo.auth]',
        'command = "cat ~/.secret-token-file"'
      ].join('\n')
    )
    const previous = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = dir
    try {
      const result = await collectImportableProviders('codex')
      expect(result.available).toBe(true)
      const demo = result.providers.find((p) => p.name === 'Demo')
      expect(demo?.protocol).toBe('openai-chat')
      expect(demo?.baseUrl).toBe('https://api.example.test/v1')
      expect(demo?.hasLocalKey).toBe(true)
      // ★ 源侧的 auth 命令是密钥入口 —— 归一结果里一个字都不能出现。
      expect(JSON.stringify(result)).not.toContain('secret-token-file')
    } finally {
      if (previous === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = previous
    }
  })

  it('reports a source that is not present as unavailable with no providers', async () => {
    const previous = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = join(tmpdir(), 'ncw-nonexistent-codex-home')
    try {
      const result = await collectImportableProviders('codex')
      expect(result.available).toBe(false)
      expect(result.providers).toEqual([])
    } finally {
      if (previous === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = previous
    }
  })
})
