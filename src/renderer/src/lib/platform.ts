/**
 * 平台判断 —— **只该用来处理窗口装饰上的平台差异**,别拿它做功能开关。
 *
 * 两件事需要它,而且是相反的两端:
 *
 * 1. **左上角。** macOS 的红绿灯占着窗口左上角,侧边栏表头和外层 Tab 条各为它硬留
 *    了一块位置(`pl-[74px]` / `pl-[78px]`,两个数都量自参考图)。Windows/Linux
 *    那边左上角是空的,这两块留白就成了纯空洞。
 *
 * 2. **右上角。** 反过来,Windows/Linux 在窗口右上角自绘最小化/最大化/关闭三颗按钮
 *    (`shell/WindowControls.tsx`),macOS 没有。所以那三颗按钮的渲染、以及两条顶栏
 *    给它让位的 `pr-window-controls`,同样由这个标志决定。
 *
 * ★ 第 2 条**以前不走这个标志**:那时用的是系统的 Window Controls Overlay,宽度靠
 *   `env(titlebar-area-*)` 问 overlay 自己要。overlay 已经被自绘取代(为什么,见
 *   `main/window/title-bar.ts` 的文件头),那个 CSS 变量也随之删了 —— 按钮既然是
 *   我们自己画的,宽度就是我们自己定的常数,没有什么可量的。
 */
export const IS_MAC = window.nextcowork.platform === 'darwin'
