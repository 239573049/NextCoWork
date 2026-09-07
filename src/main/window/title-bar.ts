/**
 * Windows / Linux 的窗口装饰。
 *
 * macOS 用 `titleBarStyle: 'hiddenInset'` 把红绿灯嵌进侧边栏(方案 §8),另外两个
 * 平台没有等价物 —— 默认边框会在窗口顶上多压一条系统标题栏,和「悬浮面板 + 34px
 * 自绘 Tab 条」这套版式对不上,而且它用系统配色,主题切浅色/换配色时纹丝不动。
 *
 * 这里用 `titleBarStyle: 'hidden'` 去掉那条系统标题栏,**三颗按钮由渲染层自绘**
 * (`renderer/src/shell/WindowControls.tsx`)。
 *
 * ★ **为什么推翻了 Window Controls Overlay(这个文件曾经用它)。** overlay 的位置
 *   写死在窗口**物理**右上角,API 只给 `color` / `symbolColor` / `height`,没有任何
 *   x/y 偏移。而本应用的根布局是 8px 外边距 + 圆角悬浮面板(`AppShell` 的 `p-2`),
 *   那三颗按钮必然压在那圈外边距和面板的右上圆角上,怎么调色都是割裂的。自绘换来
 *   「按钮和面板开关同一控件族、同一圆角、同一 8px 栅格」。
 *
 * ★ **代价只有一条:Win11 悬停最大化键弹出的 Snap Layouts 分屏菜单。** 那个菜单靠
 *   命中测试返回 `HTMAXBUTTON`,而 Chromium 的 `-webkit-app-region` 只会返回
 *   `HTCAPTION`,Electron 没有暴露前者。用户仍可用 Win+Z 呼出同一个菜单。
 *   窗口边缘 resize、Aero Snap(拖到屏幕边 / Win+方向键)、双击拖动区最大化、
 *   右键系统菜单**全部保留** —— `titleBarStyle: 'hidden'` 保留原生窗框
 *   (`thickFrame` 默认 true),只是不画标题栏,这一点和用 overlay 时完全一样。
 *
 * ★ **颜色不再有任何 IPC。** 按钮就是普通 DOM,`theme.css` 那 22 个变量直接够到它,
 *   原先那条 `window:titleBarOverlay`(以及它为图片主题绕的那一大圈)一并删掉了。
 */
import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import type { IpcSendMap } from '../../shared/ipc/contract'
import { windows } from './registry'

/** 开窗选项。macOS 走 hiddenInset,其余平台只去掉那条系统标题栏。 */
export function titleBarOptions(): Pick<BrowserWindowConstructorOptions, 'titleBarStyle'> {
  return { titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden' }
}

/**
 * 自绘按钮的三个动作。
 *
 * ★ `close` **就是 `win.close()`**,不是 `hide()` 也不是 `destroy()` —— 托盘语义
 *   (关闭只隐藏、留住页面状态)整个写在 `main/index.ts` 的 `win.on('close')` 里。
 *   在这里绕过去就等于绕过 `isQuitting` 那套判断,退出流程会分叉出第二条路径。
 */
export function applyWindowControl(
  sender: WebContents,
  action: IpcSendMap['window:control']['action']
): void {
  const win = BrowserWindow.fromWebContents(sender)
  // 窗口正在关的时候渲染层还可能推一条过来(方案 §3 规则 4)
  if (win === null || win.isDestroyed()) return
  if (action === 'minimize') win.minimize()
  else if (action === 'close') win.close()
  else if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

/**
 * 把当前最大化状态推给**这一个**窗口。
 *
 * 权威值是 `win.isMaximized()`,不是渲染层自己记的那一份:用户还能拖窗口边缘、
 * 双击拖动区、按 Win+↑ 改变它 —— 渲染层只按自己发出去的 `toggleMaximize` 记账,
 * 迟早对不上。
 */
export function pushMaximized(sender: WebContents): void {
  const win = BrowserWindow.fromWebContents(sender)
  if (win === null || win.isDestroyed()) return
  windows.emitTo(sender, 'window:maximized', { maximized: win.isMaximized() })
}

/**
 * 开窗时挂一次。`restore` 也订上:从最小化回来时补一条,代价为零 ——
 * 而少了它,「最大化 → 最小化 → 从托盘唤回」这条路上按钮字形会停在旧值。
 */
export function watchMaximized(win: BrowserWindow): void {
  const push = (): void => pushMaximized(win.webContents)
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('restore', push)
}
