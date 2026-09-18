import { describe, expect, it } from 'vitest'
import { normalizeOpencoworkMcp } from '../opencowork'
import type { OpencoworkRawSession } from '../opencowork'
import { mapOpencoworkProvider, protocolFromProviderType, type OpencoworkProviderConfig } from '../opencowork-provider'
import { mapOpencoworkHook } from '../opencowork-hooks'
import { parseOpencoworkSession } from '../opencowork-transcript'

describe('OpenCoWork import primitives', () => {
  it('maps the shared protocol names 1:1 and rejects media-generation types', () => {
    expect(protocolFromProviderType('anthropic')).toBe('anthropic')
    expect(protocolFromProviderType('openai-chat')).toBe('openai-chat')
    expect(protocolFromProviderType('openai-responses')).toBe('openai-responses')
    expect(protocolFromProviderType('openai-images')).toBeNull()
    expect(protocolFromProviderType(undefined)).toBeNull()
  })

  it('maps a provider without carrying the api key value', () => {
    const provider: OpencoworkProviderConfig = {
      id: 'routin', sourcePath: '/tmp/provider-routin.json', name: 'Routin', protocol: 'anthropic',
      baseUrl: 'https://api.routin.ai/v1', models: ['claude-opus-4-8'], defaultModel: 'claude-opus-4-8',
      hasLocalKey: true, diagnostics: [{ code: 'provider.needs-credentials' }], fingerprint: 'fp'
    }
    expect(JSON.stringify(provider)).not.toContain('sk-secret')
    const mapped = mapOpencoworkProvider('opencowork-source', provider)
    expect(mapped.provider.enabled).toBe(false)
    expect(mapped.provider.protocol).toBe('anthropic')
    expect(mapped.provider.credentialRef).not.toContain('sk-secret')
    expect(mapped.alias?.upstreamModel).toBe('claude-opus-4-8')
    expect(mapped.alias?.enabled).toBe(false)
  })

  it('normalizes stdio/sse mcp entries and drops disabled ones', () => {
    const mcp = normalizeOpencoworkMcp([
      { id: '1', name: 'local-tool', enabled: true, transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      { id: '2', name: 'remote', enabled: true, transport: 'sse', url: 'https://mcp.example.test/sse', headers: { Authorization: 'y' } },
      { id: '3', name: 'off', enabled: false, transport: 'stdio', command: 'node' }
    ])
    expect(mcp['local-tool']).toMatchObject({ type: 'stdio', command: 'node', args: ['server.js'] })
    expect(mcp['remote']).toMatchObject({ type: 'sse', url: 'https://mcp.example.test/sse' })
    expect(mcp['off']).toBeUndefined()
  })

  it('keeps unsupported OpenCoWork hook events disabled and reviewable', () => {
    const mapped = mapOpencoworkHook('source', {
      event: 'SessionStart', command: 'python3 hook.py', handlerType: 'command',
      sourcePath: '/tmp/hooks.json', hasEnv: false, sourceKey: 'SessionStart:0:0'
    })
    expect(mapped.hook).toBeUndefined()
    expect(mapped.diagnostics.map((d) => d.code)).toContain('hook.unsupported-event')
  })

  it('maps a supported hook with seconds converted to milliseconds', () => {
    const mapped = mapOpencoworkHook('source', {
      event: 'PreToolUse', matcher: 'Bash', command: 'python3 hook.py', handlerType: 'command', timeout: 30,
      sourcePath: '/tmp/hooks.json', hasEnv: false, sourceKey: 'PreToolUse:0:0'
    })
    expect(mapped.hook?.enabled).toBe(false)
    expect(mapped.hook?.timeoutMs).toBe(30_000)
    expect(mapped.hook?.matcher).toBe('Bash')
  })

  it('flags hooks that rely on handler env vars instead of silently dropping them', () => {
    const mapped = mapOpencoworkHook('source', {
      event: 'Stop', command: 'python3 hook.py', handlerType: 'command',
      sourcePath: '/tmp/hooks.json', hasEnv: true, sourceKey: 'Stop:0:0'
    })
    expect(mapped.hook).toBeUndefined()
    expect(mapped.diagnostics.map((d) => d.code)).toContain('hook.unsupported-handler')
  })

  it('rejects a matcher on an event that has no tool/args to match against', () => {
    const mapped = mapOpencoworkHook('source', {
      event: 'Stop', matcher: 'Bash', command: 'python3 hook.py', handlerType: 'command',
      sourcePath: '/tmp/hooks.json', hasEnv: false, sourceKey: 'Stop:0:0'
    })
    expect(mapped.hook).toBeUndefined()
    expect(mapped.diagnostics.map((d) => d.code)).toContain('hook.matcher-needs-review')
  })

  it('maps a session with paired tool_use/tool_result blocks into assistant/user messages, keeping the real session title', () => {
    const raw: OpencoworkRawSession = {
      session: { id: 's1', title: '排查系统信息', workingFolder: '/work', providerId: 'routin', modelId: 'claude-haiku', createdAt: 1, updatedAt: 5, messageCount: 2 },
      messages: [
        { id: 'm1', role: 'user', content: '当前系统是什么', createdAt: 1 },
        {
          id: 'm2',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '让我查一下' },
            { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'uname -a' } },
            { type: 'text', text: '当前系统是 macOS' }
          ],
          createdAt: 2
        },
        { id: 'm3', role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'Darwin', isError: false }], createdAt: 3 }
      ]
    }
    const parsed = parseOpencoworkSession(raw, { maxMessages: 100 })
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.cwd).toBe('/work')
    expect(parsed.title).toBe('排查系统信息')
    expect(parsed.model).toBe('claude-haiku')
    expect(parsed.modelProvider).toBe('routin')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0]?.role).toBe('user')
    expect(parsed.messages[1]?.role).toBe('assistant')
    expect(parsed.messages[1]?.parts.some((p) => p.type === 'thinking')).toBe(true)
    expect(parsed.messages[1]?.parts.some((p) => p.type === 'tool_call' && p.callId === 'c1')).toBe(true)
    expect(parsed.messages[2]?.role).toBe('user')
    expect(parsed.messages[2]?.parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1' })
    expect(parsed.diagnostics.map((d) => d.code)).not.toContain('transcript.tool-pair-incomplete')
  })

  it('falls back to the running startedAt instead of the epoch when a message has no timestamp', () => {
    const raw: OpencoworkRawSession = {
      session: { id: 's3', title: '', workingFolder: '/work', createdAt: 1, updatedAt: 1, messageCount: 2 },
      messages: [
        { id: 'm1', role: 'user', content: 'first', createdAt: 1000 },
        { id: 'm2', role: 'assistant', content: 'second', createdAt: 0 }
      ]
    }
    const parsed = parseOpencoworkSession(raw, { maxMessages: 100 })
    expect(parsed.startedAt).toBe(1000)
    expect(parsed.messages[1]?.createdAt).toBe(1000)
  })

  it('keeps an external-url image visible as a text placeholder instead of dropping the whole message', () => {
    const raw: OpencoworkRawSession = {
      session: { id: 's4', title: '', workingFolder: '/work', createdAt: 1, updatedAt: 1, messageCount: 1 },
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/pic.png' } }], createdAt: 1 }
      ]
    }
    const parsed = parseOpencoworkSession(raw, { maxMessages: 100 })
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]?.parts[0]).toMatchObject({ type: 'text' })
    expect(parsed.diagnostics.map((d) => d.code)).toContain('attachment.external-url')
  })

  it('downgrades an orphaned tool_use and skips system rows', () => {
    const raw: OpencoworkRawSession = {
      session: { id: 's2', title: '', workingFolder: '/work', createdAt: 1, updatedAt: 2, messageCount: 2 },
      messages: [
        { id: 'sys', role: 'system', content: 'internal setup', createdAt: 1 },
        { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'bash', input: {} }], createdAt: 2 }
      ]
    }
    const parsed = parseOpencoworkSession(raw, { maxMessages: 100 })
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]?.parts[0]).toMatchObject({ type: 'text' })
    expect(parsed.diagnostics.map((d) => d.code)).toContain('transcript.developer-content-skipped')
    expect(parsed.diagnostics.map((d) => d.code)).toContain('transcript.tool-pair-incomplete')
  })
})
