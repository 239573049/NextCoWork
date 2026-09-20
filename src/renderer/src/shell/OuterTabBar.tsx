/**
 * 外层 Tab 条 —— 工作区 Tab 与功能 Tab 混排(方案 §8)。
 *
 * 形状照截图 09e55765 / docs/image-new:**浏览器式标签** —— 激活的那个是 `bg-canvas`,
 * 和它下面的内容面板同色、上圆角、无下边框,读起来是「这张标签就是下面那一页的舌头」。
 * 未激活的**没有底色**,直接落在 `bg-chrome` 的条上,只有文字变灰。
 * (量自 docs/image-new/image.png:激活 Tab x752..870 是 #faf9f5 = canvas,
 *  未激活那几张所在处一律是 #e8e4dd = chrome,没有任何中间色块。)
 *
 * ⚠️ 整条落在 `.app-drag` 里(两个平台的自绘标题栏)。**每个可点元素都必须
 * `.app-no-drag`**,否则 OS 吞掉 pointer 事件,表现是「Tab 拖不动,整个窗口跟着鼠标跑」。
 * 留给窗口拖动的只有 Tab **之间和右侧**的空白。
 */
import { Check, ChevronDown, Folder, PanelBottom, PanelRight, Pencil, Pin, PinOff, Plus, Server, X } from "lucide-react";
import { isLocalEnvironment } from '../../../shared/domain/environment';
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FeatureKind, OuterTab } from "../../../shared/domain/tab";
import type { Workspace } from "../../../shared/domain/workspace";
import { ContextMenu, type ContextMenuPosition } from "../components/ui/ContextMenu";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { cn } from "../lib/cn";
import { FEATURE_ICON } from "./icons";
import { useDragReorder } from "./useDragReorder";
import { TabRenameInput } from "./TabRenameInput";
import { useI18n, type Translate } from "../i18n";
import { Spinner } from '../components/ui/Spinner'

function featureLabel(t: Translate, feature: FeatureKind): string {
  return t(`view.feature.${feature}` as Parameters<Translate>[0]);
}

export function OuterTabBar({
  tabs,
  activeId,
  workspaces,
  runningWorkspaceIds,
  onActivate,
  onClose,
  onTogglePin,
  onMove,
  onRenameWorkspace,
  onOpenWorkspace,
  onEditWorkspace,
  onPickWorkspace,
  onCreateWorkspace,
  onCreateSshWorkspace,
  rightPanelOpen,
  bottomPanelOpen,
  onToggleRightPanel,
  onToggleBottomPanel,
  updateIndicator,
}: {
  tabs: readonly OuterTab[];
  activeId: string | null;
  workspaces: readonly Workspace[];
  /** 有 run 在跑的工作区 —— Tab 上那个小圆点。数据源是 RunRegistry 聚合,不是任何 UI 状态 */
  runningWorkspaceIds: ReadonlySet<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onMove: (from: number, to: number) => void;
  /**
   * 双击 / 右键「重命名工作区」的提交口。
   *
   * ★ **可选**:`settings/theme-studio/DesktopPreview.tsx` 也渲染这个组件当静态
   * 示意图,那里一个真工作区都没有。不给就没有改名入口。
   *
   * ★★ 只对 `kind === 'workspace'` 的 Tab 开放 —— 功能 Tab(设置/扩展…)的标题
   * 来自翻译 key,改了在另一种语言下就对不上,永远不可改名。
   */
  onRenameWorkspace?: (workspaceId: string, name: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  /** 「+」菜单里每个工作区行悬停出现的铅笔 —— 打开 `EditWorkspaceDialog`（名称/默认模型/删除）。 */
  onEditWorkspace: (workspaceId: string) => void;
  onPickWorkspace: () => void;
  onCreateWorkspace: () => void;
  onCreateSshWorkspace: () => void;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  onToggleRightPanel: () => void;
  onToggleBottomPanel: () => void;
  /**
   * 插在右端那组开关左边的东西 —— 目前只有更新指示器。
   *
   * 走 slot 而不是让这里自己 `<UpdateIndicator />`,是因为主题工作室的
   * `DesktopPreview` 也渲染这条 Tab 条:它是一张**静态示意图**,不该因为恰好
   * 有个新版本就在预览里多冒出一颗图标。这条 Tab 条其余部分全是 props 驱动的,
   * 让它自己去订阅 IPC 会是这里唯一一处有外部状态的地方。
   */
  updateIndicator?: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const { dragging, onPointerDown, styleFor } = useDragReorder(onMove);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; position: ContextMenuPosition } | null>(null);
  const [hiddenTabIds, setHiddenTabIds] = useState<readonly string[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const contextTab = contextMenu === null ? undefined : tabs.find((tab) => tab.id === contextMenu.tabId);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;

    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = strip.getBoundingClientRect();
        const left = bounds.left;
        const right = bounds.left + strip.clientWidth;
        const hidden = [...strip.querySelectorAll<HTMLElement>('[data-outer-tab-id]')]
          .filter((tab) => {
            const box = tab.getBoundingClientRect();
            return box.left < left - 1 || box.right > right + 1;
          })
          .map((tab) => tab.dataset.outerTabId ?? '')
          .filter((id) => id !== '');
        setHiddenTabIds((current) => current.length === hidden.length && current.every((id, index) => id === hidden[index]) ? current : hidden);
      });
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(strip);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(strip, { childList: true, subtree: true, characterData: true });
    strip.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      strip.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [tabs, workspaces]);

  /* 编辑态提升到条这一层:同一时刻只有一个 Tab 在改名(同 InnerTabBar) */
  const [editingId, setEditingId] = useState<string | null>(null);
  const canRename = (tab: OuterTab): boolean => onRenameWorkspace !== undefined && tab.kind === "workspace";

  return (
    /*
      ★ `self-stretch` 是**几何要件**,不是随手加的。没有它,这个根 div 的交叉轴尺寸
      = 内容高 = 30px(最高的是 Tab),而不是外面那条 34px。于是右端那两颗面板开关的
      `self-center` 就居中在 30px 里,落到窗口 y13..40、盒心 y27 ——
      比左上角那颗「展开侧边栏」和 Windows 那三颗窗口按钮(都是盒心 y25)**低 2px**。
      量参考图 docs/image-new/image copy.png 也是 y25:
        x=997 竖扫 → 药丸底 #dbd8d1 起于 y11 止于 y38,(11+39)/2 = 25
        x=104  竖扫(image.png 收起态的展开键)→ 同样 y11..38
      拉伸到 34px 后 `items-end` 照旧把 Tab / `+` / 拖动空白压在底边(rel y4..34,
      和以前逐像素相同),只有 `self-center` 的那一组挪回真正的条心。
    */
    <div className="flex min-w-0 flex-1 self-stretch items-end gap-0.5">
      {/*
        Keep the + trigger outside the scrollable tab list. Previously it shared the
        same non-wrapping flex row as every tab, so a full strip let the last tab's
        close button overlap the trigger. The list can now scroll while + always has
        its own fixed hit target.
      */}
      <div ref={stripRef} className="app-no-drag tab-strip-scroll flex w-max min-w-0 max-w-full flex-initial items-end gap-0.5 overflow-x-auto overflow-y-hidden">
        {tabs.map((tab, i) => {
        const active = tab.id === activeId;
        const running =
          tab.kind === "workspace" &&
          runningWorkspaceIds.has(tab.ref.workspaceId);
        const ws =
          tab.kind === "workspace"
            ? workspaces.find((w) => w.id === tab.ref.workspaceId)
            : undefined;
        const label =
          tab.kind === "workspace"
            ? (ws?.name ?? t("nav.unknownWorkspace"))
            : featureLabel(t, tab.ref.feature);
        const Icon =
          tab.kind === "workspace" ? (isLocalEnvironment(ws?.environment) ? Folder : Server) : FEATURE_ICON[tab.ref.feature];

          return (
          <div
            key={tab.id}
            data-outer-tab-id={tab.id}
            style={styleFor(i)}
            onPointerDown={(e) => {
              // 编辑中不接拖排序 —— 否则在输入框里拖选文字会把整张 Tab 拖走
              if (tab.id === editingId) return;
              onPointerDown(e, i);
            }}
            onClick={(e) => {
              if (tab.id === editingId) return;
              onActivate(tab.id);
              // `e.detail >= 2` 判双击,理由同 InnerTabBar(不用计时器消歧)
              if (e.detail >= 2 && canRename(tab)) setEditingId(tab.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ tabId: tab.id, position: { x: event.clientX, y: event.clientY } });
            }}
            role="tab"
            aria-selected={active}
            title={ws?.rootPath ?? label}
            className={cn(
              "app-no-drag group relative flex h-[30px] max-w-[200px] min-w-0 shrink-0 items-center",
              "gap-1.5 rounded-t-[10px] pr-1.5 pl-3 text-[13px] select-none",
              !dragging && "transition-[transform,background-color]",
              active
                ? "bg-canvas text-fg"
                : "text-fg-muted hover:bg-tint-hover/60 hover:text-fg",
            )}
          >
            {/*
              ★ Tab 上这个图标**不用强调色**。量 docs/image-new/image.png:
              未激活那张的文件夹是 #7d7b77(≈ `icon`),激活那张是 #3b3d3b —— 两个都
              **无彩度**(max−min ≤ 2),而强调色 #2d4739 的彩度是 26。
              也就是说激活态不靠「图标变彩」表达,靠的是整张 Tab 挖到画布色 + 文字变实。
            */}
            <Icon
              size={13}
              className={cn("shrink-0", active ? "text-fg" : "text-icon")}
            />
            {tab.pinned === true && <Pin size={11} aria-hidden className="shrink-0 text-accent" />}
            {tab.id === editingId ? (
              <TabRenameInput
                initial={label}
                ariaLabel={t("nav.renameWorkspace")}
                onSubmit={(value) => {
                  setEditingId(null);
                  if (tab.kind === "workspace") onRenameWorkspace?.(tab.ref.workspaceId, value);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{label}</span>
            )}
            {running && (
              <Spinner size="xs" label={t('chat.taskChecklistRunning')} className="text-accent" />
            )}
            <button
              type="button"
              aria-label={t("nav.closeTab", { label })}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={cn(
                "app-no-drag flex size-[18px] shrink-0 items-center justify-center rounded-[5px]",
                "text-fg-faint opacity-0 transition-opacity group-hover:opacity-100",
                "hover:bg-tint-strong hover:text-fg focus-visible:opacity-100",
              )}
            >
              <X size={12} />
            </button>
          </div>
          );
        })}
      </div>

      {hiddenTabIds.length > 0 && (
        <Menu
          label={t("nav.allTabs")}
          width={260}
          className="mb-0.5 shrink-0"
          trigger={<ChevronDown size={15} />}
          triggerClassName="flex size-[26px] items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
        >
          {(close) => (
            <>
              {hiddenTabIds.map((id) => {
                const tab = tabs.find((candidate) => candidate.id === id);
                if (tab === undefined) return null;
                const ws = tab.kind === "workspace" ? workspaces.find((workspace) => workspace.id === tab.ref.workspaceId) : undefined;
                const label = tab.kind === "workspace" ? (ws?.name ?? t("nav.unknownWorkspace")) : featureLabel(t, tab.ref.feature);
                const Icon = tab.kind === "workspace"
                  ? (isLocalEnvironment(ws?.environment) ? Folder : Server)
                  : FEATURE_ICON[tab.ref.feature];
                return (
                  <MenuItem
                    key={tab.id}
                    icon={<Icon size={14} />}
                    checked={tab.id === activeId}
                    onSelect={() => {
                      onActivate(tab.id);
                      close();
                    }}
                  >
                    {label}
                  </MenuItem>
                );
              })}
            </>
          )}
        </Menu>
      )}

      <Menu
        label={t("nav.openWorkspace")}
        width={300}
        className="mb-0.5 ml-0.5 shrink-0"
        trigger={<Plus size={15} />}
        triggerClassName="flex size-[26px] items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
      >
        {(close) => (
          <>
            {workspaces.map((w) => {
              const opened = tabs.some((t) => t.kind === "workspace" && t.ref.workspaceId === w.id);
              return (
                /*
                  需求：每一行要同时容纳「点了就打开」和「悬停出现的编辑按钮」两个
                  独立的可点区域 —— MenuItem 本身整行就是一个 <button>，装不下第二个
                  嵌套按钮（无效 HTML，且两个 onClick 会互相抢事件）。所以这里改用
                  普通 <div> 当布局容器，两个动作各自是 role="menuitem" 的 <button>，
                  和 OuterTabBar 自己的外层 Tab 行（激活区 + 独立关闭键）同一个模式。
                */
                <div
                  key={w.id}
                  className="group/wsrow flex items-center gap-1 rounded-[7px] transition-colors hover:bg-tint-strong"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onOpenWorkspace(w.id);
                      close();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13px] text-fg"
                  >
                    <span className="shrink-0 text-accent-soft">
                      {isLocalEnvironment(w.environment) ? <Folder size={14} /> : <Server size={14} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{w.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-fg-faint">{w.rootPath}</span>
                    </span>
                    <Check size={14} className={cn("shrink-0 text-accent", !opened && "invisible")} />
                  </button>
                  <IconButton
                    label={t("workspace.edit")}
                    size={26}
                    className={cn(
                      "mr-1 shrink-0 opacity-0 transition-opacity",
                      "group-hover/wsrow:opacity-100 focus-visible:opacity-100",
                    )}
                    onClick={() => {
                      onEditWorkspace(w.id);
                      close();
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                </div>
              );
            })}
            <MenuSeparator />
            <MenuItem
              icon={<Folder size={14} />}
              onSelect={() => {
                onPickWorkspace();
                close();
              }}
            >
              {t("nav.openFolder")}
            </MenuItem>
            <MenuItem
              icon={<Plus size={14} />}
              onSelect={() => {
                onCreateWorkspace();
                close();
              }}
            >
              {t("nav.createWorkspace")}
            </MenuItem>
            <MenuItem icon={<Server size={14} />} onSelect={() => { onCreateSshWorkspace(); close(); }}>{t('nav.createSshWorkspace')}</MenuItem>
          </>
        )}
      </Menu>

      {/* ★ 这块弹性空白是**故意**留给窗口拖动的 —— 整条 Tab 区唯一没有 no-drag 的地方 */}
      <div className="h-[30px] min-w-6 flex-1" />

      {/*
        右端这两个面板开关和左上角那颗「展开侧边栏」是**同一种控件**,几何量下来一模一样:
        image copy.png 里激活的 `PanelRight` 盒子 x979..1016(宽 38)、x=997 竖扫 y11..38(高 28)、
        x=985 处只剩 y14..35 —— 又是 r=14 的药丸。所以三处共用 38×28 + `rounded-pill`。

        「工作区文件」打开的那张截图是本项目 icon/accent 双 token 最干净的一处证据:
        同一张图里 `PanelRight` 是 底 #dbd8d1 + 图标 #2d4739,
        而 `PanelBottom` 还是 底 #e8e4dd + 图标 #7e7f7e。

        ★ `strokeWidth={1.5}` 也是量出来的,别删回 lucide 的默认 2。笔画粗细是
        **viewBox 单位**,size=16 时实际渲染 = 2 × 16/24 = 1.33px —— 落不到整数设备
        像素上,1x DPI 下被抹成两列灰,看着比旁边的东西「脏一档」。1.5 × 16/24 = 1.0px,
        正好一列。参考图里这几颗也确实是**单像素**笔画:
          image copy.png y=25 横扫 → PanelBottom 左右边框各只有 x=949 / x=962 一个
          #7e7f7e 像素,下一列就回到底色;image.png x=98 / x=111 同理(#2d4739)。
        在 Windows 上这条尤其要紧:右边紧挨着的三颗窗口按钮是手写 SVG、`strokeWidth: 1`
        配 10×10 viewBox = 实打实 1px 方头(见 WindowControls.tsx 文件头),
        默认 2 的 lucide 摆在它旁边就是两种笔法拼在一行。

        它们**是窗口级的**(见 stores/window.ts 的注释),所以不接受 Tab 参数。
      */}
      <div className="flex shrink-0 items-center gap-1 self-center">
        {updateIndicator}
        <IconButton
          label={t("nav.bottomPanel")}
          size={28}
          width={38}
          active={bottomPanelOpen}
          onClick={onToggleBottomPanel}
          className="rounded-pill"
        >
          <PanelBottom size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label={t("nav.workspaceFiles")}
          size={28}
          width={38}
          active={rightPanelOpen}
          onClick={onToggleRightPanel}
          className="rounded-pill"
        >
          <PanelRight size={16} strokeWidth={1.5} />
        </IconButton>
      </div>

      {contextMenu !== null && contextTab !== undefined && (
        <ContextMenu
          position={contextMenu.position}
          label={t("nav.tabContextMenu")}
          onClose={() => setContextMenu(null)}
        >
          {(close) => (
            <>
            {canRename(contextTab) && (
              <MenuItem
                icon={<Pencil size={14} />}
                onSelect={() => {
                  setEditingId(contextTab.id);
                  close();
                }}
              >
                {t("nav.renameWorkspace")}
              </MenuItem>
            )}
            <MenuItem
              icon={contextTab.pinned === true ? <PinOff size={14} /> : <Pin size={14} />}
              checked={contextTab.pinned === true}
              onSelect={() => {
                onTogglePin(contextTab.id);
                close();
              }}
            >
              {contextTab.pinned === true ? t("nav.unpinTab") : t("nav.pinTab")}
            </MenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
