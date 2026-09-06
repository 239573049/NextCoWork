/**
 * 平台判断 —— **只该用来处理窗口装饰上的平台差异**,别拿它做功能开关。
 *
 * 目前只有一件事需要它:macOS 的红绿灯占着窗口左上角,侧边栏表头和外层 Tab 条
 * 各为它硬留了一块位置(`pl-[74px]` / `pl-[78px]`,两个数都量自参考图)。
 * Windows/Linux 那边按钮在**右上角**(Window Controls Overlay,见
 * `main/window/title-bar.ts`),左边这两块留白就成了纯空洞。
 *
 * ★ 右端给系统按钮让位**不走这个标志**,走 CSS 的 `--window-controls-w` ——
 *   那是 WCO 自己量出来的宽度(`env(titlebar-area-*)`),比「哪个平台大概多宽」
 *   准,而且 macOS 上 env() 落到兜底值后恒为 0,天然短路。
 */
export const IS_MAC = window.nextcowork.platform === 'darwin'
