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
import { Folder, LoaderCircle, PanelBottom, PanelRight, Plus, Server, X } from "lucide-react";
import { isLocalEnvironment } from '../../../shared/domain/environment';
import type { ReactNode } from "react";
import { FEATURE_LABEL, type OuterTab } from "../../../shared/domain/tab";
import type { Workspace } from "../../../shared/domain/workspace";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { cn } from "../lib/cn";
import { FEATURE_ICON } from "./icons";
import { useDragReorder } from "./useDragReorder";
import { useI18n } from "../i18n";

export function OuterTabBar({
  tabs,
  activeId,
  workspaces,
  runningWorkspaceIds,
  onActivate,
  onClose,
  onMove,
  onOpenWorkspace,
  onPickWorkspace,
  onCreateWorkspace,
  onCreateSshWorkspace,
  rightPanelOpen,
  bottomPanelOpen,
  onToggleRightPanel,
  onToggleBottomPanel,
}: {
  tabs: readonly OuterTab[];
  activeId: string | null;
  workspaces: readonly Workspace[];
  /** 有 run 在跑的工作区 —— Tab 上那个小圆点。数据源是 RunRegistry 聚合,不是任何 UI 状态 */
  runningWorkspaceIds: ReadonlySet<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onPickWorkspace: () => void;
  onCreateWorkspace: () => void;
  onCreateSshWorkspace: () => void;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  onToggleRightPanel: () => void;
  onToggleBottomPanel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { dragging, onPointerDown, styleFor } = useDragReorder(onMove);

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
            : FEATURE_LABEL[tab.ref.feature];
        const Icon =
          tab.kind === "workspace" ? (isLocalEnvironment(ws?.environment) ? Folder : Server) : FEATURE_ICON[tab.ref.feature];

        return (
          <div
            key={tab.id}
            style={styleFor(i)}
            onPointerDown={(e) => onPointerDown(e, i)}
            onClick={() => onActivate(tab.id)}
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
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {running && (
              <LoaderCircle size={11} aria-label={t('chat.taskChecklistRunning')} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" />
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

      <Menu
        label={t("nav.openWorkspace")}
        width={300}
        className="mb-0.5 ml-0.5"
        trigger={<Plus size={15} />}
        triggerClassName="flex size-[26px] items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
      >
        {(close) => (
          <>
            {workspaces.map((w) => (
              <MenuItem
                key={w.id}
                icon={isLocalEnvironment(w.environment) ? <Folder size={14} /> : <Server size={14} />}
                description={w.rootPath}
                checked={tabs.some(
                  (t) => t.kind === "workspace" && t.ref.workspaceId === w.id,
                )}
                onSelect={() => {
                  onOpenWorkspace(w.id);
                  close();
                }}
              >
                {w.name}
              </MenuItem>
            ))}
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
    </div>
  );
}
