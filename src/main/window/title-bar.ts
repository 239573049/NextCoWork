/**
 * Windows / Linux 的自绘标题栏。
 *
 * macOS 用 `titleBarStyle: 'hiddenInset'` 把红绿灯嵌进侧边栏(方案 §8),另外两个
 * 平台没有等价物 —— 默认边框会在窗口顶上多压一条系统标题栏,和「悬浮面板 + 34px
 * 自绘 Tab 条」这套版式对不上,而且它用系统配色,主题切浅色/换配色时纹丝不动。
 *
 * 这里改用 **Window Controls Overlay**:`titleBarStyle: 'hidden'` 去掉那条系统
 * 标题栏,`titleBarOverlay` 把最小化/最大化/关闭三颗按钮画回窗口右上角,
 * `color` / `symbolColor` 把它们染成本应用的配色。
 *
 * ★ **刻意不自绘那三颗按钮。** 自绘要补三条 IPC、一套最大化状态同步,还会丢掉
 *   Win11 悬停最大化弹出的 Snap Layouts 分屏菜单和系统的无障碍支持;换回来的只是
 *   圆角能自己定。overlay 的两个颜色已经够用。
 *
 * ★ **overlay 是原生区域,盖在它下面的 DOM 收不到 pointer 事件** —— 和 macOS 那边
 *   `app-drag` 吞事件是同一类坑。渲染层那条 Tab 条必须实打实地让出这块宽度,
 *   见 `styles/theme.css` 里的 `--window-controls-w`(用 WCO 自己的
 *   `env(titlebar-area-*)` 量出来,所以不需要平台判断)。
 *
 * ★ 颜色**由渲染层推**(`window:titleBarOverlay`),不在这里算全:`tokensOf` 的三路
 *   输入里,上传的图片主题只存在于渲染层那张异步拉来的表。这里只算首帧,见下。
 */
import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { tokensOf } from '../../shared/domain/theme'
import { resolveTheme } from '../ipc/app'
import { store } from '../state/store'

/**
 * 标题栏高度。**必须等于渲染层那条 34px** —— AppShell 的外层 Tab 条和 Sidebar 的
 * 表头都是这个数(两处都写着「量自参考图」)。CSS 里 import 不到这个常量,
 * 所以改这里就得三处一起改,否则按钮和 Tab 底边错位。
 */
export const TITLE_BAR_HEIGHT = 34

/** overlay 的两个颜色。`chrome` 是外层 Tab 条的底,`icon` 是它右端那两颗面板开关的笔画。 */
export interface TitleBarColors {
  color: string
  symbolColor: string
}

/**
 * 首帧颜色。第三个参数写死 `null` 是有意的:上传的图片主题只在渲染层的
 * `useImageThemes` 里(异步 `listImages()`),主进程这里拿不到。代价仅仅是
 * 「选了上传图片主题时,首帧按钮底色按颜色主题算,差一点」—— 渲染层第一次
 * `applyTheme` 就会经 `window:titleBarOverlay` 改正。为这一帧把开窗改成异步不值当。
 */
function initialColors(): TitleBarColors {
  const settings = store.getSettings()
  const tokens = tokensOf(resolveTheme(settings.theme), settings.colorTheme, null)
  return { color: tokens.chrome, symbolColor: tokens.icon }
}

/** 开窗选项。macOS 仍走 hiddenInset,其余平台开 overlay。 */
export function titleBarOptions(): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay'
> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...initialColors(), height: TITLE_BAR_HEIGHT }
  }
}

/**
 * 主题落地后渲染层推过来的那一次。
 *
 * macOS 上没有 overlay,`setTitleBarOverlay` 在那边会抛,所以先短路 ——
 * 而不是指望渲染层不发(它发不发是渲染层的自由,这里是边界)。
 */
export function applyTitleBarColors(sender: WebContents, colors: TitleBarColors): void {
  if (process.platform === 'darwin') return
  const win = BrowserWindow.fromWebContents(sender)
  // 窗口正在关的时候渲染层还可能推一条过来(方案 §3 规则 4)
  if (win === null || win.isDestroyed()) return
  win.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
}
