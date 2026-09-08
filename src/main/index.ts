/**
 * KernelHost 之外唯一允许 import electron 的地方之一(窗口/生命周期)。
 * 内核代码永远不从这里 import —— 依赖方向是单向的:main → kernel,不反向。
 */
import { dirname, join } from 'node:path'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import appIconPath from '../../resources/icon.png?asset'
import { closeDatabase, defaultDatabaseDirectory, DB_FILENAME, openDatabase } from './db'
import { probeSqlite, type SqliteProbeResult } from './db/probe'
import { electronHost } from './host'
import { flushPendingPersists, registerIpc, shutdownRuns, shutdownTerminals } from './ipc'
import { installAttachmentProtocol, registerAttachmentScheme } from './net/attachment-protocol'
import { applyProxy, installProxyAuth } from './net/proxy'
import { initRuntime, shutdownMcp, shutdownSessionTitles } from './runtime'
import { installUserAgent } from './kernel/user-agent'
import { store } from './state/store'
import { initTray, destroyTray } from './tray'
import { windows } from './window/registry'
import { titleBarOptions, watchMaximized } from './window/title-bar'
import { setSessionWindowOpener } from './ipc/app'

// ─────────────────────────────────────────────────────────────────────────────
// 单实例锁 —— 必须在 whenReady 之前。方案 §9:两个实例开同一个 SQLite 文件,
// 即使有 WAL 也会打架。第一天就加,后补要动启动时序。
// ─────────────────────────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// 出站 API 请求的自报家门。哪些请求带、哪些**刻意不带**,那张表在 kernel/user-agent.ts。
// 版本号只有主进程拿得到,所以装配点在这里;`app.getVersion()` 不要求 ready。
installUserAgent(app.getVersion())

// 标题栏关闭按钮不再等于退出进程 —— 只隐藏窗口,真正退出只能走托盘的
// 「退出 NextCoWork」(或系统层面的 Cmd+Q/kill)。这两条路径都会先触发
// `before-quit`,所以在那里把这个标记置 true,窗口的 `close` 处理器
// 才放行真正的销毁;不然每个窗口都会在 `before-quit` 之后各自 preventDefault
// 一次,进程永远退不掉。
let isQuitting = false

/**
 * 数据根 —— userData、SQLite 主库、附件、skills/agents 文件树全部从这里派生。
 *
 * 开发时是 `<cwd>/.next-cowork`:项目级携带、备份方便,仓库里的探针也都假设在这儿。
 *
 * ★ 打包后**必须换成系统的 per-user 目录**。发行版的 `process.cwd()` 是没有意义的:
 * Windows 从快捷方式启动时它是**安装目录**,数据会在卸载/升级时被一起清掉;而从
 * 别的目录双击 exe,又会凭空开出一个空库 —— 用户看到的是「我的会话全没了」,
 * 而不是任何一条能指向工作目录的线索。
 *
 * 打包分支直接用 Electron 默认的 userData(`%APPDATA%\NextCoWork` /
 * `~/Library/Application Support/NextCoWork`),所以那条路径下面就不再 setPath 了。
 */
function resolveDataRoot(): string {
  return app.isPackaged ? app.getPath('userData') : defaultDatabaseDirectory()
}

// 应用数据、附件和 Electron profile 统一落在数据根下。
// 必须在 app ready 之前设置才生效。
const legacyUserDataPath = app.getPath('userData')
if (!app.isPackaged) app.setPath('userData', defaultDatabaseDirectory())

/*
  ★ **必须在 `app.whenReady()` 之前** —— 与单实例锁、userData 改路径同属
  「ready 之前才有效」的那一类。

  放到 ready 之后不会报任何错,协议照样注册得上,但 `standard` / `secure` /
  `stream` 这些 privileges 会**全部丢失**。症状是彼此看起来毫无关联的一组故障:
  图片有时能显示、`fetch('ncw://…')` 报 CORS、视频不能拖进度条 ——
  没有一条会指向「注册时机不对」。
*/
registerAttachmentScheme()

// 步骤 0 的 sqlite 探针。留着不删:将来升 Electron 大版本时,
// 它是第一个会告诉你出事的地方(方案 §9)。
function logStartupProbe(): void {
  void probeSqlite().then((r: SqliteProbeResult) => {
    if (r.ok) {
      console.log(
        `[db] node:sqlite OK · sqlite ${r.sqliteVersion} · ` +
          `fts5 ${r.fts5 ? '✓' : '✗'} · json1 ${r.json1 ? '✓' : '✗'} · rtree ${r.rtree ? '✓' : '✗'}`
      )
    } else {
      console.error(`[db] node:sqlite 不可用 —— 需退回 better-sqlite3。原因: ${r.reason}`)
    }
    console.log(
      `[app] electron ${process.versions.electron} · node ${process.versions.node} · chrome ${process.versions.chrome}`
    )
  })
}

function isSafeBrowserUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

function createMainWindow(sessionRoute?: { workspaceId: string; sessionId: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1c1b19',
    // Windows/Linux 的任务栏与窗口图标(macOS 忽略,那边走下面的 app.dock.setIcon)
    icon: nativeImage.createFromPath(appIconPath),
    // macOS:红绿灯嵌进侧边栏(方案 §8)。Windows/Linux:只去掉系统标题栏,
    // 三颗按钮由渲染层自绘 —— 两边的取舍写在 window/title-bar.ts 的文件头。
    ...titleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // ★ 三件套。sandbox: true 是本项目 preload 必须完整打包成单文件的原因
      // (沙箱下无法 require 多文件),见 electron.vite.config.ts。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Browser tabs use Electron's isolated <webview> element. It remains
      // sandboxed and nodeIntegration-free; enabling the tag does not expose
      // the host preload bridge to page content.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 关闭按钮只隐藏,不销毁窗口——保留页面状态(当前会话/滚动位置/未保存的输入),
  // 靠托盘图标唤回。真正退出时 `isQuitting` 已经在 `before-quit` 里置位,这里放行。
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })

  // 任何 window.open / target=_blank 一律不在应用内开新窗口,交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    // Renderer-controlled session links open another app window, while all
    // other external targets continue to use the system browser policy.
    const appUrl = win.webContents.getURL().split('#')[0]
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if ((typeof appUrl === 'string' && appUrl !== '' && url.startsWith(appUrl)) || (typeof devUrl === 'string' && url.startsWith(devUrl))) {
      return { action: 'allow' }
    }
    return { action: 'deny' }
  })

  // Browser workbench pages run in a separate, sandboxed webview session.
  // Never allow a page to inherit the app preload or load local/custom-scheme
  // resources. Links opened by a page leave through the system browser.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.disableDialogs = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    if (typeof params.src === 'string' && params.src !== '' && !isSafeBrowserUrl(params.src)) event.preventDefault()
  })

  win.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeBrowserUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (!isSafeBrowserUrl(url)) event.preventDefault()
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.session.setPermissionCheckHandler(() => false)
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  })

  // 阻止渲染层被导航到站外(拖入链接、意外的 location 赋值)。
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  // 先登记再加载:渲染层的 window:ready 一到就要能查到 kind。
  // 登记晚了,markReady 会走 of() 的兜底分支,kind 判断不准。
  windows.register(win.webContents, 'main')

  // 自绘的最大化/还原按钮要跟着窗口的**真实**状态走 —— 用户也可能拖窗口边缘、
  // 双击 Tab 条、按 Win+↑。挂在 register 之后:push 走的就是 registry。
  watchMaximized(win)

  /*
    路由写在 hash 里:`#/{workspaceId}` 是「这个工作区,新对话」,
    `#/{workspaceId}/{sessionId}` 是「这一段会话」。渲染层进来后按它落位,
    之后 hash 一直跟着激活的 Tab 走(见 `renderer/shell/AppShell.tsx`)。
    ★ `loadFile` 的 hash 参数**不带 `#`**,Electron 自己加。
  */
  const route = sessionRoute === undefined
    ? undefined
    : `/${encodeURIComponent(sessionRoute.workspaceId)}/${encodeURIComponent(sessionRoute.sessionId)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${route === undefined ? '' : `#${route}`}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), route === undefined ? undefined : { hash: route })
  }

  return win
}

/**
 * 首次切换到新数据根时保留旧版 Electron userData 数据库。
 * 只在目标库不存在时复制，不覆盖用户已经生成的库。
 *
 * 打包后 `resolveDataRoot()` 就是 `legacyUserDataPath` 本身,两条路径相同,
 * 下面的 `existsSync` 判断自然退化成 no-op —— 不需要额外分支。
 */
function prepareProjectDatabaseDirectory(): string {
  const targetDir = resolveDataRoot()
  const targetPath = join(targetDir, DB_FILENAME)
  const legacyPath = join(legacyUserDataPath, DB_FILENAME)
  if (!existsSync(targetPath) && existsSync(legacyPath)) {
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(legacyPath, targetPath)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${legacyPath}${suffix}`
      if (existsSync(source)) copyFileSync(source, `${targetPath}${suffix}`)
    }
    // Move application-owned file trees alongside the copied database. The
    // attachment rows contain absolute paths, so rewrite those references in
    // the copied database before the normal migration runner opens it.
    const managedDirs = ['attachments', 'skills', 'agents', 'workspaces']
    for (const name of managedDirs) {
      const source = join(legacyUserDataPath, name)
      const target = join(targetDir, name)
      if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
    }
    const legacyInstructions = join(legacyUserDataPath, 'AGENTS.md')
    const targetInstructions = join(targetDir, 'AGENTS.md')
    if (existsSync(legacyInstructions) && !existsSync(targetInstructions)) {
      copyFileSync(legacyInstructions, targetInstructions)
    }
    // Legacy themes lived beside the old database; their new canonical home
    // is the shared attachments/themes subtree.
    const legacyThemes = join(legacyUserDataPath, 'themes')
    const targetThemes = join(targetDir, 'attachments', 'themes')
    if (existsSync(legacyThemes) && !existsSync(targetThemes)) {
      mkdirSync(dirname(targetThemes), { recursive: true })
      cpSync(legacyThemes, targetThemes, { recursive: true })
    }
    try {
      const migrated = new DatabaseSync(targetPath)
      const oldRoot = legacyUserDataPath
      migrated.prepare('UPDATE attachments SET path = REPLACE(path, ?, ?) WHERE path LIKE ?').run(
        join(oldRoot, 'attachments'),
        join(targetDir, 'attachments'),
        `${join(oldRoot, 'attachments')}%`
      )
      migrated.prepare('UPDATE sessions SET root_path_at_creation = REPLACE(root_path_at_creation, ?, ?) WHERE root_path_at_creation LIKE ?').run(
        join(oldRoot, 'workspaces'),
        join(targetDir, 'workspaces'),
        `${join(oldRoot, 'workspaces')}%`
      )
      migrated.close()
    } catch (err) {
      console.warn(`[db] 旧数据库路径迁移未完成，将保留原数据并继续启动: ${String(err)}`)
    }
    console.log(`[db] 已将旧数据库迁移到 ${targetDir}`)
  }
  return targetDir
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nextcowork.app')

  // ★ dev 与未打包运行时的 dock 图标。打包后的 .app 由 electron-builder 从
  // build/icon.png 生成 icns 内嵌,但 `electron-vite dev` / 直接跑 out/ 都不经过
  // electron-builder —— 那两种情况下 dock 显示的是 Electron 二进制自带的原子图标。
  // 这一句把 dock 图标在所有运行方式下统一成我们自己的(打包后再设一次也无副作用)。
  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath))
  }

  app.on('browser-window-created', (_, window) => {
    // dev 下 F12 开 devtools、生产下屏蔽 CommandOrControl+R
    optimizer.watchWindowShortcuts(window)
  })

  logStartupProbe()

  /**
   * ★ 必须在 `registerIpc()` 之前:渲染层握手的第一个 invoke 是 `app:getBootstrap`,
   * 而 bootstrap 要带上默认模型 —— 那是 `initRuntime` 的 seed 才填上的。
   * 顺序反了,首屏的模型选择器就是空的,直到下一次重启才对。
   *
   * 也必须在这里(而不是模块顶层)构造 host:`safeStorage` 与 `net.fetch` 都要求 app ready。
   */
  /*
    ★ **必须排在 `initRuntime()` 前面**:seed 会往 providers 表写内置上游,
    而在库打开之前碰 store 的话,那些行会落进一个内存兜底库里,
    换成文件库时凭空消失 —— 症状正好是「配置重启后没了」,也就是持久化
    根本没做时的原症状,没人会怀疑到调用顺序上来。`openDatabase()` 因此
    在重复调用时直接抛错,把这个顺序钉死。

    数据库目录固定为当前工作目录下的 `.next-cowork/`，与 Electron 的
    `userData` 路径解耦；`openDatabase` 会在首次启动时自动创建它。
  */
  // SQLite 主库及应用管理的文件资源统一使用项目级 .next-cowork 目录。
  openDatabase(prepareProjectDatabaseDirectory())

  /*
    ★ 第二段。必须排在 `openDatabase` 之后 —— 附件根目录由当前数据库目录
    派生，协议读取、上传和 storage 清理必须始终指向同一棵项目级数据树。
  */
  installAttachmentProtocol()

  initRuntime(electronHost())

  /*
    ★ 代理必须在**任何一次出站请求之前**装好。`initRuntime` 已经把 host 装上了,
    但它自己不发请求;第一个真的出站是渲染层握手之后的模型探活。排在这之后的话,
    那几次请求会走直连 —— 而在只有代理才能出网的网络里,表现是「刚启动那会儿
    连不上,过一会儿就好了」,一个几乎没法复现的故障。

    不 await:`setProxy` 是异步的,而 `whenReady` 这个回调是同步的。建窗和
    注册 IPC 不依赖代理装完,而 Chromium 在 setProxy 落地前发出的请求会排队。
  */
  installProxyAuth()
  void applyProxy(store.getSettings().proxy)

  // 契约里的每个频道在这里一次性注册完(缺一个就编译不过)。
  // 必须在建窗之前:渲染层的第一个 invoke 可能在窗口 show 之前就到。
  setSessionWindowOpener((workspaceId, sessionId) => {
    const child = createMainWindow({ workspaceId, sessionId })
    child.once('ready-to-show', () => child.focus())
  })
  registerIpc()

  createMainWindow()

  // 菜单栏托盘。放在建窗之后:它的「显示窗口」要能拿到已经存在的那个窗口。
  initTray(showMainWindow)

  // dock 图标点击也走同一套「唤回」逻辑——窗口关闭后是隐藏不是销毁,
  // 所以这里几乎不会撞见 `length === 0` 的分支,但保留它兜底手动 destroy() 的情况。
  app.on('activate', showMainWindow)
})

/** 从托盘/dock/第二实例唤起:已有窗口就还原、显示并聚焦,一个都没有就新建一个。 */
function showMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    createMainWindow()
  }
}

// 第二个实例被拉起时,唤回已有窗口(可能正隐藏在托盘里)而不是新开一个。
app.on('second-instance', () => {
  showMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tab 布局是防抖 500ms 落盘的(方案 §9)。退出前不 flush,
// 用户最后一次拖出来的顺序就丢了 —— 而那正是他最可能记得的一次操作。
// 顺带停掉所有在跑的 run:它们的定时器/上游流会拖住退出。
app.on('before-quit', () => {
  isQuitting = true
  destroyTray()
  flushPendingPersists()
  shutdownRuns()
  shutdownSessionTitles()
  shutdownTerminals()
  /*
    MCP 的 stdio 传输背后是**真的子进程**。不关的话它们会活过主进程 ——
    表现是退出应用之后活动监视器里还挂着几个 node,而下次启动又会各起一份。
    不 await:`before-quit` 是同步的,而 `shutdown()` 里每一步都自带兜底。
  */
  void shutdownMcp()
  // 顺序要紧:上面那次 flush 是**经 store 写库的**,先关库就等于把它丢了。
  // 关库会顺手做一次 WAL checkpoint,把 -wal 并回主文件。
  closeDatabase()
})
