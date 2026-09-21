/**
 * 统一 diff 的渲染 —— 行底色区分增删、改动行逐词高亮。
 *
 * 从 `ToolDetail.tsx` 抽出来:Edit 工具的展开详情与「改动审查」tab 都要画 diff,
 * 一处实现两处用。计算与审查 hunk 切分都留在 `diff.ts` 的纯函数中。
 */
import { useMemo, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/cn";
import { computeDiff, computeDiffHunks, type DiffRow } from "./diff";

/**
 * 一个 diff 行。
 *
 * ★ **正文一律用常规前景色,增删只靠底色区分。** 一开始把整行文字也染成
 * accent/danger,结果绿字压绿底、红字压红底 —— 代码本身反而读不动了。
 * 词级高亮只会出现在「同一行里只改了一部分」的行上(见 diff.ts 的饱和护栏)。
 */
export function DiffLine({
  row,
  lineNumbers,
  wrap = true,
}: {
  row: DiffRow;
  /** 给出时显示旧、新两侧行号；null 表示这一行只存在于另一侧。 */
  lineNumbers?: { old: number | null; new: number | null };
  /** 工具卡需要折行，整页审查则保留代码列结构并允许横向滚动。 */
  wrap?: boolean;
}): ReactNode {
  const mark = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex",
        lineNumbers === undefined ? "px-2.5" : "min-w-full",
        row.type === "add" && "bg-accent/10",
        row.type === "del" && "bg-danger/8",
      )}
    >
      {lineNumbers !== undefined && (
        <>
          <span aria-hidden className="w-14 shrink-0 select-none border-r border-border px-1.5 text-right tabular-nums text-fg-faint">
            {lineNumbers.old ?? ""}
          </span>
          <span aria-hidden className="w-14 shrink-0 select-none border-r border-border px-1.5 text-right tabular-nums text-fg-faint">
            {lineNumbers.new ?? ""}
          </span>
        </>
      )}
      {/* select-none:复制 diff 时不把 +/- 前缀也带上 */}
      <span
        className={cn(
          "shrink-0 select-none",
          lineNumbers === undefined ? "mr-2" : "w-6 text-center",
          row.type === "add"
            ? "text-accent"
            : row.type === "del"
              ? "text-danger"
              : "text-fg-faint",
        )}
      >
        {mark}
      </span>
      {/* 工具卡折行以守住窄卡宽度；整页审查横向滚动，避免缩进被折行打散。 */}
      <span
        className={cn(
          "flex-1 text-fg-muted",
          wrap ? "min-w-0 whitespace-pre-wrap" : "min-w-max whitespace-pre pr-4",
        )}
      >
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
 * `label` 省略时不画标题；`maxRows` 之外的行折叠成一句「省略 N 行」。
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
  /*
    需求：工具卡片的 diff 现在**在参数还在流的时候就画**（见 ToolDetail 的 MutateDetail），
    也就是每一个流式帧都会走一次这里。LCS 是 O(n·m)，不 memo 的话一次几百行的
    Edit 会把它按帧重算 —— 表现为流式写文件时整个界面发涩，而 CPU profile 里
    只看得到一片 diff 计算，看不出是谁在反复触发。
    入参没变时这层直接跳过；入参在变时无可避免，那一份预览本来就被
    `MAX_PARTIAL_JSON_CHARS` 截在 64KB 以内。
  */
  const all = useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr]);
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

/** 统一 diff 标题里的范围格式；单行省略数量，和常见代码审查工具一致。 */
function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * 改动审查专用的全宽 diff：只呈现 hunk 和邻近上下文，并显示双侧行号。
 *
 * 需求：大文件打开后直接看到改动，同时让代码列占满整个审查面板；可打开的
 * 完整文件由顶部入口承接，不在这里重新铺开成几千行无关上下文。
 */
export function ReviewDiffBlock({ oldStr, newStr }: { oldStr: string; newStr: string }): ReactNode {
  const { t } = useI18n();
  const hunks = useMemo(() => computeDiffHunks(oldStr, newStr), [oldStr, newStr]);
  // 需求：极端整文件重写宁可提示打开文件，也不能在渲染线程分配无界 LCS 矩阵。
  if (hunks === null) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-[12px] text-fg-faint">
        {t("chat.review.diffTooLarge")}
      </div>
    );
  }
  if (hunks.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-[12px] text-fg-faint">
        {t("chat.review.noTextChanges")}
      </div>
    );
  }

  return (
    <div className="selectable min-w-full py-2 font-mono text-[11.5px] leading-relaxed">
      {hunks.map((hunk, hunkIndex) => (
        <section
          key={`${hunk.oldStart}:${hunk.newStart}`}
          className={cn("w-max min-w-full border-y border-border", hunkIndex > 0 && "mt-2")}
        >
          <div className="sticky left-0 border-b border-border bg-surface-sunken px-3 py-1 text-fg-muted">
            @@ -{hunkRange(hunk.oldStart, hunk.oldCount)} +{hunkRange(hunk.newStart, hunk.newCount)} @@
          </div>
          {hunk.rows.map((row, rowIndex) => (
            <DiffLine
              key={rowIndex}
              row={row}
              lineNumbers={{ old: row.oldLine, new: row.newLine }}
              wrap={false}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
