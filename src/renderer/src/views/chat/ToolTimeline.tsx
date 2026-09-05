/**
 * L2:运行中的分组折叠时间线。
 *
 * ★ 它**只负责一段连续的过程块**，不关心自己上方或下方有没有正文。
 * 每个连续工具组在所有调用拿到成功结果后自动收起；运行中的组仍保持可见。
 * 这条边界让同一个组件能同时服务于「已提交消息」和「还在流的块」两条路径。
 */
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { formatDuration } from "../../../../shared/agent/duration";
import type { SubagentState, ToolCallState } from "../../../../shared/agent/transcript";
import {
  groupDuration,
  groupConsecutiveTools,
  groupKey,
  isCompletedToolGroup,
  shapeOfItem,
  statusOfItem,
  type TimelineItem,
} from "../../../../shared/domain/tool-timeline";
import { cn } from "../../lib/cn";
import { useI18n, type TranslationKey } from "../../i18n";
import { SubagentNode, ThinkingBlock, ToolCallCard } from "./parts";
import { ShapeStrip } from "./ToolIcon";
import { useGroupCollapse } from "./useGroupCollapse";

export function ToolTimeline({
  items,
  tools,
  subagents = {},
  focusCallId,
}: {
  items: readonly TimelineItem[];
  tools: Readonly<Record<string, ToolCallState>>;
  subagents?: Readonly<Record<string, SubagentState>>;
  /** 从文件审查回跳时定位到的那一行;所在组强制展开并滚入视口 */
  focusCallId?: string | undefined;
}): ReactNode {
  if (items.length === 0) return null;

  const groups = groupConsecutiveTools(items);
  const autoCollapsed = groups.map((group) => isCompletedToolGroup(group, tools));

  return (
    <div className="flex flex-col gap-2" data-testid="tool-timeline">
      {groups.map((g, i) => (
        <ToolGroup
          // ★ key 用**首项**的 key,不用下标。理由见 tool-timeline.ts 的 groupKey:
          // 下标会让「用户展开过第 2 组」的意图在重新分组后漂到别的组身上。
          key={groupKey(g)}
          items={g}
          tools={tools}
          subagents={subagents}
          autoCollapsed={autoCollapsed[i] ?? false}
          focusCallId={focusCallId}
        />
      ))}
    </div>
  );
}

function ToolGroup({
  items,
  tools,
  subagents,
  autoCollapsed,
  focusCallId,
}: {
  items: readonly TimelineItem[];
  tools: Readonly<Record<string, ToolCallState>>;
  subagents: Readonly<Record<string, SubagentState>>;
  autoCollapsed: boolean;
  focusCallId: string | undefined;
}): ReactNode {
  const hasError = items.some((it) => statusOfItem(it, tools) === "error");
  const hasFocus =
    focusCallId !== undefined &&
    items.some((it) => it.kind === "tool" && it.callId === focusCallId);

  const { collapsed, toggle } = useGroupCollapse(
    autoCollapsed,
    hasError || hasFocus,
  );
  const ref = useRef<HTMLDivElement>(null);

  /**
   * 回跳定位。用 `nearest` 而不是 `center` —— `center` 会让**已经在视口里**的
   * 目标行也发生滚动,看起来像界面自己抖了一下。
   */
  useEffect(() => {
    if (!hasFocus) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [hasFocus]);

  // 单项组不套折叠外壳:一行内容加一个「1 项」的标题是纯粹的噪音
  if (items.length === 1 && !collapsed) {
    return (
      <div ref={ref}>
        <TimelineRow item={items[0]!} tools={tools} subagents={subagents} />
      </div>
    );
  }

  if (collapsed) {
    return (
      <div ref={ref}>
        <CollapsedGroupBar items={items} tools={tools} onExpand={toggle} />
      </div>
    );
  }

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      <GroupHeader
        items={items}
        tools={tools}
        collapsed={false}
        onToggle={toggle}
      />
      <div className="flex flex-col gap-1.5 pl-2">
        {items.map((it) => (
          <TimelineRow key={it.key} item={it} tools={tools} subagents={subagents} />
        ))}
      </div>
    </div>
  );
}

/** 坍缩态:一行标题,点开即展开。**无动画** —— 理由见设计文档 §2.3。 */
function CollapsedGroupBar({
  items,
  tools,
  onExpand,
}: {
  items: readonly TimelineItem[];
  tools: Readonly<Record<string, ToolCallState>>;
  onExpand: () => void;
}): ReactNode {
  return (
    <GroupHeader items={items} tools={tools} collapsed onToggle={onExpand} />
  );
}

function GroupHeader({
  items,
  tools,
  collapsed,
  onToggle,
}: {
  items: readonly TimelineItem[];
  tools: Readonly<Record<string, ToolCallState>>;
  collapsed: boolean;
  onToggle: () => void;
}): ReactNode {
  const { t } = useI18n();
  const ms = groupDuration(items, tools);
  const shapes = [...new Set(items.map((it) => shapeOfItem(it, tools)))];
  const counts = new Map<typeof shapes[number], number>();
  for (const shape of items.map((item) => shapeOfItem(item, tools))) {
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  const title = shapes.map((shape) => t(groupTitleKey(shape), { count: counts.get(shape) ?? 0 })).join(" · ");
  const errorCount = items.filter(
    (it) => statusOfItem(it, tools) === "error",
  ).length;
  const runningCount = items.filter(
    (it) => statusOfItem(it, tools) === "running",
  ).length;

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-testid="tool-group"
      data-collapsed={collapsed}
      className="flex w-full items-center gap-2 rounded-[7px] px-3 py-1.5 text-left text-[11.5px] text-fg-faint transition-colors hover:bg-tint-hover/40"
    >
      <ChevronRight
        size={12}
        className={cn(
          "shrink-0 transition-transform",
          !collapsed && "rotate-90",
        )}
      />
      <ShapeStrip shapes={shapes} />
      <span className="min-w-0 truncate">{title}</span>
      {runningCount > 0 && (
        <span className="shrink-0 text-accent">
          {t("chat.tool.runningStatus")}
        </span>
      )}
      {ms > 0 && (
        <span className="shrink-0 font-mono">{formatDuration(ms)}</span>
      )}
      {/* 失败标记即使在收起态也必须可见 —— 「这里有个失败被我收起来了」 */}
      {errorCount > 0 && (
        <span className="shrink-0 text-danger">
          {t("chat.failedCount", { count: errorCount })}
        </span>
      )}
    </button>
  );
}

const GROUP_TITLE_KEYS = {
  reasoning: "chat.tool.group.reasoning",
  read: "chat.tool.group.read",
  mutate: "chat.tool.group.mutate",
  search: "chat.tool.group.search",
  command: "chat.tool.group.command",
  network: "chat.tool.group.network",
  orchestration: "chat.tool.group.orchestration",
  external: "chat.tool.group.external",
} as const satisfies Record<ReturnType<typeof shapeOfItem>, TranslationKey>;

function groupTitleKey(shape: ReturnType<typeof shapeOfItem>): TranslationKey {
  return GROUP_TITLE_KEYS[shape];
}

/** 三种块的分派。与改造前 `Thread.tsx` 的 PartBlock 保持同构。 */
function TimelineRow({
  item,
  tools,
  subagents,
}: {
  item: TimelineItem;
  tools: Readonly<Record<string, ToolCallState>>;
  subagents: Readonly<Record<string, SubagentState>>;
}): ReactNode {
  switch (item.kind) {
    case "thinking":
      return <ThinkingBlock text={item.text} streaming={item.streaming} />;
    case "subagent":
      return <SubagentNode summary={item.summary} state={item.state ?? subagents[item.callId]} />;
    case "tool":
      return (
        <ToolCallCard
          call={item.callId === undefined ? undefined : tools[item.callId]}
          name={item.name}
          input={item.input}
        />
      );
  }
}
