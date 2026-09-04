/**
 * 菜单栏托盘 —— macOS 右上角状态区那颗图标。
 *
 * ★ **图标必须是模板图(`setTemplateImage(true)`)。** `resources/trayTemplate.png`
 * 是那枚原子符号,线条本身是近黑(#2a2b30)。非模板模式下它会**在深色菜单栏里
 * 整个隐没**;模板模式只取 alpha 通道,由系统按明/暗菜单栏自动反色,于是浅色菜单栏
 * 上是黑原子、深色菜单栏上是白原子,两种都看得清。文件名带 `Template` 后缀本会让
 * Electron 自动识别,但 `?asset` 打包会把文件名换成哈希名、后缀丢失,所以这里**显式**
 * 调用,不依赖命名约定。
 *
 * ★ **`tray` 必须被模块级变量顶住。** Tray 一旦被 GC,图标就从菜单栏消失 ——
 * 而它没有任何可见的报错,纯粹是「图标自己过一会儿没了」。
 *
 * 交互按 macOS 习惯拆开:左键唤起窗口,右键弹菜单。故意**不**用 `setContextMenu`——
 * 那会让左键也变成弹菜单(mac 的默认),而这里更想要左键=打开窗口。
 * (Linux 部分发行版只认 `setContextMenu`,但本项目的目标平台是 macOS。)
 */
import { readFileSync } from 'node:fs'
import { Menu, Tray, nativeImage } from 'electron'
import trayIconPath from '../../resources/trayTemplate.png?asset'

let tray: Tray | null = null

export function initTray(showMain: () => void): void {
  // 幂等:activate / 二次 whenReady 都不该叠出第二颗图标
  if (tray !== null) return

  // ★ trayTemplate.png 是 44px。必须显式按 @2x 解读(scaleFactor 2)——否则
  // Electron 当成 44pt 塞进 ~22pt 高的菜单栏,图标撑成两倍大。@2x 下 44px = 22pt,
  // 且 retina 上仍是逐像素清晰。`?asset` 会把文件名哈希化、丢掉 `@2x` 后缀,所以
  // 不能靠命名约定自动配对,这里从 buffer 显式指定。
  const image = nativeImage.createFromBuffer(readFileSync(trayIconPath), { scaleFactor: 2 })
  image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip('NextCoWork')

  const menu = Menu.buildFromTemplate([
    { label: '显示 NextCoWork', click: showMain },
    { type: 'separator' },
    { label: '退出 NextCoWork', role: 'quit' }
  ])

  tray.on('click', showMain)
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
}

/** app 退出前销毁,否则图标会残留到进程真正结束那一刻 */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
