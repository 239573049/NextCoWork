import type { RequestAdapterConfig, RequestPatchRule, UpstreamProtocol } from './provider'

export type RequestPatchPreset = RequestAdapterConfig['preset'] | UpstreamProtocol

export class RequestPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestPatchError'
  }
}

export type RequestPatchValidationCode =
  | 'invalid_json'
  | 'not_array'
  | 'invalid_rule'
  | 'unsupported_operation'
  | 'invalid_path'
  | 'missing_value'
  | 'invalid_value'

export interface RequestPatchValidationIssue {
  code: RequestPatchValidationCode
  /** Index in the patch array; absent for a document-level parse error. */
  index?: number
  message: string
}

export type RequestPatchValidationResult =
  | { ok: true; patches: RequestPatchRule[] }
  | { ok: false; issues: RequestPatchValidationIssue[] }

class RequestPatchValidationFailure extends Error {
  constructor(readonly validationIssue: RequestPatchValidationIssue) {
    super(validationIssue.message)
    this.name = 'RequestPatchValidationFailure'
  }
}

/**
 * Top-level body parameters which a model adapter may customize.  This list
 * intentionally contains common vendor extensions, but never transport,
 * credentials, model selection, messages, streaming, or tool definitions.
 */
const COMMON_ALLOWED_ROOTS = new Set([
  'cache_control',
  'chat_template_kwargs',
  'enable_thinking',
  'extra_body',
  'frequency_penalty',
  'include',
  'logprobs',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'metadata',
  'output_config',
  'parallel_tool_calls',
  'presence_penalty',
  'reasoning',
  'reasoning_effort',
  'reasoning_split',
  'response_format',
  'seed',
  'service_tier',
  'stop',
  'stop_sequences',
  'store',
  'system',
  'temperature',
  'thinking',
  'thinking_budget',
  'thinking_mode',
  'tool_choice',
  'top_k',
  'top_logprobs',
  'top_p',
  'user',
  'verbosity'
])

const FORBIDDEN_SEGMENTS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'model',
  'messages',
  'stream',
  'tools',
  'authorization',
  'authentication',
  'auth',
  'api_key',
  'apikey',
  'api-key',
  'x-api-key',
  'x_api_key',
  'credential',
  'credentials',
  'headers',
  'header',
  'http_headers',
  'url',
  'base_url',
  'baseurl',
  'access_token'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function decodePointer(path: string): string[] {
  if (path === '' || !path.startsWith('/')) {
    throw new RequestPatchError(`请求 Patch 路径必须是非空 JSON Pointer: ${path}`)
  }
  return path.slice(1).split('/').map((raw) => {
    if (/~(?![01])/u.test(raw)) {
      throw new RequestPatchError(`请求 Patch 路径包含非法转义: ${path}`)
    }
    return raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
  })
}

function assertAllowedPath(path: string, parts: readonly string[]): void {
  const first = parts[0]
  if (first === undefined || first === '' || !COMMON_ALLOWED_ROOTS.has(first)) {
    throw new RequestPatchError(`请求 Patch 路径不在允许的参数白名单中: ${path}`)
  }
  const forbidden = parts.find((part) => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))
  if (forbidden !== undefined) {
    throw new RequestPatchError(`请求 Patch 路径不允许修改「${forbidden}」: ${path}`)
  }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!Array.isArray(value) && !isRecord(value)) return false
  if (ancestors.has(value)) return false

  ancestors.add(value)
  const isValid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.entries(value).every(
        ([key, item]) =>
          // Replacing an allowed container must not bypass the exact same
          // segment policy (for example `/metadata` with an `authorization`
          // key, or `/extra_body` with an `api_key` key in its value).
          !FORBIDDEN_SEGMENTS.has(key.toLowerCase()) && isJsonValue(item, ancestors)
      )
  ancestors.delete(value)
  return isValid
}

function issue(
  code: RequestPatchValidationCode,
  message: string,
  index?: number
): RequestPatchValidationIssue {
  return index === undefined ? { code, message } : { code, index, message }
}

function normalizeRule(value: unknown, index: number): RequestPatchRule {
  if (!isRecord(value)) {
    throw new RequestPatchValidationFailure(
      issue('invalid_rule', `第 ${String(index + 1)} 条请求 Patch 必须是对象。`, index)
    )
  }
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'op' && key !== 'path' && key !== 'value')) {
    throw new RequestPatchValidationFailure(
      issue('invalid_rule', `第 ${String(index + 1)} 条请求 Patch 包含未知字段。`, index)
    )
  }

  const op = value['op']
  if (op !== 'add' && op !== 'replace' && op !== 'remove') {
    throw new RequestPatchValidationFailure(
      issue(
        'unsupported_operation',
        `第 ${String(index + 1)} 条请求 Patch 操作不支持: ${String(op)}`,
        index
      )
    )
  }
  const path = value['path']
  if (typeof path !== 'string') {
    throw new RequestPatchValidationFailure(
      issue(
        'invalid_path',
        `第 ${String(index + 1)} 条请求 Patch 路径必须是字符串。`,
        index
      )
    )
  }
  try {
    const parts = decodePointer(path)
    if (parts.at(-1) === '') {
      throw new RequestPatchError(`请求 Patch 路径不能以空段结尾: ${path}`)
    }
    assertAllowedPath(path, parts)
  } catch (error) {
    throw new RequestPatchValidationFailure(
      issue(
        'invalid_path',
        error instanceof Error ? error.message : String(error),
        index
      )
    )
  }

  if (op !== 'remove' && !Object.hasOwn(value, 'value')) {
    throw new RequestPatchValidationFailure(
      issue(
        'missing_value',
        `第 ${String(index + 1)} 条请求 Patch 的 ${op} 操作缺少 value。`,
        index
      )
    )
  }
  if (op !== 'remove' && !isJsonValue(value['value'])) {
    throw new RequestPatchValidationFailure(
      issue(
        'invalid_value',
        `第 ${String(index + 1)} 条请求 Patch 的 value 必须是有效 JSON 值。`,
        index
      )
    )
  }

  return op === 'remove'
    ? { op, path }
    : { op, path, value: structuredClone(value['value']) }
}

/**
 * Parse and validate either editor JSON text or an already-parsed value.
 * This is the renderer-safe, side-effect-free entry point. Runtime application
 * calls the same normalizer, so save-time and send-time security rules cannot
 * drift apart.
 */
export function validateRequestPatches(input: unknown): RequestPatchValidationResult {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      return {
        ok: false,
        issues: [issue('invalid_json', '请求 Patch 不是有效的 JSON。')]
      }
    }
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      issues: [issue('not_array', '请求 Patch 必须是 JSON 数组。')]
    }
  }

  const patches: RequestPatchRule[] = []
  const issues: RequestPatchValidationIssue[] = []
  value.forEach((item, index) => {
    try {
      patches.push(normalizeRule(item, index))
    } catch (error) {
      if (error instanceof RequestPatchValidationFailure) {
        issues.push(error.validationIssue)
      } else {
        issues.push(issue('invalid_rule', String(error), index))
      }
    }
  })
  return issues.length === 0 ? { ok: true, patches } : { ok: false, issues }
}

/** Throwing counterpart used by the request pipeline. */
export function parseRequestPatches(input: unknown): RequestPatchRule[] {
  const result = validateRequestPatches(input)
  if (result.ok) return result.patches
  throw new RequestPatchError(result.issues.map((item) => item.message).join('\n'))
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
    throw new RequestPatchError(`请求 Patch 数组下标无效: ${segment}`)
  }
  const index = Number(segment)
  const upper = allowEnd ? length : length - 1
  if (!Number.isSafeInteger(index) || index < 0 || index > upper) {
    throw new RequestPatchError(`请求 Patch 数组下标越界: ${segment}`)
  }
  return index
}

type Container = Record<string, unknown> | unknown[]

function parentAt(root: Record<string, unknown>, parts: readonly string[], path: string): Container {
  let cursor: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      cursor = cursor[arrayIndex(part, cursor.length, false)]
    } else if (isRecord(cursor) && Object.hasOwn(cursor, part)) {
      cursor = cursor[part]
    } else {
      throw new RequestPatchError(`请求 Patch 父路径不存在: ${path}`)
    }
    if (!isRecord(cursor) && !Array.isArray(cursor)) {
      throw new RequestPatchError(`请求 Patch 父路径不是对象或数组: ${path}`)
    }
  }
  return cursor as Container
}

function applyOne(root: Record<string, unknown>, patch: RequestPatchRule): void {
  const parts = decodePointer(patch.path)
  assertAllowedPath(patch.path, parts)
  const key = parts.at(-1)
  if (key === undefined || key === '') throw new RequestPatchError(`请求 Patch 路径为空: ${patch.path}`)
  const parent = parentAt(root, parts, patch.path)

  if (Array.isArray(parent)) {
    if (patch.op === 'add') {
      if (key === '-') parent.push(patch.value)
      else parent.splice(arrayIndex(key, parent.length, true), 0, patch.value)
      return
    }
    const index = arrayIndex(key, parent.length, false)
    if (patch.op === 'remove') parent.splice(index, 1)
    else parent[index] = patch.value
    return
  }

  if (patch.op === 'add') {
    parent[key] = patch.value
    return
  }
  if (!Object.hasOwn(parent, key)) {
    throw new RequestPatchError(`请求 Patch 的 ${patch.op} 目标不存在: ${patch.path}`)
  }
  if (patch.op === 'remove') delete parent[key]
  else parent[key] = patch.value
}

/**
 * Atomically apply the deliberately limited JSON Patch subset. The input is
 * cloned first, so any failure leaves the original request body untouched.
 */
export function applyRequestPatches(
  body: unknown,
  patches: readonly RequestPatchRule[] | undefined,
  _preset: RequestPatchPreset = 'auto'
): unknown {
  if (patches === undefined) return body
  const normalizedPatches = parseRequestPatches(patches)
  if (normalizedPatches.length === 0) return body
  if (!isRecord(body)) throw new RequestPatchError('请求体必须是 JSON 对象。')

  const root = structuredClone(body)
  for (const patch of normalizedPatches) applyOne(root, patch)
  return root
}
