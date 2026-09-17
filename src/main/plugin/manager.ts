/**
 * 插件生命周期 —— 装载、激活、休眠、禁用、卸载,以及 RPC 的四道门。
 *
 * ## 这个文件不 import electron
 *
 * 依赖方向是 `shared ← kernel ← runtime ← ipc ← index`,而插件宿主窗口
 * 显然是 electron 的东西。解法是把「怎么跑插件代码」抽成 `PluginRuntime`:
 * 这里只说「激活它」,由 `host-window.ts` 用 BrowserWindow + iframe 实现,
 * 测试里换成一个假的。
 *
 * 好处不只是可测:它把**策略**(谁能激活、什么时候休眠、哪条 RPC 放行)
 * 和**机制**(iframe、MessagePort、CSP)分在两个文件里,而前者是会被反复
 * 修改的那一半。
 *
 * ## 失败一律变诊断,永不 throw 到调用方
 *
 * 一个装不上的插件不该让插件系统起不来,更不该让应用起不来 ——
 * 同 `kernel/skill/load.ts` 的取向。所有失败落在 `InstalledPlugin.diagnostics`
 * 上,插件详情页逐条展示。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { KernelHost } from '../kernel/host'
import {
  PLUGIN_CONTEXT_LIMIT,
  PLUGIN_METHOD_PERMISSION,
  PLUGIN_TIMEOUT,
  isPluginMethod,
  type PluginErrorCode,
  type PluginInvocation,
  type PluginMethod,
  type PluginRequest,
  type PluginResponse
} from '../../shared/plugin/protocol'
import {
  canRequest,
  grantPermissions,
  hasPermission,
  permissionEscalated,
  revokePermissions,
  sortPermissions,
  type PluginPermission,
  type PluginPermissionState
} from '../../shared/plugin/permission'
import { satisfiesEngine, type PluginManifest } from '../../shared/plugin/manifest'
import type {
  InstalledPlugin,
  PluginCatalog,
  PluginDiagnostic,
  PluginStatus,
  PluginStatusBarItem
} from '../../shared/plugin/state'
import { installPluginDirectory, installPluginZip, readInstalledManifest } from './installer'
import { explainUnsupported } from './unsupported'
import { recordActivity, clearActivity } from './diagnostics'
import { CapabilityError, invokeCapability, type CapabilityContext } from './rpc'
import { narrowWorkspacePath, wrapPluginContext } from './capabilities'
import { isValidPluginToolName, toolRegistrationFor, type PluginToolDeclaration } from './tools'
import type { ToolRegistration } from '../kernel/tool/registry'
import { SUPPORTED_LOCALE_FILES, localeOfFile } from './locale-files'

/** 插件目录名。`ipc/storage.ts:148` 的删除清单里已经有它。 */
export const PLUGINS_DIR = 'plugins'

/** 空闲多久休眠。计划 §2.3:懒激活 + 空闲 5 分钟休眠。 */
const IDLE_SLEEP_MS = 5 * 60 * 1000

/** 持久化的那一小块:用户的决定。清单本身每次从盘上重读。 */
interface PersistedPlugin {
  enabled: boolean
  granted: PluginPermission[]
  /** 上一次批准时的必选能力 —— 升级后拿它比对,判断有没有扩权 */
  approvedRequired: PluginPermission[]
  installedAt: number
  updatedAt: number
}

type PersistedState = Record<string, PersistedPlugin>

const KV_KEY = 'plugins.state'

/** 「怎么把插件代码跑起来」。实现在 `host-window.ts`,测试里换成假的。 */
export interface PluginRuntime {
  /** 建一个隔离上下文并等它握手完成。超时/崩溃都必须 reject。 */
  spawn(plugin: { id: string; root: string; main: string }): Promise<void>
  /** 宿主 → 插件的反向调用。 */
  invoke(pluginId: string, invocation: PluginInvocation, timeoutMs: number): Promise<unknown>
  /** 销毁这个插件的隔离上下文。幂等。 */
  dispose(pluginId: string): void
  disposeAll(): void
}

export interface PluginManagerDeps {
  host: KernelHost
  runtime: PluginRuntime
  /** 全局插件根。工作区级的走 `<ws>/.next-cowork/plugins/`,由调用方另给 */
  pluginRoot: string
  hostVersion: string
  getKv: <T>(key: string, fallback: T) => T
  setKv: (key: string, value: unknown) => void
  /** 当前工作区。路径类能力全部以它为根 */
  currentWorkspace: () => { id: string; rootPath: string }
  /** 走既有八层权限链 */
  approve: (pluginId: string, summary: { kind: 'write' | 'exec'; detail: string }) => Promise<boolean>
  /** catalog 变了,推 `plugins:changed` */
  emitChanged: () => void
  /** 插件的 l10n bundle 注册到渲染层 */
  publishMessages: (pluginId: string, locale: string, dict: Record<string, string>) => void
  unpublishMessages: (pluginId: string) => void
  /**
   * 运行期申请能力。**只会在 `canRequest` 通过之后被调用** ——
   * 清单上界之外的申请根本到不了这里(见 `handleHostMethod`)。
   */
  requestPermissions: (pluginId: string, permissions: readonly PluginPermission[], reasonKey: string) => Promise<boolean>
  /** 贡献的工具变了 —— 下一次装配要重新问一遍 provider */
  onToolsChanged: () => void
  /**
   * 插件要给用户看一条消息。
   *
   * ★ 传的是 **key + params**,不是句子。渲染层 `t()` 之后才是人话 ——
   * 主进程侧一律不产出用户可见的裸文本(计划 §8.3)。
   */
  showMessage: (
    pluginId: string,
    kind: 'info' | 'warn' | 'error',
    messageKey: string,
    params: Record<string, string | number>
  ) => void
  /**
   * 为某个文件打开这个插件的自定义编辑器 Tab。
   *
   * ★ 主进程这一侧**只做校验与转发**,不认识 Tab:Tab 是渲染层的概念,
   * 而「哪一格、放在哪个 dock group」那些决定全在 `stores/tabs.ts` 里。
   * 这里把它当成一条广播出去,与 `showMessage` 同一形状。
   */
  openCustomEditor: (pluginId: string, viewType: string, path: string) => void
}

interface PluginRecord {
  manifest: PluginManifest
  root: string
  scope: 'global' | 'workspace'
  status: PluginStatus
  enabled: boolean
  granted: PluginPermission[]
  approvedRequired: PluginPermission[]
  diagnostics: PluginDiagnostic[]
  installedAt: number
  updatedAt: number
  /** 最后一次被用到的时刻 —— 休眠判定用它 */
  touchedAt: number
  /** 这个插件注册过的命令 / 工具,禁用时要级联清掉 */
  commands: Set<string>
  tools: Map<string, PluginToolDeclaration>
  /** 注册过拦截器 / 上下文提供者吗 */
  interceptor: boolean
  contextProvider: boolean
  /** 状态栏那几格。禁用时清空 —— 插件没了,它的读数不该还挂在那儿 */
  statusBar: Map<string, PluginStatusBarItem>
  /** 有未保存改动的自定义编辑器文档:`documentId → 文件路径` */
  dirtyDocuments: Map<string, string>
}

export class PluginManager {
  private readonly records = new Map<string, PluginRecord>()
  private sleepTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: PluginManagerDeps) {}

  /**
   * 扫描插件目录,读清单,恢复用户的决定。**不激活任何东西。**
   *
   * ★ 激活由激活事件驱动(`onCommand` / `onView` / `onTool` …)。启动时
   * 一律不激活,是因为「每个激活的插件 = 一个 renderer 进程」这件事让
   * 启动期激活成为这套架构下唯一的内存风险源。
   */
  async start(): Promise<void> {
    const persisted = this.deps.getKv<PersistedState>(KV_KEY, {})
    await fs.mkdir(this.deps.pluginRoot, { recursive: true }).catch(() => undefined)
    const entries = await fs.readdir(this.deps.pluginRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      // 安装中断留下的 staging / backup 残片:清掉,别当成插件读。
      if (!entry.isDirectory()) continue
      if (entry.name.includes('.installing-') || entry.name.includes('.backup-')) {
        await fs.rm(join(this.deps.pluginRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await this.load(join(this.deps.pluginRoot, entry.name), 'global', persisted[entry.name])
    }
    this.sleepTimer = setInterval(() => { this.sweepIdle() }, 60_000)
    this.sleepTimer.unref?.()
    this.persist()
  }

  async shutdown(): Promise<void> {
    if (this.sleepTimer !== undefined) clearInterval(this.sleepTimer)
    for (const [id, record] of this.records) {
      if (record.status === 'active') await this.deactivate(id).catch(() => undefined)
    }
    this.deps.runtime.disposeAll()
  }

  catalog(): PluginCatalog {
    return {
      hostVersion: this.deps.hostVersion,
      plugins: [...this.records.entries()]
        .map(([id, record]) => this.project(id, record))
        .sort((a, b) => a.manifest.displayName.localeCompare(b.manifest.displayName))
    }
  }

  private project(id: string, record: PluginRecord): InstalledPlugin {
    const permissions: PluginPermissionState = {
      required: record.manifest.permissions,
      optional: record.manifest.optionalPermissions,
      granted: record.granted
    }
    const pending = record.manifest.permissions.filter((p) => !record.approvedRequired.includes(p))
    return {
      id,
      manifest: record.manifest,
      status: record.status,
      scope: record.scope,
      path: record.root,
      enabled: record.enabled,
      permissions,
      diagnostics: record.diagnostics,
      unsupported: record.manifest.contributes.unsupported,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      statusBar: [...record.statusBar.values()],
      ...(pending.length > 0 ? { pendingPermissions: pending } : {})
    }
  }

  // ─────────────────────────── 装载 ───────────────────────────

  private async load(
    root: string,
    scope: 'global' | 'workspace',
    persisted: PersistedPlugin | undefined
  ): Promise<void> {
    const diagnostics: PluginDiagnostic[] = []
    let manifest: PluginManifest
    try {
      manifest = await readInstalledManifest(root)
    } catch (error) {
      /*
        ★ 读不懂的清单**不进 records**:一个没有 id 的东西没法被启用、禁用、
        卸载,放进表里只会变成一行点什么都没反应的条目。日志里说明白就够。
      */
      this.deps.host.logger.warn(`[plugin] ${root}: ${(error as Error).message}`)
      return
    }

    for (const key of manifest.contributes.unsupported) {
      diagnostics.push({ path: `contributes.${key}`, message: explainUnsupported(key), level: 'warn' })
    }

    let status: PluginStatus = 'idle'
    if (!satisfiesEngine(manifest.engines, this.deps.hostVersion)) {
      diagnostics.push({
        path: 'engines.nextcowork',
        message: `requires ${manifest.engines}, this host is ${this.deps.hostVersion}`,
        level: 'error'
      })
      status = 'error'
    }

    const approvedRequired = persisted?.approvedRequired ?? []
    /*
      ★ 升级后必选能力变大 → `pending-approval`,**不批不激活**。
      这一条是「装完之后自动更新悄悄扩权」那条路上的闸门。
    */
    if (status !== 'error' && persisted !== undefined && permissionEscalated(approvedRequired, manifest.permissions)) {
      status = 'pending-approval'
      diagnostics.push({
        path: 'permissions',
        message: `this version asks for new permissions: ${manifest.permissions.filter((p) => !approvedRequired.includes(p)).join(', ')}`,
        level: 'warn'
      })
    }

    const now = Date.now()
    const enabled = persisted?.enabled ?? false
    /*
      ★ 「没启用」就是 `disabled`,不是 `idle`。两者在界面上是两句不同的话
      (「已禁用」vs「已启用,等着被叫醒」),而 `idle + enabled:false` 这种
      组合会让开关显示成关、状态显示成开 —— 用户看不出到底哪个是真的。
      装载失败与待批准优先级更高:它们和用户的开关无关。
    */
    this.records.set(manifest.id, {
      manifest,
      root,
      scope,
      status: status === 'error' || status === 'pending-approval' ? status : enabled ? 'idle' : 'disabled',
      enabled,
      granted: sortPermissions(persisted?.granted ?? []),
      approvedRequired,
      diagnostics,
      installedAt: persisted?.installedAt ?? now,
      updatedAt: now,
      touchedAt: 0,
      commands: new Set(),
      tools: new Map(),
      interceptor: false,
      contextProvider: false,
      statusBar: new Map(),
      dirtyDocuments: new Map()
    })

    await this.publishLocaleBundles(manifest, root, diagnostics)
  }

  /**
   * 把包里的 l10n bundle 注册进渲染层的运行期 catalog。
   *
   * ★ 在**装载时**做,不是激活时:菜单项、命令名这些在插件还没被激活之前
   * 就要显示出来(菜单本身就是激活事件的来源)。激活时才注册的话,
   * 用户看到的是一排 key,点一下才变成文字。
   */
  private async publishLocaleBundles(
    manifest: PluginManifest,
    root: string,
    diagnostics: PluginDiagnostic[]
  ): Promise<void> {
    if (manifest.l10n === undefined) return
    for (const file of SUPPORTED_LOCALE_FILES) {
      const path = join(root, manifest.l10n, file)
      try {
        const raw = await fs.readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const dict: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value !== 'string') continue
          // 包里写的是 `cmd.new`,注册进去的是 `plugin.<id>.cmd.new` —— 前缀由宿主拼。
          dict[`plugin.${manifest.id}.${key}`] = value
        }
        this.deps.publishMessages(manifest.id, localeOfFile(file), dict)
      } catch (error) {
        diagnostics.push({
          path: `${manifest.l10n}/${file}`,
          message: `l10n bundle could not be read: ${(error as Error).message}`,
          level: 'warn'
        })
      }
    }
  }

  // ─────────────────────────── 安装 / 卸载 ───────────────────────────

  /**
   * @param expectedSha256
   * 市场给的**权威摘要**。目录安装没有这个东西(本地开发),ZIP 安装必须有 ——
   * 没有它的话,「摘要对得上」只证明了下载到的文件和它自己一致。
   */
  async install(path: string, expectedSha256?: string): Promise<void> {
    const stat = await fs.stat(path)
    const installed = stat.isDirectory()
      ? await installPluginDirectory(path, this.deps.pluginRoot)
      : await installPluginZip(path, this.deps.pluginRoot, expectedSha256)
    const previous = this.records.get(installed.manifest.id)
    if (previous !== undefined) await this.disable(installed.manifest.id)
    const persisted = this.deps.getKv<PersistedState>(KV_KEY, {})
    await this.load(installed.target, 'global', persisted[installed.manifest.id])
    this.persist()
    this.deps.emitChanged()
  }

  async uninstall(pluginId: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    /*
      ★ 顺序:先下线(注销贡献 + 销毁上下文),再删目录。
      反过来的话,一次正在进行的调用会读到一个已经消失的包 —— 同
      `mcp/manager.ts:264` 的「下线先于关闭」。
    */
    await this.disable(pluginId)
    this.deps.unpublishMessages(pluginId)
    clearActivity(pluginId)
    this.records.delete(pluginId)
    const persisted = this.deps.getKv<PersistedState>(KV_KEY, {})
    delete persisted[pluginId]
    this.deps.setKv(KV_KEY, persisted)
    await fs.rm(record.root, { recursive: true, force: true }).catch(() => undefined)
    this.deps.emitChanged()
  }

  // ─────────────────────────── 启用 / 禁用 ───────────────────────────

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    if (!enabled) { await this.disable(pluginId); return }
    if (record.status === 'error') return
    /*
      ★ 待批准的插件**启用不了**。这不是 UI 上的一个禁用态 —— 它必须在这里
      也挡住,否则任何一条绕过界面的路径(IPC 直调、命令面板)都能把一个
      扩了权的版本悄悄跑起来。
    */
    if (record.manifest.permissions.some((p) => !record.approvedRequired.includes(p))) {
      record.status = 'pending-approval'
      this.deps.emitChanged()
      return
    }
    record.enabled = true
    record.status = 'idle'
    this.persist()
    this.deps.emitChanged()
  }

  private async disable(pluginId: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    if (record.status === 'active' || record.status === 'activating') {
      await this.deactivate(pluginId).catch(() => undefined)
    }
    record.enabled = false
    record.status = 'disabled'
    /*
      ★ **下线先于销毁**(同 `mcp/manager.ts:264`)。反过来的话,注册表里
      还留着几个指向已销毁上下文的工具,模型下一轮照样会去调它们 ——
      而那次调用的失败信息里不会有任何线索指向「这个插件刚被禁用了」。
    */
    record.commands.clear()
    record.tools.clear()
    record.statusBar.clear()
    record.dirtyDocuments.clear()
    record.interceptor = false
    record.contextProvider = false
    this.deps.onToolsChanged()
    this.deps.runtime.dispose(pluginId)
    this.persist()
    this.deps.emitChanged()
  }

  grant(pluginId: string, permissions: readonly PluginPermission[]): void {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    const next = grantPermissions(
      { required: record.manifest.permissions, optional: record.manifest.optionalPermissions, granted: record.granted },
      permissions
    )
    record.granted = [...next.granted]
    // 必选能力一旦被批过,就记进 approvedRequired —— 下次升级拿它比对扩权。
    for (const p of record.manifest.permissions) {
      if (record.granted.includes(p) && !record.approvedRequired.includes(p)) record.approvedRequired.push(p)
    }
    if (record.status === 'pending-approval' && record.manifest.permissions.every((p) => record.approvedRequired.includes(p))) {
      record.status = record.enabled ? 'idle' : 'disabled'
    }
    this.persist()
    this.deps.emitChanged()
  }

  revoke(pluginId: string, permissions: readonly PluginPermission[]): void {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    const next = revokePermissions(
      { required: record.manifest.permissions, optional: record.manifest.optionalPermissions, granted: record.granted },
      permissions
    )
    record.granted = [...next.granted]
    record.approvedRequired = record.approvedRequired.filter((p) => record.granted.includes(p))
    /*
      ★ 撤掉必选能力 = 这个插件不能再跑。留着跑意味着它的每一次调用都会被
      能力门拒掉,而作者和用户都看不出为什么 —— 不如直接停下来。
    */
    if (record.manifest.permissions.some((p) => !record.granted.includes(p))) {
      void this.disable(pluginId)
      return
    }
    this.persist()
    this.deps.emitChanged()
  }

  // ─────────────────────────── 激活 ───────────────────────────

  /**
   * 按激活事件唤醒。已经活着就只是「碰一下」(重置休眠计时)。
   *
   * 返回 `false` = 这个事件没有叫醒任何东西(没装、没启用、待批准、装载失败)。
   */
  async activate(event: string): Promise<boolean> {
    let woke = false
    for (const [id, record] of this.records) {
      if (!record.enabled || record.status === 'error' || record.status === 'pending-approval') continue
      if (!record.manifest.activationEvents.includes(event) && !record.manifest.activationEvents.includes('onStartup')) continue
      woke = (await this.wake(id)) || woke
    }
    return woke
  }

  async wake(pluginId: string): Promise<boolean> {
    const record = this.records.get(pluginId)
    if (record === undefined || !record.enabled) return false
    if (record.status === 'error' || record.status === 'pending-approval' || record.status === 'disabled') return false
    record.touchedAt = Date.now()
    if (record.status === 'active') return true
    if (record.status === 'activating') return true

    record.status = 'activating'
    this.deps.emitChanged()
    try {
      await this.deps.runtime.spawn({ id: pluginId, root: record.root, main: record.manifest.main })
      await this.deps.runtime.invoke(pluginId, { id: 0, kind: 'activate', payload: {} }, PLUGIN_TIMEOUT.ACTIVATE_MS)
      record.status = 'active'
      this.deps.emitChanged()
      return true
    } catch (error) {
      record.status = 'error'
      record.diagnostics.push({
        path: record.manifest.main,
        message: `activate() failed: ${(error as Error).message}`,
        level: 'error'
      })
      this.deps.runtime.dispose(pluginId)
      this.deps.emitChanged()
      return false
    }
  }

  private async deactivate(pluginId: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (record === undefined) return
    try {
      await this.deps.runtime.invoke(pluginId, { id: 0, kind: 'deactivate', payload: {} }, PLUGIN_TIMEOUT.ACTIVATE_MS)
    } catch {
      // deactivate 失败不阻断销毁 —— 一个卡住的插件不该让禁用按钮失灵。
    }
    record.status = record.enabled ? 'idle' : 'disabled'
    this.deps.runtime.dispose(pluginId)
  }

  /** 空闲 5 分钟休眠。**这是这套架构唯一的内存回收路径。** */
  private sweepIdle(): void {
    const now = Date.now()
    for (const [id, record] of this.records) {
      if (record.status !== 'active') continue
      if (now - record.touchedAt < IDLE_SLEEP_MS) continue
      void this.deactivate(id).then(() => {
        const current = this.records.get(id)
        if (current !== undefined && current.status === 'idle') current.status = 'asleep'
        this.deps.emitChanged()
      })
    }
  }

  // ─────────────────────────── 命令 ───────────────────────────

  async runCommand(pluginId: string, commandId: string): Promise<void> {
    const record = this.records.get(pluginId)
    if (record === undefined) throw new Error(`unknown plugin: ${pluginId}`)
    if (!record.manifest.contributes.commands.some((c) => c.command === commandId)) {
      throw new Error(`plugin ${pluginId} does not contribute ${commandId}`)
    }
    // ★ 命令本身就是激活事件 —— 点菜单是插件第一次被叫醒的最常见方式。
    if (!(await this.activateFor(`onCommand:${commandId}`, pluginId))) {
      /*
        ★ 把**最近一条诊断**带上。`wake` 失败时已经把真正的原因(activate()
        抛了什么、宿主页面为什么没握手)写进了 `record.diagnostics`,
        只抛一句笼统的「could not be activated」等于把那条信息锁在插件详情页里,
        而用户在控制台看到的是一句指向不了任何东西的话。
      */
      const why = record.diagnostics.at(-1)?.message
      throw new Error(
        `plugin ${pluginId} could not be activated${why === undefined ? '' : `: ${why}`}`
      )
    }
    await this.deps.runtime.invoke(
      pluginId,
      { id: 0, kind: 'command.run', payload: { commandId } },
      PLUGIN_TIMEOUT.COMMAND_MS
    )
  }

  private async activateFor(event: string, pluginId: string): Promise<boolean> {
    const record = this.records.get(pluginId)
    if (record === undefined) return false
    if (!record.manifest.activationEvents.includes(event) && !record.manifest.activationEvents.includes('onStartup')) {
      /*
        清单里没声明这个激活事件,但用户点了它贡献的菜单 —— 这是清单写漏了。
        **仍然激活**(用户的意图很明确),同时记一条诊断给作者。
      */
      record.diagnostics.push({
        path: 'activationEvents',
        message: `"${event}" is missing from activationEvents; the host activated the plugin anyway`,
        level: 'warn'
      })
    }
    return this.wake(pluginId)
  }

  // ─────────────────────────── RPC 四道门 ───────────────────────────

  /**
   * 插件 → 主进程的一次调用。**这是整个插件系统的收口点。**
   *
   * 四道门的顺序在 `shared/plugin/protocol.ts` 的文件头里写着,
   * 这里逐条对应。每一条都会落一行活动日志,包括被拒的那些 ——
   * 被拒的那些恰恰是用户最想看见的。
   */
  async handleRequest(pluginId: string, request: PluginRequest): Promise<PluginResponse> {
    const started = Date.now()
    const record = this.records.get(pluginId)
    const fail = (code: PluginErrorCode, message: string): PluginResponse => {
      recordActivity({
        ts: started,
        pluginId,
        method: String(request.method),
        summary: message,
        verdict: code === 'timeout' ? 'timeout' : code === 'permission_denied' || code === 'rejected' ? 'denied' : 'error',
        durationMs: Date.now() - started
      })
      return { id: request.id, ok: false, error: { code, message } }
    }

    if (record === undefined) return fail('internal_error', 'plugin is not installed')
    if (!record.enabled || record.status === 'pending-approval') {
      return fail('permission_denied', 'plugin is not enabled')
    }

    // ① 白名单 —— 先回答「有没有这个方法」,再回答「你能不能用」。
    if (!isPluginMethod(request.method)) return fail('unknown_method', `unknown method: ${String(request.method)}`)
    const method = request.method

    // ② 能力
    const needed = PLUGIN_METHOD_PERMISSION[method]
    if (needed !== null) {
      const declared = [...record.manifest.permissions, ...record.manifest.optionalPermissions].includes(needed)
      if (!declared) return fail('permission_denied', `the manifest does not declare "${needed}"`)
      const state: PluginPermissionState = {
        required: record.manifest.permissions,
        optional: record.manifest.optionalPermissions,
        granted: record.granted
      }
      if (!hasPermission(state, needed)) return fail('permission_denied', `"${needed}" has not been granted`)
    }

    record.touchedAt = Date.now()

    /*
      ★ **注册类方法在能力门之后、参数门之前单独处理。**

      它们和 `workspace.readFile` 那一类不同:后者是「替插件做一件事」,
      而这些是「插件在宿主这边登记一个东西」——它们改的是宿主自己的表
      (工具注册表、命令表、授权状态),不碰文件系统也不走权限链。
      混进 `invokeCapability` 会让那个函数同时背两种职责,而它已经是
      整个系统里最需要一眼看懂的一段了。
    */
    const hostHandled = await this.handleHostMethod(pluginId, record, method, request.params)
    if (hostHandled !== undefined) {
      recordActivity({
        ts: started,
        pluginId,
        method,
        summary: hostHandled.summary,
        verdict: 'ok',
        durationMs: Date.now() - started
      })
      return { id: request.id, ok: true, data: hostHandled.data }
    }

    const workspace = this.deps.currentWorkspace()
    const ctx: CapabilityContext = {
      pluginId,
      manifest: record.manifest,
      host: this.deps.host,
      workspaceRoot: workspace.rootPath,
      workspaceId: workspace.id,
      allowedCommands: [],
      approve: (summary) => this.deps.approve(pluginId, summary),
      kv: this.kvFor(pluginId)
    }

    try {
      // ③ 参数门 + ④ 行为门都在 handler 里 —— 它们需要文件系统与权限链。
      const outcome = await withTimeout(
        invokeCapability(method as PluginMethod, request.params as never, ctx),
        PLUGIN_TIMEOUT.REQUEST_MS
      )
      recordActivity({
        ts: started,
        pluginId,
        method,
        summary: outcome.summary,
        verdict: 'ok',
        durationMs: Date.now() - started
      })
      return { id: request.id, ok: true, data: outcome.data }
    } catch (error) {
      if (error instanceof CapabilityError) return fail(error.code, error.message)
      if ((error as Error).message === 'plugin_timeout') return fail('timeout', 'the call timed out')
      return fail('internal_error', (error as Error).message)
    }
  }

  /**
   * 「在宿主这边登记一个东西」类的方法。
   *
   * 返回 `undefined` = 这个方法不归我管,交给 `invokeCapability`。
   * 用 `undefined` 而不是布尔,是为了让「处理了但没有返回值」和「没处理」
   * 在类型上分得开 —— 否则 `tools.register` 这种返回空对象的会被当成没处理。
   */
  private async handleHostMethod(
    pluginId: string,
    record: PluginRecord,
    method: PluginMethod,
    rawParams: unknown
  ): Promise<{ data: unknown; summary: string } | undefined> {
    switch (method) {
      case 'permissions.contains': {
        const p = rawParams as { permissions: PluginPermission[] }
        const state: PluginPermissionState = {
          required: record.manifest.permissions,
          optional: record.manifest.optionalPermissions,
          granted: record.granted
        }
        return { data: { granted: hasPermission(state, p.permissions) }, summary: `contains ${p.permissions.join(',')}` }
      }

      case 'permissions.request': {
        const p = rawParams as { permissions: PluginPermission[]; reasonKey: string }
        const state: PluginPermissionState = {
          required: record.manifest.permissions,
          optional: record.manifest.optionalPermissions,
          granted: record.granted
        }
        /*
          ★ **铁律**:要的东西必须在 `permissions ∪ optionalPermissions` 之内,
          之外的**直接拒绝、不弹窗**。弹了就意味着用户有机会点「允许」,
          而那一刻他看到的授权界面和市场里那份清单已经对不上了。
        */
        if (!canRequest(state, p.permissions)) {
          return { data: { granted: false }, summary: `request denied (outside the manifest): ${p.permissions.join(',')}` }
        }
        if (hasPermission(state, p.permissions)) return { data: { granted: true }, summary: 'already granted' }
        const approved = await this.deps.requestPermissions(pluginId, p.permissions, p.reasonKey)
        if (approved) this.grant(pluginId, p.permissions)
        return { data: { granted: approved }, summary: `request ${p.permissions.join(',')}` }
      }

      case 'permissions.remove': {
        const p = rawParams as { permissions: PluginPermission[] }
        this.revoke(pluginId, p.permissions)
        return { data: {}, summary: `remove ${p.permissions.join(',')}` }
      }

      case 'commands.register': {
        const p = rawParams as { commandId: string }
        /*
          ★ 只认**清单里声明过**的命令 id。不认的话,一个插件可以在运行期
          注册任意命令 id —— 而菜单、快捷键、命令面板都按 id 分发,
          那等于让它能劫持别人的命令。
        */
        if (!record.manifest.contributes.commands.some((c) => c.command === p.commandId)) {
          return { data: {}, summary: `ignored undeclared command ${p.commandId}` }
        }
        record.commands.add(p.commandId)
        return { data: {}, summary: `register ${p.commandId}` }
      }

      case 'commands.unregister': {
        const p = rawParams as { commandId: string }
        record.commands.delete(p.commandId)
        return { data: {}, summary: `unregister ${p.commandId}` }
      }

      case 'tools.register': {
        const p = rawParams as PluginToolDeclaration
        if (!isValidPluginToolName(p.name)) {
          return { data: {}, summary: `rejected tool name ${p.name}` }
        }
        // 同命令:只认清单里声明过的工具名,否则市场审核看到的能力上界就不作数了。
        if (!record.manifest.contributes.tools.some((t) => t.name === p.name)) {
          return { data: {}, summary: `ignored undeclared tool ${p.name}` }
        }
        record.tools.set(p.name, p)
        this.deps.onToolsChanged()
        return { data: {}, summary: `register tool ${p.name}` }
      }

      case 'tools.unregister': {
        const p = rawParams as { name: string }
        record.tools.delete(p.name)
        this.deps.onToolsChanged()
        return { data: {}, summary: `unregister tool ${p.name}` }
      }

      case 'agent.registerInterceptor':
        record.interceptor = true
        return { data: {}, summary: 'register interceptor' }

      case 'agent.registerContextProvider':
        record.contextProvider = true
        return { data: {}, summary: 'register context provider' }

      case 'window.setStatusBarItem': {
        const p = rawParams as { id: string; textKey: string | null; tooltipKey?: string; command?: string }
        if (typeof p.id !== 'string' || p.id === '' || p.id.length > 64) {
          return { data: {}, summary: 'rejected status bar id' }
        }
        if (p.textKey === null) {
          record.statusBar.delete(p.id)
          this.deps.emitChanged()
          return { data: {}, summary: `clear status bar ${p.id}` }
        }
        /*
          ★ 三条收窄,每条都对着一种「状态栏被当成广告位」的用法:

          1. **格数有上限**。一个插件挂二十格,状态栏就没别人的位置了。
          2. **`textKey` 必须是 key**,不是文案 —— 见 `PluginStatusBarItem`。
             这里只校验形状(不含空格、不太长);它查不到时会显示成 key 本身,
             那正是我们想要的「看得见的缺失」。
          3. **`command` 必须是它自己贡献过的**。不校验的话,点一下状态栏
             就能触发别的插件的命令。
        */
        if (record.statusBar.size >= 3 && !record.statusBar.has(p.id)) {
          return { data: {}, summary: 'status bar item limit reached' }
        }
        if (/\s/.test(p.textKey) || p.textKey.length > 128) {
          return { data: {}, summary: 'rejected status bar textKey (must be an l10n key)' }
        }
        const command = p.command !== undefined && record.manifest.contributes.commands.some((c) => c.command === p.command)
          ? p.command
          : undefined
        record.statusBar.set(p.id, {
          id: p.id,
          pluginId,
          textKey: p.textKey,
          ...(p.tooltipKey === undefined ? {} : { tooltipKey: p.tooltipKey }),
          ...(command === undefined ? {} : { command })
        })
        this.deps.emitChanged()
        return { data: {}, summary: `status bar ${p.id}` }
      }

      case 'customEditors.register': {
        const p = rawParams as { viewType: string }
        // 同命令与工具:只认清单里声明过的 viewType。
        if (!record.manifest.contributes.customEditors.some((e) => e.viewType === p.viewType)) {
          return { data: {}, summary: `ignored undeclared viewType ${p.viewType}` }
        }
        return { data: {}, summary: `register editor ${p.viewType}` }
      }

      case 'customEditors.setDirty': {
        const p = rawParams as { documentId: string; path: string; dirty: boolean }
        if (typeof p.documentId !== 'string' || p.documentId === '') return { data: {}, summary: 'rejected documentId' }
        if (p.dirty) record.dirtyDocuments.set(p.documentId, typeof p.path === 'string' ? p.path : '')
        else record.dirtyDocuments.delete(p.documentId)
        return { data: {}, summary: `${p.dirty ? 'dirty' : 'clean'} ${p.path}` }
      }

      case 'tabs.openCustomEditor': {
        const p = rawParams as { viewType: string; path: string }
        // 同 `customEditors.register`:只认清单里声明过的 viewType。不认的话,
        // 一个插件可以请求打开**别人**的编辑器。
        if (!record.manifest.contributes.customEditors.some((e) => e.viewType === p.viewType)) {
          return { data: {}, summary: `ignored undeclared viewType ${String(p.viewType)}` }
        }
        /*
          ★ 路径在这里就收窄,不留到渲染层。渲染层拿到的是一条广播,
          它没有「这个插件能碰哪个根」的上下文 —— 把判断留给它等于把这道门
          交给一个看不见能力状态的地方。
        */
        const narrowed = narrowWorkspacePath(this.deps.currentWorkspace().rootPath, p.path)
        if (!narrowed.ok) return { data: {}, summary: `rejected path: ${narrowed.reason}` }
        this.deps.openCustomEditor(pluginId, p.viewType, p.path)
        return { data: {}, summary: `open ${p.viewType} ${p.path}` }
      }

      case 'configuration.get':
        return { data: { values: this.configuration(pluginId) }, summary: 'configuration.get' }

      case 'window.showMessage': {
        const p = rawParams as { kind: 'info' | 'warn' | 'error'; messageKey: string; params?: Record<string, string | number> }
        /*
          ★ 传的是 **key + params**,不是渲染好的句子。主进程新增代码一律只传 key
          (计划 §8.3),由渲染层 `t()` 渲染 —— 否则通知里那句话永远是插件作者
          写死的那一种语言。
        */
        this.deps.showMessage(pluginId, p.kind, p.messageKey, p.params ?? {})
        return { data: {}, summary: `${p.kind}: ${p.messageKey}` }
      }

      case 'commands.execute': {
        const p = rawParams as { commandId: string; args?: unknown }
        /*
          ★ **只能执行自己贡献的命令。** 允许跨插件执行等于给了一条绕过所有
          能力门的路:A 插件没有 `process` 能力,但它可以去调 B 插件那条
          「跑构建」的命令。宿主自己的命令同理不开放 —— 那是 UI 层的事,
          不是插件能力的一部分。
        */
        if (!record.manifest.contributes.commands.some((c) => c.command === p.commandId)) {
          return { data: { value: null }, summary: `refused cross-plugin command ${p.commandId}` }
        }
        const value = await this.deps.runtime.invoke(
          pluginId,
          { id: 0, kind: 'command.run', payload: { commandId: p.commandId, args: p.args } },
          PLUGIN_TIMEOUT.COMMAND_MS
        )
        return { data: { value }, summary: `execute ${p.commandId}` }
      }

      default:
        return undefined
    }
  }

  // ─────────────────────────── Agent 侧贡献 ───────────────────────────

  /**
   * 这一刻所有启用插件贡献的工具。`registerToolProvider` 每次装配都会问一遍 ——
   * 所以禁用一个插件之后,它的工具在**下一次**装配时就没了,不需要额外下线。
   */
  contributedTools(): ToolRegistration[] {
    const out: ToolRegistration[] = []
    for (const [pluginId, record] of this.records) {
      if (!record.enabled || record.status === 'error' || record.status === 'pending-approval') continue
      for (const declaration of record.tools.values()) {
        out.push(
          toolRegistrationFor(pluginId, declaration, async (name, input, callId, signal) => {
            // 工具调用本身也是一次「碰一下」,免得跑着跑着被休眠扫走。
            record.touchedAt = Date.now()
            const invocation = this.deps.runtime.invoke(
              pluginId,
              { id: 0, kind: 'tool.execute', payload: { name, input, callId } },
              PLUGIN_TIMEOUT.TOOL_MS
            )
            /*
              ★ 用户点停止 → 给插件发一条 `tool.abort`,然后**只等 2 秒宽限**。
              等不到就按工具失败返回、run 继续 —— 一个不理会中断的插件不该
              把整条 run 钉死在那里。
            */
            const onAbort = (): void => {
              void this.deps.runtime.invoke(
                pluginId,
                { id: 0, kind: 'tool.abort', payload: { name, callId } },
                PLUGIN_TIMEOUT.ABORT_GRACE_MS
              ).catch(() => undefined)
            }
            signal.addEventListener('abort', onAbort, { once: true })
            try {
              return await invocation
            } finally {
              signal.removeEventListener('abort', onAbort)
            }
          })
        )
      }
    }
    return out
  }

  /**
   * 工具拦截器的合并表决。
   *
   * ★ **只能收紧,不能放宽** —— 这一条对应 `kernel/permission-decision.ts`
   * 的优先级本体:`deny` 压过一切,`ask` 压过 `allow`。插件返回 `allow`
   * 在这里被**当成弃权**,因为让一个第三方插件把审批弹窗关掉,等于把
   * 整条权限链的最后一道门交给它。
   *
   * ★ 超时 = 弃权(fail-open,只记诊断),同 `kernel/hook/run.ts`:
   * 一个卡住的插件不该把所有工具调用堵死。
   */
  async intercept(input: {
    toolName: string
    toolInput: unknown
    readOnly: boolean
    destructive: boolean
  }): Promise<{ deny?: string; ask?: boolean }> {
    let ask = false
    for (const [pluginId, record] of this.records) {
      if (!record.interceptor || !record.enabled || record.status !== 'active') continue
      try {
        const verdict = (await this.deps.runtime.invoke(
          pluginId,
          { id: 0, kind: 'interceptor.willInvoke', payload: input },
          PLUGIN_TIMEOUT.INTERCEPTOR_MS
        )) as { decision?: string; reasonKey?: string } | undefined
        if (verdict?.decision === 'deny') return { deny: verdict.reasonKey ?? `denied by ${pluginId}` }
        if (verdict?.decision === 'ask') ask = true
        // `allow` 落在这里 —— 什么都不做,也就是弃权。
      } catch (error) {
        record.diagnostics.push({
          path: 'agent.registerToolInterceptor',
          message: `willInvoke did not answer in time: ${(error as Error).message}`,
          level: 'warn'
        })
      }
    }
    return ask ? { ask: true } : {}
  }

  /**
   * 本轮要注入的上下文。
   *
   * 强制包裹 + 双重上限(单次 / 每轮)。**不是系统提示词** —— 插件永远拿不到
   * 往系统提示词里塞东西的杠杆,理由见计划 §3.5。
   */
  async provideContext(input: { prompt: string }): Promise<string> {
    const chunks: string[] = []
    let total = 0
    for (const [pluginId, record] of this.records) {
      if (!record.contextProvider || !record.enabled || record.status !== 'active') continue
      if (total >= PLUGIN_CONTEXT_LIMIT.PER_TURN) break
      try {
        const text = (await this.deps.runtime.invoke(
          pluginId,
          { id: 0, kind: 'context.provide', payload: input },
          PLUGIN_TIMEOUT.CONTEXT_MS
        )) as string | undefined
        if (typeof text !== 'string' || text === '') continue
        const wrapped = wrapPluginContext(
          pluginId,
          text,
          Math.min(PLUGIN_CONTEXT_LIMIT.PER_CALL, PLUGIN_CONTEXT_LIMIT.PER_TURN - total)
        )
        if (wrapped === '') continue
        total += wrapped.length
        chunks.push(wrapped)
      } catch {
        // 超时/抛错 = 这一轮少一段上下文,不是一次失败的 run。
      }
    }
    return chunks.join('\n\n')
  }

  // ─────────────────────────── 关 Tab 前的挽留 ───────────────────────────

  /**
   * 关掉这个文件之前,先让还脏着的插件编辑器把它存了。
   *
   * ★ **不做这一步,关 Tab 会静默丢图。** 内置文档的挽留走
   * `stores/documents.ts` 的 `confirmDocumentChanges`,而那个函数只问
   * `documents` store —— 插件编辑器的改动根本不在那张表里。
   *
   * ★ 这里的语义是「**存**,不是问」:问一次需要一个能显示插件文档的对话框,
   * 而宿主不知道那份文档长什么样。让插件自己存下来,失败才拦住关闭 ——
   * 用户既不会丢东西,也不会为一个能自动处理的情况多点一次。
   *
   * 返回 `false` = 有东西没存成,**不要关**。
   */
  async saveBeforeClose(input: { path?: string }): Promise<boolean> {
    let ok = true
    for (const [pluginId, record] of this.records) {
      if (record.status !== 'active' || record.dirtyDocuments.size === 0) continue
      for (const [documentId, path] of [...record.dirtyDocuments]) {
        // `path` 省略 = 问这个插件的全部脏文档(关工作区、退出应用走这条)
        if (input.path !== undefined && path !== input.path) continue
        try {
          await this.deps.runtime.invoke(
            pluginId,
            { id: 0, kind: 'customEditor.save', payload: { documentId, path } },
            PLUGIN_TIMEOUT.COMMAND_MS
          )
          record.dirtyDocuments.delete(documentId)
        } catch (error) {
          /*
            存不下来 —— 拦住关闭,并留一条诊断。**不能默默放行**:
            那正是「关 Tab 丢图」那条路。
          */
          ok = false
          record.diagnostics.push({
            path,
            message: `the editor could not save before closing: ${(error as Error).message}`,
            level: 'error'
          })
        }
      }
    }
    if (!ok) this.deps.emitChanged()
    return ok
  }

  // ─────────────────────────── 设置项 ───────────────────────────

  /**
   * 这个插件此刻的设置值 = 清单里的默认值 + 用户改过的那些。
   *
   * ★ **不扩 `AppSettings` 那个 blob**(计划 §6.2):那份设置是全应用的,
   * 每一次写都要整份重写、整份同步。插件设置放独立 kv,一个插件的开关
   * 改了不会让另一台机器把整份应用设置拉一遍。
   *
   * ★ 读的时候**以清单为准**:用户改过、后来插件升级把那一项删掉了 ——
   * 残留的值不该还出现在结果里,否则插件会读到一个它已经不认识的键。
   */
  configuration(pluginId: string): Record<string, boolean | string | number> {
    const record = this.records.get(pluginId)
    if (record === undefined) return {}
    const properties = record.manifest.contributes.configuration?.properties ?? {}
    const stored = this.deps.getKv<Record<string, boolean | string | number>>(`plugins.config.${pluginId}`, {})
    const out: Record<string, boolean | string | number> = {}
    for (const [key, property] of Object.entries(properties)) {
      const value = stored[key]
      out[key] = isAssignable(property.type, value) ? value : (property.default ?? defaultFor(property.type))
    }
    return out
  }

  /** 用户在详情页里改了一项。类型对不上的直接丢掉,不写进 kv。 */
  setConfiguration(pluginId: string, key: string, value: boolean | string | number | null): void {
    const record = this.records.get(pluginId)
    const property = record?.manifest.contributes.configuration?.properties[key]
    if (record === undefined || property === undefined) return
    const stored = this.deps.getKv<Record<string, boolean | string | number>>(`plugins.config.${pluginId}`, {})
    // null = 恢复默认值。删掉那一条,而不是写一个 null 进去 —— 后者会让
    // 「用户没设过」和「用户设成了空」变成同一件事。
    if (value === null) delete stored[key]
    else if (isAssignable(property.type, value)) stored[key] = value
    else return
    this.deps.setKv(`plugins.config.${pluginId}`, stored)
    this.deps.emitChanged()
  }

  private kvFor(pluginId: string): CapabilityContext['kv'] {    const key = `plugins.kv.${pluginId}`
    const read = (): Record<string, string> => this.deps.getKv<Record<string, string>>(key, {})
    return {
      get: (k) => read()[k] ?? null,
      set: (k, value) => {
        const current = read()
        if (value === null) delete current[k]
        else current[k] = value
        this.deps.setKv(key, current)
      },
      keys: () => Object.keys(read()),
      usedBytes: () => JSON.stringify(read()).length
    }
  }

  private persist(): void {
    const state: PersistedState = {}
    for (const [id, record] of this.records) {
      state[id] = {
        enabled: record.enabled,
        granted: record.granted,
        approvedRequired: record.approvedRequired,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt
      }
    }
    this.deps.setKv(KV_KEY, state)
  }
}

function isAssignable(type: string, value: unknown): value is boolean | string | number {
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'string'
}

function defaultFor(type: string): boolean | string | number {
  return type === 'boolean' ? false : type === 'number' ? 0 : ''
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('plugin_timeout')) }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
