import { describe, expect, it } from 'vitest'
import { mapCodexHook } from '../codex-hooks'
import { parseCodexToml } from '../codex'
import { mapCodexProvider } from '../codex-provider'
import { parseCodexTranscript } from '../codex-transcript'

describe('Codex import primitives', () => {
  it('parses provider tables without evaluating auth or environment values', () => {
    const parsed = parseCodexToml(`model = "gpt-5-codex"\n[model_providers.demo]\nname = "Demo"\nbase_url = "https://api.example.test/v1"\nwire_api = "responses"\nenv_key = "DEMO_KEY"\n[model_providers.demo.auth]\ncommand = "cat ~/.secret"`) as Record<string, unknown>
    const providers = parsed['model_providers'] as Record<string, Record<string, unknown>>
    expect(parsed['model']).toBe('gpt-5-codex')
    expect(providers['demo']?.['base_url']).toBe('https://api.example.test/v1')
    expect((providers['demo']?.['auth'] as Record<string, unknown>)?.['command']).toBe('cat ~/.secret')
    const mapped = mapCodexProvider('codex-source', {
      id: 'demo', profile: 'default', sourcePath: '/tmp/config.toml', name: 'Demo',
      baseUrl: 'https://api.example.test/v1', wireApi: 'responses', defaultModel: 'gpt-5-codex',
      envKey: 'DEMO_KEY', unsupportedOptions: [], diagnostics: [{ code: 'provider.needs-credentials', detail: 'DEMO_KEY' }], fingerprint: 'source'
    })
    expect(mapped.provider.enabled).toBe(false)
    expect(mapped.provider.credentialRef).not.toContain('DEMO_KEY')
    expect(mapped.alias?.upstreamModel).toBe('gpt-5-codex')
  })

  it('keeps unsupported Codex hooks disabled and reviewable', () => {
    const mapped = mapCodexHook('source', {
      event: 'PermissionRequest', matcher: 'dangerous.*', command: 'python3 hook.py', handlerType: 'command',
      sourcePath: '/tmp/hooks.json', scope: 'global', sourceKey: 'permission'
    })
    expect(mapped.hook).toBeUndefined()
    expect(mapped.diagnostics.map((item) => item.code)).toContain('hook.unsupported-event')
  })

  it('maps command hooks with seconds converted to milliseconds', () => {
    const mapped = mapCodexHook('source', {
      event: 'PreToolUse', matcher: '^Bash$', command: 'python3 hook.py', handlerType: 'command', timeout: 30,
      sourcePath: '/tmp/hooks.json', scope: 'global', sourceKey: 'bash'
    })
    expect(mapped.hook?.enabled).toBe(false)
    expect(mapped.hook?.timeoutMs).toBe(30_000)
    expect(mapped.hook?.matcher).toBe('Bash')
  })

  it('imports visible user and assistant Codex response items only', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({ type: 'session_meta', payload: { session_id: 's1', cwd: '/work', model_provider: 'demo', timestamp: '2026-09-12T00:00:00Z' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'hello' }, id: 'm1' }),
      JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }, id: 'm2' }),
      JSON.stringify({ type: 'developer', payload: { role: 'developer', content: 'internal' } })
    ], { fallbackSessionId: 'fallback', maxMessages: 20 })
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.cwd).toBe('/work')
    expect(parsed.modelProvider).toBe('demo')
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]?.role).toBe('user')
    expect(parsed.diagnostics.map((item) => item.code)).toContain('transcript.developer-content-skipped')
  })

  it('normalizes function calls and outputs without executing them', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({ type: 'function_call', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"pwd"}' }, id: 'm1' }),
      JSON.stringify({ type: 'function_call_output', payload: { type: 'function_call_output', call_id: 'c1', output: '/work' }, id: 'm2' })
    ], { fallbackSessionId: 'fallback', maxMessages: 20 })
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]?.parts[0]).toMatchObject({ type: 'tool_call', callId: 'c1', name: 'shell' })
    expect(parsed.messages[1]?.role).toBe('user')
    expect(parsed.messages[1]?.parts[0]).toMatchObject({ type: 'tool_result', callId: 'c1' })
  })
})
