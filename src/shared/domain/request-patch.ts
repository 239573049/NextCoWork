import type { RequestAdapterConfig, RequestPatchRule, UpstreamProtocol } from './provider'

export type RequestPatchPreset = RequestAdapterConfig['preset'] | UpstreamProtocol

export class RequestPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestPatchError'
  }
}

/**
 * Top-level body parameters which a model adapter may customize.  This list
 * intentionally contains common vendor extensions, but never transport,
 * credentials, model selection, messages, streaming, or tool definitions.
 */
const COMMON_ALLOWED_ROOTS = new Set([
  'cache_control',
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
  'api_key',
  'apikey',
  'headers',
  'url',
  'base_url'
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
  if (patch.op !== 'add' && patch.op !== 'replace' && patch.op !== 'remove') {
    throw new RequestPatchError(`请求 Patch 操作不支持: ${String(patch.op)}`)
  }
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
  if (patches === undefined || patches.length === 0) return body
  if (!Array.isArray(patches)) throw new RequestPatchError('请求 Patch 必须是数组。')
  if (!isRecord(body)) throw new RequestPatchError('请求体必须是 JSON 对象。')

  const root = structuredClone(body)
  for (const patch of patches) applyOne(root, patch)
  return root
}
