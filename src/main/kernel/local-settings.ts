/**
 * 两份设置文件的读写 —— 结构与语义在 `shared/domain/local-settings.ts`,
 * 这里只有 IO、缓存和并发。
 *
 * 管两份:
 * - `<工作区>/.next-cowork/settings.local.json`  项目级(权限规则 + 项目钩子)
 * - `<appData>/settings.json`                    全局级(目前只有钩子)
 *
 * ★ **两份共用这个模块里的 `cache` / `writes` 两张 Map，不能拆成两个文件。**
 *   `writes` 是「同一份文件的并发写不丢更新」的全部依据 —— 另开一个文件就是
 *   另一份 `writes`,而 `addLocalPermissionRule` 和写 hooks 都会落到
 *   `settings.local.json` 上。丢更新的症状是「我保存了但它没了」,且只在竞态下出现。
 *   一份文件、一份队列。
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
import type { HookSettings } from '../../shared/domain/hook'
import type { KernelFs, Logger, WorkspacePaths } from './host'
import { EnvironmentError } from '../../shared/domain/environment'

/** 全局设置的文件名。★ 和备份 zip 里那个 `settings.json` 条目同名但**无关** —— 那是 AppSettings 的 dump。 */
export const GLOBAL_SETTINGS_FILENAME = 'settings.json'

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

export function globalSettingsPath(userDataDir: string): string {
  return join(userDataDir, GLOBAL_SETTINGS_FILENAME)
}

export function clearGlobalSettingsCache(userDataDir?: string): void {
  if (userDataDir === undefined) cache.clear()
  else cache.delete(globalSettingsPath(userDataDir))
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

/** 两份文件共用的读 —— 缓存、容错、远程 fail-closed 都在这儿，调用方只给路径。 */
async function readSettingsAt(
  fs: KernelFs, path: string, cacheKey: string, strict: boolean, logger?: Logger
): Promise<LocalSettings> {
  const key = await fileKey(fs, path, strict)
  const hit = strict ? undefined : cache.get(cacheKey)
  if (hit !== undefined && hit.key === key) return hit.settings

  let settings = emptyLocalSettings()
  if (key !== MISSING) {
    try {
      settings = normalizeLocalSettings(JSON.parse(await fs.readFile(path)) as unknown)
    } catch (error) {
      if (error instanceof EnvironmentError || strict) throw error
      // 手改坏了的文件按「什么都没配」处理:这条路径上唯一比「少一条授权」更糟的
      // 结局,就是让一个 JSON 语法错误拦下用户的整轮运行。
      logger?.warn(`[settings] ${path} 不是有效的 JSON,本次按「没有配置」处理`)
    }
  }
  cache.set(cacheKey, { key, settings })
  return settings
}

export async function readLocalSettings(fs: KernelFs, workspaceRoot: string, logger?: Logger, scope: SettingsScope = {}): Promise<LocalSettings> {
  if (workspaceRoot === '') return emptyLocalSettings()
  const path = await scopedPath(workspaceRoot, scope)
  const cacheKey = scope.namespace ? JSON.stringify([scope.namespace, path]) : path
  return readSettingsAt(fs, path, cacheKey, scope.namespace !== undefined, logger)
}

/**
 * 全局那一份。目前只有 `hooks` 段。
 *
 * ★ 复用 `LocalSettings` 这个类型而不是另定一个:两份文件的形状是**故意一样**的,
 *   用户能把一段 hooks 从项目的那份直接粘到全局这份里。类型分家的第一天就会
 *   有人在一边加了字段而另一边没加。
 */
export async function readGlobalSettings(fs: KernelFs, userDataDir: string, logger?: Logger): Promise<LocalSettings> {
  const path = globalSettingsPath(userDataDir)
  return readSettingsAt(fs, path, path, false, logger)
}

/**
 * 两份文件共用的写。
 *
 * `mutate` 拿到**原始 JSON**（不是归一化后的）和归一化结果，返回要落盘的对象；
 * 返回 `null` = 这次不需要写（幂等命中）。
 *
 * ★ 三条既有约定在这里统一兑现：读不懂就拒绝写、未知键原样保留（靠 `mutate`
 *   里的 `{...raw}` 展开）、写完清缓存。
 */
async function updateSettingsFile(
  fs: KernelFs,
  path: string,
  mutate: (raw: Record<string, unknown>, current: LocalSettings) => Record<string, unknown> | null,
  logger?: Logger
): Promise<{ ok: true; path: string; changed: boolean } | { ok: false; reason: 'unreadable' | 'io' }> {
  let raw: Record<string, unknown> = {}
  if (await fs.exists(path)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(path))
    } catch {
      // ★ 读不懂就**不写**。这里覆盖过去等于把用户手写的那些段静默删掉,
      // 而他点的只是一颗「以后都允许」。
      logger?.error(`[settings] ${path} 无法解析,拒绝覆盖;请先修好这个文件再重试`)
      return { ok: false, reason: 'unreadable' }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  }

  const merged = mutate(raw, normalizeLocalSettings(raw))
  if (merged === null) return { ok: true, path, changed: false }

  try {
    await fs.mkdirp(path)
    await fs.writeFile(path, `${JSON.stringify(merged, null, 2)}\n`)
  } catch (error) {
    logger?.error(`[settings] 写入 ${path} 失败`, error)
    return { ok: false, reason: 'io' }
  }
  cache.delete(path)
  return { ok: true, path, changed: true }
}

/** 同一份文件的写入串起来 —— 见文件头那段「一份文件、一份队列」。 */
function queued<T>(key: string, run: () => Promise<T>): Promise<T> {
  const task = (writes.get(key) ?? Promise.resolve()).then(run)
  writes.set(key, task.catch(() => undefined))
  return task
}

export type WriteHooksResult = { ok: true } | { ok: false; reason: 'unreadable' | 'io' }

/**
 * 改某一份文件里的 hooks 段。
 *
 * ★ 只动 `hooks` 这一个键，`permissions` 和任何未知的顶层键原样带过去 ——
 *   两段配置共用一个文件时，这是唯一会静默毁数据的地方。
 */
export async function writeHooks(
  fs: KernelFs,
  path: string,
  mutate: (hooks: HookSettings) => HookSettings,
  logger?: Logger
): Promise<WriteHooksResult> {
  return queued(path, async () => {
    const out = await updateSettingsFile(
      fs,
      path,
      (raw, current) => ({
        ...raw,
        version: LOCAL_SETTINGS_VERSION,
        hooks: mutate(current.hooks)
      }),
      logger
    )
    return out.ok ? { ok: true } : { ok: false, reason: out.reason }
  })
}

export type AddRuleResult =
  | { ok: true; rule: string; path: string; added: boolean }
  | { ok: false; reason: 'no-workspace' | 'unreadable' | 'full' | 'io' }

async function writeRule(
  fs: KernelFs, path: string, bucket: PermissionRuleBucket, rule: string, logger?: Logger
): Promise<AddRuleResult> {
  // `mutate` 只能返回「要写的对象」或 null，装不下「桶满了」这个第三种结局 ——
  // 用一个闭包变量把它带出来，比给 mutate 加一层返回值包装读起来直接。
  let full = false
  const out = await updateSettingsFile(
    fs,
    path,
    (raw, current) => {
      if (current.permissions[bucket].includes(rule)) return null
      if (current.permissions[bucket].length >= MAX_RULES_PER_BUCKET) {
        full = true
        return null
      }
      const rawPermissions = raw.permissions !== null && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)
        ? raw.permissions as Record<string, unknown>
        : {}
      // 顶层与 permissions 段的未知键都原样带过去 —— 新版本写下的东西,旧版本改一次规则不能抹掉。
      return {
        ...raw,
        version: LOCAL_SETTINGS_VERSION,
        permissions: {
          ...rawPermissions,
          ...current.permissions,
          [bucket]: [...current.permissions[bucket], rule]
        }
      }
    },
    logger
  )
  if (full) return { ok: false, reason: 'full' }
  if (!out.ok) return { ok: false, reason: out.reason }
  return { ok: true, rule, path, added: out.changed }
}

export async function addLocalPermissionRule(
  fs: KernelFs, workspaceRoot: string, bucket: PermissionRuleBucket, rule: string, logger?: Logger, scope: SettingsScope = {}
): Promise<AddRuleResult> {
  if (workspaceRoot === '') return Promise.resolve({ ok: false, reason: 'no-workspace' })
  const path = await scopedPath(workspaceRoot, scope)
  const key = scope.namespace ? JSON.stringify([scope.namespace, path]) : path
  return queued(key, () => writeRule(fs, path, bucket, rule, logger))
}
