import { describe, expect, it } from 'vitest'
import { listOpencodeMcp, listOpencodeProviders, parseJsonc } from '../opencode'
import { mapOpencodeProvider, protocolFromNpm, type OpencodeProviderConfig } from '../opencode-provider'
import { parseOpencodeSession } from '../opencode-transcript'
import type { OpencodeRawSession } from '../opencode'

describe('OpenCode import primitives', () => {
  it('strips JSONC comments and trailing commas without eating URL slashes', () => {
    const parsed = parseJsonc(`{
      // 行注释
      "$schema": "https://opencode.ai/config.json",
      "provider": { "a": { "npm": "@ai-sdk/anthropic" }, }, /* 块注释 */
    }`) as Record<string, unknown>
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json')
    expect(((parsed['provider'] as Record<string, Record<string, unknown>>)['a'])?.['npm']).toBe('@ai-sdk/anthropic')
  })

  it('infers protocol from the npm driver', () => {
    expect(protocolFromNpm('@ai-sdk/anthropic')).toBe('anthropic')
    expect(protocolFromNpm('@ai-sdk/openai-compatible')).toBe('openai-chat')
    expect(protocolFromNpm('@ai-sdk/openai')).toBe('openai-responses')
    expect(protocolFromNpm('@ai-sdk/google')).toBeNull()
  })

  it('normalizes providers without carrying the inline api key', () => {
    const providers = listOpencodeProviders(
      {
        provider: {
          'routin-anthropic': {
            name: 'Routin Anthropic',
            npm: '@ai-sdk/anthropic',
            models: { 'claude-opus-4-8': { name: 'claude-opus-4-8' } },
            options: { baseURL: 'https://api.routin.ai/v1', apiKey: 'ak-secret-value' }
          }
        }
      },
      new Set<string>(),
      '/config/opencode.jsonc'
    )
    expect(providers).toHaveLength(1)
    const provider = providers[0] as OpencodeProviderConfig
    expect(provider.protocol).toBe('anthropic')
    expect(provider.baseUrl).toBe('https://api.routin.ai/v1')
    expect(provider.hasLocalKey).toBe(true)
    expect(provider.diagnostics.map((d) => d.code)).toContain('provider.needs-credentials')
    expect(JSON.stringify(provider)).not.toContain('ak-secret-value')

    const mapped = mapOpencodeProvider('opencode-source', provider)
    expect(mapped.provider.enabled).toBe(false)
    expect(mapped.provider.protocol).toBe('anthropic')
    expect(mapped.provider.credentialRef).not.toContain('ak-secret-value')
    expect(mapped.alias?.upstreamModel).toBe('claude-opus-4-8')
    expect(mapped.alias?.enabled).toBe(false)
  })

  it('normalizes remote and local mcp entries and drops disabled ones', () => {
    const mcp = listOpencodeMcp({
      mcp: {
        context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', headers: { context7_api_key: 'x' } },
        localtool: { type: 'local', command: ['node', 'server.js'], environment: { TOKEN: 'y' } },
        off: { type: 'remote', url: 'https://nope', enabled: false }
      }
    })
    expect(mcp['context7']).toMatchObject({ type: 'streamable-http', url: 'https://mcp.context7.com/mcp' })
    expect(mcp['localtool']).toMatchObject({ type: 'stdio', command: 'node', args: ['server.js'] })
    expect(mcp['off']).toBeUndefined()
  })

  it('maps opencode sessions into paired tool call/result messages', () => {
    const raw: OpencodeRawSession = {
      session: { id: 's1', projectId: 'global', directory: '/work', title: '', model: { providerID: 'routin-anthropic', modelID: 'claude-haiku' }, createdAt: 1, updatedAt: 5, archived: false, messageCount: 2 },
      messages: [
        { id: 'm1', data: { role: 'user' }, createdAt: 1 },
        { id: 'm2', data: { role: 'assistant' }, createdAt: 2 }
      ],
      parts: [
        { messageId: 'm1', data: { type: 'text', text: '当前系统是什么' }, createdAt: 1 },
        { messageId: 'm2', data: { type: 'reasoning', text: '让我查一下' }, createdAt: 2 },
        { messageId: 'm2', data: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'uname -a' }, output: 'Darwin' } }, createdAt: 3 },
        { messageId: 'm2', data: { type: 'text', text: '当前系统是 macOS' }, createdAt: 4 },
        { messageId: 'm2', data: { type: 'step-finish', tokens: {} }, createdAt: 5 }
      ]
    }
    const parsed = parseOpencodeSession(raw, { maxMessages: 100 })
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.cwd).toBe('/work')
    expect(parsed.title).toBe('当前系统是什么')
    expect(parsed.model).toBe('claude-haiku')
    expect(parsed.modelProvider).toBe('routin-anthropic')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0]?.role).toBe('user')
    expect(parsed.messages[1]?.role).toBe('assistant')
    expect(parsed.messages[1]?.parts.some((p) => p.type === 'tool_call' && p.callId === 'c1')).toBe(true)
    expect(parsed.messages[2]?.role).toBe('user')
    expect(parsed.messages[2]?.parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1' })
    expect(parsed.diagnostics.map((d) => d.code)).not.toContain('transcript.tool-pair-incomplete')
  })
})
