/**
 * Chromium profile 的落点约定,以及把它从 profile 根收进 `chromium/` 子目录的
 * 一次性迁移。
 *
 * ## 为什么要单独一个子目录
 *
 * `~/.next-cowork` 既是 Electron 的 `userData`,也是应用自己的数据根。默认情况下
 * Chromium 把 `Cache` / `Cookies` / `Local Storage` / `Network` / `Partitions` 这
 * 三十来个 profile 条目**扁平铺在根层**,其中磁盘缓存可能很大 —— Electron 官方也
 * 建议把会话数据挪出 `userData` 以免污染(`app.setPath('sessionData', …)`)。收拢
 * 之后会话集归 `chromium/`,应用数据归 `data/`,根层清爽。
 *
 * ## 关键:哪些搬、哪些留
 *
 * `sessionData` 只覆盖 localStorage / cookies / disk cache / network state /
 * DevTools 文件。`Preferences`、`Local State`、`Crashpad`、`DevToolsActivePort`
 * **不是**会话数据,Chromium 始终从 `userData` 根读它们 —— 尤其 `Local State` 存着
 * cookie 的加密密钥,一旦跟着搬进 `chromium/`(Chromium 不会去那里读),搬过去的
 * `Cookies` 就再也解不了密,登录照样丢。所以这几样**必须留在根层**。
 *
 * ## 为什么单独一个文件
 *
 * 迁移要在 app ready 之前动用户的真实数据,是启动路径上风险最高的一段。留在
 * `main/index.ts` 里它不可测(那个文件一被 import 就跑整个引导)。这里只依赖 node
 * 内置模块,测试可以直接调 —— 与相邻的 `flat-layout.ts` 同一套路。
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 会话集收进的子目录名。`app.setPath('sessionData', <root>/chromium)` 指向它。 */
export const CHROMIUM_SUBDIRNAME = 'chromium'

/**
 * Chromium 在 profile 根下铺开的全部条目。
 *
 * ★ 这是「删除全部数据」认领 Chromium 资产的单一事实源,`ipc/storage.ts` 从这里取。
 *   因此**含** `Preferences` / `Local State` / `Crashpad` —— 它们虽不随 `sessionData`
 *   搬走,但同样是 Chromium 写的、该被一并清掉的东西。搬与不搬的区分见
 *   `CHROMIUM_USERDATA_SCOPED`。
 */
export const CHROMIUM_PROFILE_ENTRIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Session Storage',
  'Local Storage',
  'blob_storage',
  'Shared Dictionary',
  'Network Persistent State',
  'Cookies',
  'Cookies-journal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'DIPS',
  'DIPS-wal',
  'DIPS-wal 2',
  'Local State',
  'Preferences',
  'Service Worker',
  'IndexedDB',
  'WebStorage',
  'Network',
  'TransportSecurity',
  'QuotaManager',
  'QuotaManager-journal',
  'History',
  'History-journal',
  'Crashpad',
  /*
    ★ 插件宿主(`persist:plugin-host`)和浏览器工作区的 `persist:` 分区都落在这里,
    装着它们的 cookie / localStorage。Electron 自己决定这个落点,不经过我们任何
    代码 —— 随 `sessionData` 一起搬进 `chromium/`。
  */
  'Partitions'
] as const

/**
 * 留在 `userData` 根、**永不**随迁移搬走的条目。
 *
 * ★ `Local State` 存着 cookie 加密密钥;`Preferences` 是浏览器级偏好;`Crashpad` 由
 *   `crashDumps` 路径而非 `sessionData` 决定落点;`DevToolsActivePort` 是运行期句柄。
 *   它们都不随 `sessionData` 迁移 —— 硬搬只会造出一份 Chromium 永远不读的死副本,
 *   `Local State` 那份还会连累已搬走的 `Cookies` 解不了密。
 */
export const CHROMIUM_USERDATA_SCOPED = [
  'Preferences',
  'Local State',
  'Crashpad',
  'DevToolsActivePort'
] as const

/**
 * Chromium / SQLite 可能给顶层文件追加数字碰撞后缀(如 `DIPS-wal 3`)。匹配刻意收窄,
 * 别把两个根变成任意递归删除 —— 与 `CHROMIUM_PROFILE_ENTRIES` 一样是 `storage.ts` 的
 * 事实源,迁移也用它扫出带后缀的会话文件。
 */
export const CHROMIUM_PROFILE_FILE_PATTERNS = [
  /^DIPS-(?:wal|shm)(?: [1-9]\d*)?$/u,
  /^declarative_performance_observer\.db(?:-(?:journal|wal|shm))?$/u
] as const

/** 真正随 `sessionData` 搬进 `chromium/` 的会话集 = 全部条目去掉留在根层的那几样。 */
const SESSION_MOVE_ENTRIES = CHROMIUM_PROFILE_ENTRIES.filter(
  (name) => !(CHROMIUM_USERDATA_SCOPED as readonly string[]).includes(name)
)

/**
 * 收集 profile 根下此刻真实存在、且属于会话集的条目名(含带碰撞后缀的)。
 *
 * ★ 走白名单而非黑名单:只认 `SESSION_MOVE_ENTRIES` + 会话文件模式扫出来的,
 *   绝不碰 `data/` / `Local State` / 用户随手放进来的无关文件。
 */
function collectSessionEntries(profileRoot: string): string[] {
  const set = new Set<string>()
  for (const name of SESSION_MOVE_ENTRIES) {
    if (existsSync(join(profileRoot, name))) set.add(name)
  }
  try {
    for (const name of readdirSync(profileRoot)) {
      if (CHROMIUM_PROFILE_FILE_PATTERNS.some((pattern) => pattern.test(name))) set.add(name)
    }
  } catch {
    // 读不到根目录(还不存在等)→ 没什么可搬,交给下面的空集分支。
  }
  return [...set]
}

/**
 * 首次切换到 `sessionData = <root>/chromium` 时,把根层的会话集 rename 进 `chromium/`,
 * 保住老用户的登录态。
 *
 * ★ 一次性闸门:`chromium/` 已存在就直接返回 —— 要么上一次已迁移,要么全新安装启动后
 *   由 Chromium 自己建了它,之后每次启动都在这里零成本掠过(一次 `existsSync`)。
 *
 * ★ 用 `rename` 不用 copy:同卷子目录,元数据操作,原子瞬时、不占第二份空间。代价是
 *   成功后旧布局不复存在,所以中途失败必须**逆序 rename 回原位** —— 半截搬运会让
 *   Chromium 在 `chromium/` 里看到残缺 profile。整套 try/rollback 与
 *   `flat-layout.ts` 的 `migrateFlatLayout` 同构。
 *
 * ★ 必须在 `app.whenReady()` 之前调用:那之后 Chromium 立刻握住这些文件的句柄,
 *   Windows 上就再也 rename 不动了(与 `sweepPendingDelete` 同一个时间窗)。
 *
 * @returns 实际搬走的条目数。
 */
export function migrateChromiumIntoSubdir(profileRoot: string): number {
  const targetDir = join(profileRoot, CHROMIUM_SUBDIRNAME)
  if (existsSync(targetDir)) return 0

  const entries = collectSessionEntries(profileRoot)
  // 一个会话条目都没有 = 全新 profile,别凭空建出一个 `chromium/`。
  if (entries.length === 0) return 0

  const moved: Array<{ from: string; to: string }> = []
  try {
    mkdirSync(targetDir, { recursive: true })
    for (const name of entries) {
      const from = join(profileRoot, name)
      const to = join(targetDir, name)
      if (!existsSync(from) || existsSync(to)) continue
      renameSync(from, to)
      moved.push({ from, to })
    }
  } catch (err) {
    for (const entry of [...moved].reverse()) {
      try {
        renameSync(entry.to, entry.from)
      } catch (rollbackError) {
        console.error('[db] Chromium 会话集迁移回滚失败:', entry.from, rollbackError)
      }
    }
    throw err
  }
  return moved.length
}
