/**
 * 窗口控制服务 —— 组件不碰频道字符串(方案 §8 的服务层约定)。
 *
 * 只有 Windows/Linux 的自绘按钮会调这三个(`shell/WindowControls.tsx`);macOS 那边
 * 是 hiddenInset 红绿灯,按钮根本不渲染。平台短路做在那个组件里,**不在这一层**:
 * 服务层的职责是「把一个动作变成一条 IPC」,不是决定要不要画按钮。
 */
import { send } from './ipc'

export function minimizeWindow(): void {
  send('window:control', { action: 'minimize' })
}

/**
 * 最大化 ⇄ 还原。这里只发「切一下」,不发目标状态 —— 真实状态由主进程的
 * `win.isMaximized()` 判,新值经 `window:maximized` 推回来。
 */
export function toggleMaximizeWindow(): void {
  send('window:control', { action: 'toggleMaximize' })
}

/**
 * ★ 这是 `win.close()`,而这个托盘应用把它拦成了隐藏(`main/index.ts` 的
 * `win.on('close')`)—— 和过去那颗系统关闭键的行为完全一致。
 */
export function closeWindow(): void {
  send('window:control', { action: 'close' })
}
