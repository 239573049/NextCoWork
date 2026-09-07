/**
 * Windows / Linux 的最小化 / 最大化 / 关闭 —— **自绘**,不是系统的 Window Controls
 * Overlay(为什么推翻 overlay,见 `main/window/title-bar.ts` 的文件头)。
 *
 * ★ **和 Tab 条右端那两颗面板开关是同一控件族**:同一个 `IconButton`、38×28、
 *   `rounded-pill`。这就是自绘换来的全部好处 —— overlay 只能画在窗口**物理**右上角,
 *   必然压在根布局那 8px 外边距和面板的右上圆角上。
 *
 * ★ **portal 到 body 的常驻悬浮层,不是内联在 Tab 条里。** 理由是模态:
 *   `SettingsOverlay` 和 `Dialog` 都是 `fixed inset-0 z-100` 铺满全窗,而 `Dialog`
 *   portal 到 `body`、`.app-ground` 又有 `isolation: isolate` —— 内联的按钮**无论给
 *   多大 z-index 都压不住它**,设置面板一开就没法最小化/关窗(而 macOS 的红绿灯是
 *   原生层,永远可点,两个平台会不一致)。顺带把「外层 34px 条和浏览器页 52px
 *   header 各插一遍」收敛成单个挂载点。
 *
 * ★ 代价是 y 写死:`top-[11px]` = 根 `p-2` 的 8 + (34 − 28) / 2,在外层 Tab 条里
 *   正好垂直居中;浏览器页那条 52px header 里会比居中高 9px —— 已知并接受,
 *   真实的窗口按钮本来就不跟着内容走。左右两条顶栏各自用 `pr-window-controls`
 *   让出宽度(见 `styles/theme.css` 里那个 spacing token)。
 *
 * ★ 字形按 Windows 惯例手写 SVG,不用 lucide:lucide 的 `Minus` / `Square` / `X` 是
 *   2px 圆头描边,和系统按钮那种 1px 细线方头完全不是一个语言。10×10 的 viewBox
 *   配 0.5 的半像素偏移,1x DPI 下每条线正好落在整数设备像素上。
 *
 * ★ **只在非 macOS 渲染**,短路做在组件内部 —— 挂载点就不用写 `!IS_MAC &&`。
 */
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { IconButton } from "../components/ui/IconButton";
import { useI18n } from "../i18n";
import { IS_MAC } from "../lib/platform";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../services/window";
import { useWindowStore } from "../stores/window";

/** 10×10 细线字形的公共属性。`square` 端点是系统按钮的样子,圆头会看着发虚。 */
const GLYPH = {
  width: 10,
  height: 10,
  viewBox: "0 0 10 10",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  strokeLinecap: "square",
  "aria-hidden": true,
} as const;

export function WindowControls(): ReactNode {
  const { t } = useI18n();
  // hooks 先全部调用完再短路 —— IS_MAC 在整个进程生命周期里恒定,但把 return
  // 提到 hooks 之前依然是违反 hooks 规则的写法。
  const maximized = useWindowStore((s) => s.maximized);
  if (IS_MAC) return null;

  return createPortal(
    <div className="app-no-drag fixed right-2 top-[11px] z-200 flex items-center gap-1">
      <IconButton
        label={t("window.minimize")}
        size={28}
        width={38}
        onClick={minimizeWindow}
        className="rounded-pill"
      >
        <svg {...GLYPH}>
          <path d="M0.5 5.5 H9.5" />
        </svg>
      </IconButton>

      <IconButton
        label={maximized ? t("window.restore") : t("window.maximize")}
        size={28}
        width={38}
        onClick={toggleMaximizeWindow}
        className="rounded-pill"
      >
        <svg {...GLYPH}>
          {maximized ? (
            <>
              {/* 前框 */}
              <path d="M0.5 3.5 H6.5 V9.5 H0.5 Z" />
              {/* 后框:只画露在前框外的那个 L,和系统的还原字形一致 */}
              <path d="M2.5 3.5 V0.5 H9.5 V7.5 H6.5" />
            </>
          ) : (
            <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" />
          )}
        </svg>
      </IconButton>

      {/*
        ★ 关闭键是三颗里唯一破格的:hover 走**实心 danger 底 + 白笔画**,而不是默认
        那档 `tint-hover`。理由不是好看 —— 它是这一片唯一一个「点下去界面就没了」的
        动作,和它左边两颗必须在悬停那一刻就能区分开。`text-white` 是这个文件里唯一
        不走 token 的写死值:`danger` 深浅两套都是中深色(#d9614e / #c4412c),
        白笔画两边都成立。
      */}
      <IconButton
        label={t("common.close")}
        size={28}
        width={38}
        onClick={closeWindow}
        className="rounded-pill hover:bg-danger hover:text-white"
      >
        <svg {...GLYPH}>
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </IconButton>
    </div>,
    document.body,
  );
}
