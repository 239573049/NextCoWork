import { describe, expect, it } from 'vitest'
import {
  applyRequestPatches,
  parseRequestPatches,
  RequestPatchError,
  validateRequestPatches
} from '../request-patch'

describe('request patch validation', () => {
  it('parses editor JSON and returns normalized rules', () => {
    const result = validateRequestPatches(`[
      { "op": "add", "path": "/temperature", "value": 0.2 },
      { "op": "remove", "path": "/metadata/private", "value": "ignored" }
    ]`)

    expect(result).toEqual({
      ok: true,
      patches: [
        { op: 'add', path: '/temperature', value: 0.2 },
        { op: 'remove', path: '/metadata/private' }
      ]
    })
  })

  it('reports document-level JSON and array errors', () => {
    expect(validateRequestPatches('{')).toEqual({
      ok: false,
      issues: [{ code: 'invalid_json', message: '请求 Patch 不是有效的 JSON。' }]
    })
    expect(validateRequestPatches({})).toEqual({
      ok: false,
      issues: [{ code: 'not_array', message: '请求 Patch 必须是 JSON 数组。' }]
    })
  })

  it('collects indexed rule errors instead of stopping at the first one', () => {
    const result = validateRequestPatches([
      null,
      { op: 'copy', path: '/temperature' },
      { op: 'replace', path: '/top_p' }
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code, index }) => ({ code, index }))).toEqual([
      { code: 'invalid_rule', index: 0 },
      { code: 'unsupported_operation', index: 1 },
      { code: 'missing_value', index: 2 }
    ])
  })

  it('rejects unknown rule fields', () => {
    const result = validateRequestPatches([
      { op: 'add', path: '/temperature', value: 0.2, comment: 'unsafe extension' }
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toMatchObject([{ code: 'invalid_rule', index: 0 }])
  })

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['function', () => undefined],
    ['Date', new Date('2026-01-01T00:00:00.000Z')]
  ])('rejects a non-JSON %s value', (_label, value) => {
    const result = validateRequestPatches([{ op: 'add', path: '/metadata/value', value }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toMatchObject([{ code: 'invalid_value', index: 0 }])
  })

  it('rejects cyclic values', () => {
    const value: { self?: unknown } = {}
    value.self = value
    const result = validateRequestPatches([{ op: 'add', path: '/metadata/value', value }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toMatchObject([{ code: 'invalid_value', index: 0 }])
  })

  it.each([
    ['__proto__', JSON.parse('{"safe":{"__proto__":{"polluted":true}}}')],
    ['constructor', { safe: { constructor: { polluted: true } } }],
    ['prototype inside an array', { safe: [{ prototype: { polluted: true } }] }],
    ['authorization', { safe: { authorization: 'Bearer secret' } }],
    ['headers inside an array', { safe: [{ headers: { 'x-api-key': 'secret' } }] }],
    ['url', { url: 'https://attacker.invalid' }],
    ['base_url', { base_url: 'https://attacker.invalid' }],
    ['api_key', { api_key: 'secret' }],
    ['model', { safe: { model: 'other-model' } }]
  ])('rejects nested forbidden key %s in a patch value', (_label, value) => {
    const patches = [{ op: 'add' as const, path: '/metadata/payload', value }]
    const result = validateRequestPatches(patches)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues).toMatchObject([{ code: 'invalid_value', index: 0 }])
    expect(() => applyRequestPatches({ metadata: {} }, patches)).toThrow(RequestPatchError)
  })

  it('allows dangerous-looking strings when they are values rather than object keys', () => {
    expect(validateRequestPatches([
      { op: 'add', path: '/metadata/label', value: '__proto__' }
    ])).toEqual({
      ok: true,
      patches: [{ op: 'add', path: '/metadata/label', value: '__proto__' }]
    })
  })

  it('provides a throwing parser for the runtime pipeline', () => {
    expect(() => parseRequestPatches('{')).toThrow(RequestPatchError)
    expect(() => parseRequestPatches([{ op: 'replace', path: '/temperature' }]))
      .toThrow(/缺少 value/u)
  })

  it('allows the official InternLM thinking_mode extension', () => {
    const patches = [{ op: 'add' as const, path: '/thinking_mode', value: true }]
    expect(validateRequestPatches(patches)).toEqual({ ok: true, patches })
    expect(applyRequestPatches({}, patches)).toEqual({ thinking_mode: true })
  })
})

describe('applyRequestPatches', () => {
  it('applies the allowed add/replace/remove subset without mutating input', () => {
    const input = { temperature: 0.5, metadata: { trace: 'old', removeMe: true } }
    const output = applyRequestPatches(input, [
      { op: 'replace', path: '/temperature', value: 0.2 },
      { op: 'replace', path: '/metadata/trace', value: 'new' },
      { op: 'remove', path: '/metadata/removeMe' },
      { op: 'add', path: '/top_p', value: 0.9 }
    ])
    expect(output).toEqual({ temperature: 0.2, metadata: { trace: 'new' }, top_p: 0.9 })
    expect(input).toEqual({ temperature: 0.5, metadata: { trace: 'old', removeMe: true } })
  })

  it.each([
    '/model',
    '/messages/0',
    '/stream',
    '/tools',
    '/headers/authorization',
    '/metadata/authorization',
    '/extra_body/url',
    '/extra_body/base_url',
    '/extra_body/api_key',
    '/metadata/__proto__/polluted',
    '/metadata/constructor/prototype',
    '/totally_unknown',
    '/temperature/'
  ])(
    'rejects protected path %s both before save and at runtime',
    (path) => {
      const patches = [{ op: 'add' as const, path, value: true }]
      const validation = validateRequestPatches(patches)
      expect(validation.ok).toBe(false)
      if (!validation.ok) expect(validation.issues).toMatchObject([{ code: 'invalid_path' }])
      expect(() => applyRequestPatches({}, patches)).toThrow(RequestPatchError)
    }
  )

  it('rejects non-whitelisted vendor fields and prototype-pollution segments', () => {
    expect(() => applyRequestPatches({}, [{ op: 'add', path: '/totally_unknown', value: 1 }]))
      .toThrow(/白名单/u)
    expect(() => applyRequestPatches({ metadata: {} }, [{ op: 'add', path: '/metadata/__proto__/polluted', value: true }]))
      .toThrow(/不允许/u)
  })

  it('rejects malformed JSON Pointer escaping before save and at runtime', () => {
    const patches = [{ op: 'add' as const, path: '/metadata/~2bad', value: true }]
    const validation = validateRequestPatches(patches)
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.issues).toMatchObject([{ code: 'invalid_path' }])
    expect(() => applyRequestPatches({}, patches)).toThrow(/非法转义/u)
  })

  it('implements strict replace/remove targets and applies atomically', () => {
    const input = { temperature: 0.5 }
    expect(() => applyRequestPatches(input, [
      { op: 'replace', path: '/temperature', value: 0.2 },
      { op: 'remove', path: '/top_p' }
    ])).toThrow(/目标不存在/u)
    expect(input).toEqual({ temperature: 0.5 })
  })

  it('supports JSON Pointer array add/replace/remove semantics', () => {
    const output = applyRequestPatches({ stop: ['a', 'b'] }, [
      { op: 'add', path: '/stop/1', value: 'x' },
      { op: 'replace', path: '/stop/0', value: 'z' },
      { op: 'remove', path: '/stop/2' },
      { op: 'add', path: '/stop/-', value: 'tail' }
    ])
    expect(output).toEqual({ stop: ['z', 'x', 'tail'] })
  })

  it('supports escaped JSON Pointer property names', () => {
    const output = applyRequestPatches({ metadata: { 'a/b': 1, 'm~n': 2 } }, [
      { op: 'replace', path: '/metadata/a~1b', value: 3 },
      { op: 'replace', path: '/metadata/m~0n', value: 4 }
    ])
    expect(output).toEqual({ metadata: { 'a/b': 3, 'm~n': 4 } })
  })

  it('turns an invalid runtime patch container into a domain error', () => {
    expect(() => applyRequestPatches({}, null as never)).toThrow(RequestPatchError)
  })
})
