/**
 * KernelHost 之外唯一允许 import electron 的地方之一(窗口/生命周期)。
 * 内核代码永远不从这里 import —— 依赖方向是单向的:main → kernel,不反向。
 */
import { join } from 'node:path'
import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import appIconPath from '../../resources/icon.png?asset'
import { closeDatabase, openDatabase } from './db'
import { probeSqlite, type SqliteProbeResult } from './db/probe'
import { electronHost } from './host'
import { flushPendingPersists, registerIpc, shutdownRuns } from './ipc'
import { applyProxy, installProxyAuth } from './net/proxy'
import { initRuntime, shutdownMcp } from './runtime'
import { store } from './state/store'
import { initTray, destroyTray } from './tray'
import { windows } from './window/registry'

// ─────────────────────────────────────────────────────────────────────────────
// 单实例锁 —— 必须在 whenReady 之前。方案 §9:两个实例开同一个 SQLite 文件,
// 即使有 WAL 也会打架。第一天就加,后补要动启动时序。
// ─────────────────────────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// dev 用独立的 userData 路径,别让开发跑污染真实数据(方案 §9)。
// 必须在 app ready 之前调用才生效。
if (is.dev) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

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

function createMainWindow(): BrowserWindow {
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
    // macOS:红绿灯嵌进侧边栏(方案 §8)
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // ★ 三件套。sandbox: true 是本项目 preload 必须完整打包成单文件的原因
      // (沙箱下无法 require 多文件),见 electron.vite.config.ts。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 任何 window.open / target=_blank 一律不在应用内开新窗口,交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
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
    ★ **必须排在 `initRuntime()` 前面**:seed 会往 providers 表写演示上游,
    而在库打开之前碰 store 的话,那些行会落进一个内存兜底库里,
    换成文件库时凭空消失 —— 症状正好是「配置重启后没了」,也就是持久化
    根本没做时的原症状,没人会怀疑到调用顺序上来。`openDatabase()` 因此
    在重复调用时直接抛错,把这个顺序钉死。

    dev 的独立路径已经在模块顶层由 `app.setPath('userData', …-dev)` 处理过了,
    这里拿到的就是该用的那个目录。
  */
  openDatabase(app.getPath('userData'))

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
  registerIpc()

  createMainWindow()

  // 菜单栏托盘。放在建窗之后:它的「显示窗口」要能拿到已经存在的那个窗口。
  initTray(showMainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

/** 从托盘唤起:已有窗口就还原并聚焦,一个都没有(mac 关窗不退出)就新建一个。 */
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

// 第二个实例被拉起时,聚焦已有窗口而不是新开一个。
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tab 布局是防抖 500ms 落盘的(方案 §9)。退出前不 flush,
// 用户最后一次拖出来的顺序就丢了 —— 而那正是他最可能记得的一次操作。
// 顺带停掉所有在跑的 run:它们的定时器/上游流会拖住退出。
app.on('before-quit', () => {
  destroyTray()
  flushPendingPersists()
  shutdownRuns()
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
