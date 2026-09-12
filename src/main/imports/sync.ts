/**
 * 自动同步 —— 应用运行期间,每 30 秒把源侧的新变化拉进来。
 *
 * ## 它**不是**什么
 *
 * 不是常驻系统 daemon,不跨设备,不反向写回。应用退出它就停,退出期间源侧
 * 发生的事,下次启动那一轮补扫时才看到。这是有意的范围。
 *
 * ## 三条让「后台自动」不至于毁掉用户工作的规矩
 *
 * 1. **单飞,而且和手动导入共用同一张作业表。** 两者抢同一个来源会在
 *    `import_mappings` 上打架,而打架的结果是同一份转录被导入两次。
 *    单飞是在 `service.ts` 的 `jobsBySource` 上实现的,这里只是不去绕过它。
 * 2. **只做已授权范围。** 已确认的类别 ∩ 已确认的项目。新项目只提醒,
 *    新类别(升级带来的)默认未授权 —— 用户当初点「全选」授权的是当时那七类,
 *    不是一张空白支票。
 * 3. **资产更新要等 run 空闲。** 全局资产避开所有在跑的 run,工作区资产避开
 *    那个工作区的 run。在一次 run 进行中替换掉它正在用的技能文件,
 *    表现是工具行为在半途变了,而转录里看不出任何原因。
 *
 * ## 为什么不复用 `config-sync.ts`
 *
 * 那个模块是**账户云同步**:5 秒一次的网络拉/推,`sync_conflict` 表装的是
 * 服务端与本地的版本冲突。这里一次网络请求都不发,冲突的含义也完全不同
 * (「用户改过本地副本」而不是「另一台设备也改了」)。只借它的
 * `tick / start / stop + inFlight` 生命周期形状,不借数据。
 */
import type { ImportCategory, ImportJobStatus } from '../../shared/domain/import'
import { IMPORT_LIMITS } from '../../shared/domain/import'
import { runs } from '../kernel/run-registry'
import { store } from '../state/store'
import { __internal, jobStatusFor } from './service'

let timer: NodeJS.Timeout | null = null
/** ★ 进程内单飞。定时器本身不保证上一轮跑完了 —— 慢盘上一轮可能超过 30 秒。 */
let inFlight = false

export function startImportSync(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    void tick('timer')
  }, IMPORT_LIMITS.syncIntervalMs)
  timer.unref?.()
  // 启动后先来一次,**非阻塞** —— 让它进 microtask 队列,不占用启动路径。
  void tick('startup')
}

export function stopImportSync(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/**
 * 系统唤醒后补扫一次。★ 休眠两小时回来,定时器只补触发一次,
 * 而这两小时里源侧可能积了几十个会话。
 */
export function resumeImportSync(): void {
  void tick('resume')
}

/** 手动的「立即同步」。走**同一条**代码路径,不另开一套覆盖语义。 */
export async function syncImportSourceNow(sourceId: string): Promise<ImportJobStatus> {
  const running = jobStatusFor(sourceId)
  if (running !== null && !__internal.isTerminal(running.phase)) return running
  const status = await syncOne(sourceId, 'manual-now')
  if (status !== null) return status
  // 没有任何变化:不制造空批次,回一个已完成的空态让界面收尾。
  const now = Date.now()
  return {
    jobId: '',
    sourceId,
    trigger: 'auto',
    phase: 'done',
    done: 0,
    total: 0,
    counts: { imported: 0, updated: 0, skipped: 0, conflict: 0, failed: 0, incompatible: 0 },
    startedAt: now,
    endedAt: now,
    diagnostics: []
  }
}

async function tick(_reason: string): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    for (const row of store.listImportSources()) {
      if (!row.syncEnabled) continue
      if (row.configDir === '') continue
      await syncOne(row.sourceId, 'tick')
    }
  } catch {
    // 一轮失败不该让定时器停掉。真正的原因会落到来源行的 diagnostics 上。
  } finally {
    inFlight = false
  }
}

/**
 * 扫一个来源,把已授权范围内的变化提交掉。
 *
 * 返回 `null` = 这一轮什么都没变。★ 此时**只更新最近检查时间**,
 * 不建批次 —— 每 30 秒一条空批次会在几小时内把历史页淹掉,
 * 而用户想在历史页里看的是「哪次真的导了东西」。
 */
async function syncOne(sourceId: string, trigger: string): Promise<ImportJobStatus | null> {
  const row = store.getImportSource(sourceId)
  if (row === undefined) return null

  const running = jobStatusFor(sourceId)
  if (running !== null && !__internal.isTerminal(running.phase)) return null

  const now = Date.now()
  let scanned: Awaited<ReturnType<typeof __internal.scanSource>>
  try {
    scanned = await __internal.scanSource(row)
  } catch (err) {
    // 源暂时读不了 → 暂停/重试状态,**不触发任何删除**。
    store.putImportSource({
      ...row,
      status: 'paused',
      lastCheckAt: now,
      diagnostics: [{ code: 'source.unreadable', detail: err instanceof Error ? err.message : String(err) }],
      updatedAt: now
    })
    return null
  }

  const categories = new Set(row.categories as ImportCategory[])
  const projects = new Set(row.projectKeys)
  const busyWorkspaces = activeWorkspaceIds()
  const globalBusy = busyWorkspaces.size > 0

  const selected = scanned.items.filter((item) => {
    if (!categories.has(item.category)) return false
    // 只有真的有东西要写的项才值得排进这一轮。
    if (item.status !== 'new' && item.status !== 'update') return false
    /*
      ★ 项目授权是**白名单**。没被明确勾选的项目里出现新聊天,只提醒,
      不自动导入 —— 那可能是用户有意不想搬过来的那部分。
    */
    if (item.projectKey !== undefined && !projects.has(item.projectKey)) return false
    if (item.category === 'project') return false // 自动同步不新建工作区

    // 资产更新避开正在跑的 run,见文件头第 3 条。
    if (item.category === 'skill' || item.category === 'agent' || item.category === 'command') {
      return !globalBusy
    }
    if (item.category === 'instructions') {
      if (item.scope === 'global') return !globalBusy
      return item.targetWorkspaceId === undefined || !busyWorkspaces.has(item.targetWorkspaceId)
    }
    return true
  })

  if (selected.length === 0) {
    store.putImportSource({
      ...row,
      status: 'idle',
      lastCheckAt: now,
      diagnostics: [],
      updatedAt: now
    })
    __internal.announce(sourceId)
    return null
  }

  const snapshot = {
    previewId: `sync-${String(now)}`,
    sourceId,
    configDir: row.configDir,
    createdAt: now,
    expiresAt: now + IMPORT_LIMITS.previewTtlMs,
    items: scanned.items,
    payloads: scanned.payloads,
    projects: scanned.projects,
    diagnostics: scanned.diagnostics
  }

  const job = __internal.startJob(sourceId, 'auto', selected.length, `sync:${trigger}:${String(now)}`)
  store.putImportSource({ ...row, status: 'running', lastCheckAt: now, diagnostics: [], updatedAt: now })

  // 目标工作区由映射决定 —— 自动同步不猜、不新建。
  await __internal.runJob(job, snapshot, selected, new Map())

  const after = store.getImportSource(sourceId)
  if (after !== undefined) {
    store.putImportSource({ ...after, status: after.syncEnabled ? 'idle' : 'off', updatedAt: Date.now() })
  }
  return job.status
}

/**
 * 此刻有 run 在跑的工作区。
 *
 * ★ 每次现算,不缓存。缓存的失效时机恰好是「一次 run 刚开始」——
 * 而那正是我们要挡住的那一刻。
 */
function activeWorkspaceIds(): Set<string> {
  const ids = new Set<string>()
  for (const runId of runs.activeRunIds()) {
    const sessionId = runs.get(runId)?.sessionId
    if (sessionId === undefined) continue
    const session = store.getSession(sessionId)
    if (session !== undefined) ids.add(session.workspaceId)
  }
  return ids
}
