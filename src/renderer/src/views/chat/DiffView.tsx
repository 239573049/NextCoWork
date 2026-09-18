/**
 * 统一 diff 的渲染 —— 行底色区分增删、改动行逐词高亮。
 *
 * 从 `ToolDetail.tsx` 抽出来:Edit 工具的展开详情与「改动审查」tab 都要画 diff,
 * 一处实现两处用。计算仍走 `diff.ts` 的 `computeDiff`。
 */
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/cn";
import { computeDiff, type DiffRow } from "./diff";

/**
 * 一个 diff 行。
 *
 * ★ **正文一律用常规前景色,增删只靠底色区分。** 一开始把整行文字也染成
 * accent/danger,结果绿字压绿底、红字压红底 —— 代码本身反而读不动了。
 * 词级高亮只会出现在「同一行里只改了一部分」的行上(见 diff.ts 的饱和护栏)。
 */
export function DiffLine({ row }: { row: DiffRow }): ReactNode {
  const mark = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex px-2.5",
        row.type === "add" && "bg-accent/10",
        row.type === "del" && "bg-danger/8",
      )}
    >
      {/* select-none:复制 diff 时不把 +/- 前缀也带上 */}
      <span
        className={cn(
          "mr-2 shrink-0 select-none",
          row.type === "add"
            ? "text-accent"
            : row.type === "del"
              ? "text-danger"
              : "text-fg-faint",
        )}
      >
        {mark}
      </span>
      {/* pre-wrap + flex 列:长行折行而不是横向溢出,折下来的部分自然缩进对齐 */}
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg-muted">
        {row.spans.map((s, i) =>
          s.hi ? (
            <span
              key={i}
              className={cn(
                "rounded-[2px]",
                row.type === "add"
                  ? "bg-accent/25 text-accent"
                  : "bg-danger/20 text-danger",
              )}
            >
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </div>
  );
}

/**
 * 把 old / new 两段文本渲染成一份统一 diff,改动的行逐词高亮。
 *
 * `label` 省略时不画标题(审查 tab 里不需要);`maxRows` 之外的行折叠成一句「省略 N 行」。
 */
export function DiffBlock({
  oldStr,
  newStr,
  label,
  maxRows = 24,
}: {
  oldStr: string;
  newStr: string;
  label?: string;
  maxRows?: number;
}): ReactNode {
  const { t } = useI18n();
  const all = computeDiff(oldStr, newStr);
  const rows = all.slice(0, maxRows);
  const omitted = all.length - rows.length;
  return (
    <div className="mt-1.5 first:mt-0">
      {label !== undefined && (
        <p className="mb-0.5 text-[11px] text-fg-faint">{label}</p>
      )}
      <div className="selectable scroll-thin max-h-72 overflow-auto rounded-[7px] bg-canvas py-1 font-mono text-[11.5px] leading-relaxed">
        {rows.map((row, i) => (
          <DiffLine key={i} row={row} />
        ))}
        {omitted > 0 && (
          <div className="px-2.5 pt-0.5 text-fg-faint">
            {t("chat.tool.linesOmitted", { count: omitted }).trim()}
          </div>
        )}
      </div>
    </div>
  );
}
