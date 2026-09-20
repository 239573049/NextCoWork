/**
 * 启动迁移闸门的 IPC 面。
 *
 * ## 这个文件为什么不能 import 别的 ipc 模块
 *
 * ★ 它是**全应用唯一在数据库打开之前就能被调用的 handler 组**。`ipc/storage.ts`
 * 里那条 `storage:openDataDirectory` 看上去是同一件事,但它 import 了
 * `db/repo`,而 `repo` 的任何一个查询都会去摸库 —— 库还没打开时 `db/index.ts`
 * 会先开一个**内存兜底库**,随后真正的 `openDatabase()` 直接抛错。表现是
 * 「迁移卡住之后启动失败」,而错误信息里一个字都不会提到谁先碰了库。
 *
 * 所以这里的依赖只有三样:`electron` 的 `shell`、`db/index.ts` 的
 * `databaseDirectory()`(纯路径函数,不碰句柄)、以及闸门本身。
 *
 * ## 闸门实例为什么放在这里
 *
 * `main/index.ts` 建它、启动它、读它的最终状态;`ipc/index.ts` 的四个 handler
 * 要用同一个实例。放在模块级变量里是这两者之间最短的一条线 —— 而它**不需要**
 * 生命周期管理:进程内只有一个闸门,它自己就是单例。
 */
import { shell } from 'electron'
import type { MigrationState } from '../../shared/domain/data-migration'
import { databaseDirectory } from '../db'
import type { MigrationGate } from '../db/startup-migration'
import { windows } from '../window/registry'

let gate: MigrationGate | null = null
let dataChangedListener: (() => void) | null = null

export function installMigrationGate(instance: MigrationGate): void {
  gate = instance
}

/**
 * 数据库打开后接上迁移完成回调。
 *
 * 需求：这组 IPC 在开库前就会登记，不能自己 import 会读库的模块；但运行期重试 / 撤销
 * 又必须让账户归属和渲染缓存同步。回调由启动序列在开库后安装，开库前保持 null。
 */
export function setMigrationDataChangedListener(listener: (() => void) | null): void {
  dataChangedListener = listener
}

/**
 * 闸门 → 窗口的进度推送。
 *
 * ★ 与 `main/index.ts` 里 `setImportChangeListener` 那批接线同一种形态:
 *   `db/**` 不 import `window/registry`,方向保持「ipc 依赖 db,db 不依赖 ipc」。
 *   闸门只暴露 `onChange` 回调,推给谁由这里决定。
 *
 * ★ 用 `emitToAll` 而不是 `emitToTopic`:迁移是**全局**状态,而且此刻窗口可能
 *   刚建出来、还没跑过 `window:ready`(topic 还没订阅上)。丢帧的后果是进度条
 *   永远停在 0,而用户没有任何办法让它刷新。
 */
export function announceMigrationState(state: MigrationState): void {
  windows.emitToAll('dataMigration:progress', state)
}

/**
 * 拿闸门。
 *
 * ★ 拿不到时**不抛** —— 返回一个「什么都不用做」的空状态。
 * 这个 handler 会在渲染层握手时被调用,而那条路径上抛异常等于首屏白屏;
 * 而拿不到闸门只有一种原因:调用方没装(比如某个只跑 IPC 子集的测试),
 * 那种情况下「无需迁移」正是正确的答案。
 */
function requireGate(): MigrationGate | null {
  return gate
}

const NO_GATE: MigrationState = {
  phase: 'idle',
  steps: [],
  completed: [],
  current: null,
  ratio: null,
  failure: null,
  merged: null,
  undoAvailable: false
}

export function getMigrationState(): MigrationState {
  return requireGate()?.state() ?? NO_GATE
}

export async function retryMigration(): Promise<MigrationState> {
  const instance = requireGate()
  if (instance === null) return NO_GATE
  const state = await instance.run()
  // 需求：失败的重试也可能按会话提交了一部分行；归属清单与每条会话同事务落盘，
  // 必须立刻重连并刷新侧边栏，否则用户看到「重试失败」之外仍是一片空白。
  if (state.merged !== null || state.phase === 'failed') dataChangedListener?.()
  return state
}

export function skipMigration(): MigrationState {
  const instance = requireGate()
  if (instance === null) return NO_GATE
  instance.skip()
  return instance.state()
}

export function undoMigration(): MigrationState {
  const instance = requireGate()
  if (instance === null) return NO_GATE
  instance.undo()
  dataChangedListener?.()
  return instance.state()
}

/**
 * 打开数据目录。
 *
 * ★ 走主进程的 `shell.openPath`,渲染层拿不到也传不了路径 —— 与
 * `storage:openDataDirectory` 同一条规矩。区别只是这里不经过 `repo`,
 * 所以闸门期间也能用。
 */
export async function openMigrationDataDirectory(): Promise<void> {
  const message = await shell.openPath(databaseDirectory())
  if (message !== '') throw new Error(`打开数据目录失败: ${message}`)
}
