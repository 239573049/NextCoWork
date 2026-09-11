/**
 * `.next-cowork/settings.local.json` 的读写 —— 结构与语义在
 * `shared/domain/local-settings.ts`,这里只有 IO、缓存和并发。
 *
 * ★ 走 `KernelFs` 而不是 `node:fs`:这个模块住在 kernel 里,而 kernel 的
 * 「零 electron、可在普通 Node 里单测」那条约束是靠端口维持的。
 */
import { join } from 'node:path'
import {
  LOCAL_SETTINGS_DIRNAME, LOCAL_SETTINGS_FILENAME, LOCAL_SETTINGS_VERSION, MAX_RULES_PER_BUCKET,
  emptyLocalSettings, normalizeLocalSettings,
  type LocalSettings, type PermissionRuleBucket
} from '../../shared/domain/local-settings'
import type { KernelFs, Logger, WorkspacePaths } from './host'
import { EnvironmentError } from '../../shared/domain/environment'

interface SettingsScope { path?: WorkspacePaths; namespace?: string }
async function scopedPath(root: string, scope: SettingsScope): Promise<string> {
  return scope.path ? scope.path.resolveWithin(root, `${LOCAL_SETTINGS_DIRNAME}/${LOCAL_SETTINGS_FILENAME}`) : localSettingsPath(root)
}

export function localSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, LOCAL_SETTINGS_DIRNAME, LOCAL_SETTINGS_FILENAME)
}

/**
 * 缓存的键是 `mtimeMs:size`,不是「读过一次就不再读」。
 *
 * 每一次工具调用都会问一次这份文件,所以不能每次都解一遍 JSON;但用户**在编辑器里
 * 手改这个文件**是预期用法(那正是它存在的理由之一),所以也不能读一次就当永远。
 * 一次 stat 换一次「改完下一个工具调用就生效」。
 */
interface CacheEntry {
  key: string
  settings: LocalSettings
}

const cache = new Map<string, CacheEntry>()
/** 同一份文件的写入串起来 —— 并行工具调用可以同时点「以后都允许」。 */
const writes = new Map<string, Promise<unknown>>()

const MISSING = 'missing'

export function clearLocalSettingsCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) cache.clear()
  else cache.delete(localSettingsPath(workspaceRoot))
}

async function fileKey(fs: KernelFs, path: string, strict = false): Promise<string> {
  try {
    const stat = await fs.stat(path)
    return `${String(stat.mtimeMs)}:${String(stat.size)}`
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    if (strict && !['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))) throw error
    // 文件不存在 = 这个工作区没有任何本地规则,是正常状态,不是错误。
    return MISSING
  }
}

export async function readLocalSettings(fs: KernelFs, workspaceRoot: string, logger?: Logger, scope: SettingsScope = {}): Promise<LocalSettings> {
  if (workspaceRoot === '') return emptyLocalSettings()
  const path = await scopedPath(workspaceRoot, scope)
  const cacheKey = scope.namespace ? JSON.stringify([scope.namespace, path]) : path
  const key = await fileKey(fs, path, scope.namespace !== undefined)
  const hit = scope.namespace ? undefined : cache.get(cacheKey)
  if (hit !== undefined && hit.key === key) return hit.settings

  let settings = emptyLocalSettings()
  if (key !== MISSING) {
    try {
      settings = normalizeLocalSettings(JSON.parse(await fs.readFile(path)) as unknown)
    } catch (error) {
      if (error instanceof EnvironmentError || scope.namespace !== undefined) throw error
      // 手改坏了的文件按「没有规则」处理:这条路径上唯一比「少一条授权」更糟的结局,
      // 就是让一个 JSON 语法错误拦下用户的整轮运行。
      logger?.warn(`[local-settings] ${path} 不是有效的 JSON,本次按「没有本地权限规则」处理`)
    }
  }
  cache.set(cacheKey, { key, settings })
  return settings
}

export type AddRuleResult =
  | { ok: true; rule: string; path: string; added: boolean }
  | { ok: false; reason: 'no-workspace' | 'unreadable' | 'full' | 'io' }

async function writeRule(
  fs: KernelFs, path: string, bucket: PermissionRuleBucket, rule: string, logger?: Logger
): Promise<AddRuleResult> {
  let raw: Record<string, unknown> = {}
  if (await fs.exists(path)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(path))
    } catch {
      // ★ 读不懂就**不写**。这里覆盖过去等于把用户手写的那些段静默删掉,
      // 而他点的只是一颗「以后都允许」。
      logger?.error(`[local-settings] ${path} 无法解析,拒绝覆盖;请先修好这个文件再重试`)
      return { ok: false, reason: 'unreadable' }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  }

  const current = normalizeLocalSettings(raw)
  if (current.permissions[bucket].includes(rule)) return { ok: true, rule, path, added: false }
  if (current.permissions[bucket].length >= MAX_RULES_PER_BUCKET) return { ok: false, reason: 'full' }

  const rawPermissions = raw.permissions !== null && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)
    ? raw.permissions as Record<string, unknown>
    : {}
  // 顶层与 permissions 段的未知键都原样带过去 —— 新版本写下的东西,旧版本改一次规则不能抹掉。
  const merged = {
    ...raw,
    version: LOCAL_SETTINGS_VERSION,
    permissions: {
      ...rawPermissions,
      ...current.permissions,
      [bucket]: [...current.permissions[bucket], rule]
    }
  }

  try {
    await fs.mkdirp(path)
    await fs.writeFile(path, `${JSON.stringify(merged, null, 2)}\n`)
  } catch (error) {
    logger?.error(`[local-settings] 写入 ${path} 失败`, error)
    return { ok: false, reason: 'io' }
  }
  cache.delete(path)
  return { ok: true, rule, path, added: true }
}

export async function addLocalPermissionRule(
  fs: KernelFs, workspaceRoot: string, bucket: PermissionRuleBucket, rule: string, logger?: Logger, scope: SettingsScope = {}
): Promise<AddRuleResult> {
  if (workspaceRoot === '') return Promise.resolve({ ok: false, reason: 'no-workspace' })
  const path = await scopedPath(workspaceRoot, scope)
  const key = scope.namespace ? JSON.stringify([scope.namespace, path]) : path
  const queued = (writes.get(key) ?? Promise.resolve()).then(() => writeRule(fs, path, bucket, rule, logger))
  writes.set(key, queued.catch(() => undefined))
  return queued
}
