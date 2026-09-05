/**
 * 外层 Tab 条右端那两个开关掀开的面板。
 *
 * ★ **两个面板都不是专用面板,它们各是一条内层 Tab 条。**
 *
 * 这是读参考截图读出来的,证据是右侧那颗 `+` 的 tooltip:「**添加右侧工作台标签**」。
 * 「工作台标签」四个字就是这一层的命名 —— 右边不是一个文件栏,是一格能放任何东西的
 * 工作台;`工作区文件` 只是它默认开着的那一个 Tab。底部同理,它的 `+` 菜单里
 * 有文件预览、对话、绘图、文档、终端、网页浏览六项,不止终端。
 *
 * 所以三格共用一张 Tab 表、一份持久化、一套增删改(见 shared/domain/tab.ts 的
 * `InnerTab.pane`),这两个组件**自己不持有任何 Tab 状态** —— 全由 AppShell 喂进来。
 * 将来「把这个 Tab 拖到下面去」也只是改 `pane` 这一个字段。
 *
 * 开关状态是**窗口级**的(见 stores/window.ts):参考实现里切工作区 Tab 时
 * 右侧面板保持打开,只是换了内容。
 *
 * 版式沿用 §8 的「靠底色差分层」:面板用 `bg-surface`(和侧边栏同级),
 * 与 `bg-canvas` 的主内容区之间只有一道 `border-hairline`,没有阴影。
 */
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  InnerTab,
  InnerTabKind,
  InnerTabMenuItem,
  TabPane,
} from "../../../shared/domain/tab";
import { BOTTOM_TAB_MENU, RIGHT_TAB_MENU } from "../../../shared/domain/tab";
import type { Workspace } from "../../../shared/domain/workspace";
import { EmptyState } from "../components/ui/EmptyState";
import { IconButton } from "../components/ui/IconButton";
import { cn } from "../lib/cn";
import { InnerView } from "../views/registry";
import { InnerTabBar } from "./InnerTabBar";
import { useI18n } from "../i18n";

interface PanelProps {
  workspace: Workspace | null;
  tabs: readonly InnerTab[];
  activeId: string | null;
  runningSessionIds: ReadonlySet<string>;
  fallbackModel: string;
  /** 拖出来的尺寸(右侧是宽、底部是高),由 useWindowStore 持有并落盘 */
  size: number;
  /**
   * 展开态。**和「渲不渲染」是两件事** —— 收起时先翻这个、播完 280ms 才卸载
   * (见 lib/usePresence),否则退场动画没有节点可跑。
   */
  open: boolean;
  /**
   * ★ 正在开合。**transition 只在这段时间里挂**,不能常开:
   * 面板尺寸同时被「开关」和「拖分隔条」两件事写,常开的话每一次 pointermove
   * 都排一段 280ms 插值,分隔条就永远追不上鼠标 —— 拖起来像在拉皮筋。
   */
  animating: boolean;
  onResize: (px: number) => void;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onOpen: (kind: InnerTabKind) => void;
  onClosePanel: () => void;
}

export function BottomPanel(props: PanelProps): ReactNode {
  const { t } = useI18n();
  return (
    <section
      style={{ height: props.open ? props.size : 0 }}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-t border-hairline bg-surface",
        props.animating && "transition-[height] duration-280 ease-panel",
      )}
    >
      <Resizer
        axis="y"
        size={props.size}
        onResize={props.onResize}
        label={t("nav.adjustBottomPanel")}
      />
      {/*
        ★ 里面这层**钉死在目标尺寸上**,动的只有外面那个 section。
        不钉的话,内容在这 280ms 里是被压扁的:Tab 条和视图跟着 flex 一路缩,
        终端会连着收到几十次 resize、聊天记录会反复重排。钉住 + overflow-hidden
        以后它是被**裁**出来的 —— 面板长高,内容原样露出来,一次布局都不多做。
      */}
      <div
        style={{ height: props.size }}
        className="flex min-h-0 shrink-0 flex-col"
      >
        <PanelBody
          {...props}
          menu={BOTTOM_TAB_MENU}
          closeLabel={t("nav.closeBottomPanel")}
          empty={t("nav.panelEmptyBottom")}
        />
      </div>
    </section>
  );
}

export function RightPanel(props: PanelProps): ReactNode {
  const { t } = useI18n();
  return (
    <aside
      style={{ width: props.open ? props.size : 0 }}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-l border-hairline bg-surface",
        props.animating && "transition-[width] duration-280 ease-panel",
      )}
    >
      <Resizer
        axis="x"
        size={props.size}
        onResize={props.onResize}
        label={t("nav.adjustRightPanel")}
      />
      {/* 同底部:定宽内层,内容被裁出来而不是被挤扁 —— 见 BottomPanel 里那段 */}
      <div
        style={{ width: props.size }}
        className="flex h-full min-w-0 shrink-0 flex-col"
      >
        <PanelBody
          {...props}
          menu={RIGHT_TAB_MENU}
          closeLabel={t("nav.closeRightPanel")}
          empty={t("nav.panelEmptyRight")}
        />
      </div>
    </aside>
  );
}

/** 两格唯一的差别就是菜单、关闭按钮的名字和空态文案,其余一模一样。 */
function PanelBody({
  workspace,
  tabs,
  activeId,
  runningSessionIds,
  fallbackModel,
  menu,
  closeLabel,
  empty,
  onActivate,
  onCloseTab,
  onMove,
  onOpen,
  onClosePanel,
}: PanelProps & {
  menu: readonly InnerTabMenuItem[];
  closeLabel: string;
  empty: string;
}): ReactNode {
  const { t } = useI18n();
  const active = tabs.find((t) => t.id === activeId);

  return (
    <>
      <InnerTabBar
        tabs={tabs}
        workspaceId={workspace?.id}
        activeId={activeId}
        runningSessionIds={runningSessionIds}
        menu={menu}
        trailing={
          <IconButton label={closeLabel} size={22} onClick={onClosePanel}>
            <X size={13} />
          </IconButton>
        }
        onActivate={onActivate}
        onClose={onCloseTab}
        onMove={onMove}
        onOpen={onOpen}
      />

      {active === undefined || workspace === null ? (
        <EmptyState
          title={workspace === null ? t("workspace.none") : empty}
          className="py-6"
        />
      ) : (
        // key 挂 Tab id:换 Tab 必须重建视图,否则新 Tab 会接着画上一个的状态
        <InnerView
          key={active.id}
          tab={active}
          workspace={workspace}
          fallbackModel={fallbackModel}
        />
      )}
    </>
  );
}

/**
 * 拖动分隔条。
 *
 * 四件事值得写下来:
 *
 * 1. **`setPointerCapture`**。不捕获的话,指针滑到 iframe / xterm 画布 / 窗口外面
 *    就再也收不到 `pointermove`,面板卡在半截宽度上 —— 而底部面板里正好会有终端。
 * 2. **从按下时的尺寸 + 位移算,不从当前指针位置反推**。后者在指针稍微偏离
 *    分隔条中心时会「跳」一下,因为第一帧就把这点偏移当成了拖动量。
 * 3. **命中区比看得见的那条粗**。视觉上是 1px 的 hairline,但 `-inset` 让实际
 *    可抓区域有 5px —— 1px 的目标用户抓不住,这是分隔条的通病。
 * 4. **键盘也能调**。左右/上下方向键各 16px,`Home` 回默认 —— 夹取在 store 里做,
 *    所以这里可以放心地一直加。
 */
function Resizer({
  axis,
  size,
  onResize,
  label,
}: {
  axis: "x" | "y";
  size: number;
  onResize: (px: number) => void;
  label: string;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, size: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: axis === "x" ? e.clientX : e.clientY, size };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const delta = (axis === "x" ? e.clientX : e.clientY) - start.current.pos;
    // 右侧面板在右边、底部面板在下边,往回拖才是变大 —— 所以位移取负
    onResize(start.current.size - delta);
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const grow = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const shrink = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key === grow) onResize(size + 16);
    else if (e.key === shrink) onResize(size - 16);
    else return;
    e.preventDefault();
  };

  useBodyCursor(dragging ? (axis === "x" ? "col-resize" : "row-resize") : null);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      className={cn(
        // 面板自己是 relative,分隔条贴在它靠主区的那条边上
        "app-no-drag absolute z-20 transition-colors",
        "focus-visible:bg-accent focus-visible:outline-none",
        axis === "x"
          ? "inset-y-0 -left-[2px] w-[5px] cursor-col-resize"
          : "inset-x-0 -top-[2px] h-[5px] cursor-row-resize",
        dragging ? "bg-accent" : "hover:bg-accent-soft",
      )}
    />
  );
}

/**
 * 拖动期间把光标钉在整个文档上。
 *
 * 没有这一下,指针一滑出那 5px 的分隔条,光标就变回文字选择的 I 形 ——
 * 明明还在拖,看着却像已经松手了。
 */
function useBodyCursor(cursor: string | null): void {
  useEffect(() => {
    if (cursor === null) return;
    const prev = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    // 顺带禁掉选中:拖过一段文字会把它整段刷蓝
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prev;
      document.body.style.userSelect = prevSelect;
    };
  }, [cursor]);
}

/**
 * 面板开着但那一格是空的时候,补一个默认 Tab。
 *
 * 参考实现里点开右侧面板,里面直接就是「工作区文件」;点开底部,里面直接是一个终端。
 * 没有这一步,两个面板打开后都是一条空 Tab 条加一句空态,还得再点一次 `+`。
 *
 * ★ `openTab` 传的是 **store 里那个 action 本身**,不是整个 store。zustand 的 action
 * 跨 render 是同一个引用,而 store 对象每次写入都换引用 —— 传后者的话,
 * 任何一次 Tab 变更都会重跑这个 effect。
 *
 * ★ `count` 归零时它**不会**又补一个回来,靠的是同一帧里 `open` 也变成了 false:
 * 调用方关掉本格最后一个 Tab 时会连带收起面板,两个 store 的写在同一个事件里,
 * React 批成一次 render。少了那一半,面板就永远关不掉 —— 关一个补一个。
 */
export function useSeedPane({
  open,
  workspaceId,
  pane,
  kind,
  count,
  openTab,
}: {
  open: boolean;
  workspaceId: string | null;
  pane: "bottom" | "right";
  /** 这一格默认开哪种 Tab:底部是终端,右侧是工作区文件 */
  kind: InnerTabKind;
  /** 这一格现有 Tab 数 */
  count: number;
  openTab: (workspaceId: string, kind: InnerTabKind, pane: TabPane) => void;
}): void {
  useEffect(() => {
    if (!open || workspaceId === null || count > 0) return;
    openTab(workspaceId, kind, pane);
  }, [open, workspaceId, pane, kind, count, openTab]);
}
