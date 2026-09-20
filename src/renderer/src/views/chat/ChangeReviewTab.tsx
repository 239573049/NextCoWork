/**
 * 「改动审查」tab —— 某一轮(顶层 run)改了哪些文件 + 每个文件的 diff。
 *
 * 左列文件清单(路径 + `+X −Y`),点一个在右侧看统一 diff。数据全部来自
 * `review:*` IPC(见 `services/review.ts`);diff 渲染复用 `DiffView` 的 `DiffBlock`。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { InnerTab } from "../../../../shared/domain/tab";
import type { Workspace } from "../../../../shared/domain/workspace";
import type { ReviewChangeSet, ReviewFileDiff, ReviewFileEntry } from "../../../../shared/domain/review";
import { getReviewChangeSet, getReviewFileDiff } from "../../services/review";
import { useTabsStore } from "../../stores/tabs";
import { useI18n, type Translate } from "../../i18n";
import { cn } from "../../lib/cn";
import { DiffBlock } from "./DiffView";

type ChangesTab = Extract<InnerTab, { kind: "changes" }>;

/** 拆出目录与文件名,好把文件名加粗、目录压灰(和截图一致)。 */
function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

function FileRow({
  file,
  active,
  onOpen,
  onSelect,
  t,
}: {
  file: ReviewFileEntry;
  active: boolean;
  onOpen: () => void;
  onSelect: () => void;
  t: Translate;
}): ReactNode {
  const { dir, name } = splitPath(file.path);
  const tag =
    file.changeKind === "created"
      ? t("chat.review.created")
      : file.changeKind === "deleted"
        ? t("chat.review.deleted")
        : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-left text-[12px]",
        active ? "bg-accent/10" : "hover:bg-canvas",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">{name}</span>
        {dir !== "" && <span className="ml-1 text-fg-faint">{dir}</span>}
        {tag !== null && <span className="ml-1 text-fg-faint">· {tag}</span>}
      </span>
      {file.oversize ? (
        <span className="shrink-0 text-fg-faint">{t("chat.review.oversize")}</span>
      ) : (
        <span className="shrink-0 font-mono text-[11px]">
          {file.additions > 0 && <span className="text-accent">+{file.additions}</span>}
          {file.deletions > 0 && <span className="ml-1 text-danger">-{file.deletions}</span>}
        </span>
      )}
    </button>
  );
}

export function ChangeReviewTab({ tab, workspace }: { tab: ChangesTab; workspace: Workspace }): ReactNode {
  const { t } = useI18n();
  const runId = tab.ref.runId;
  // 从回合卡里点某一行过来时带着它 —— 只作用于「首次定位」,之后选中态归左列自己管。
  const wanted = tab.ref.selectedPath;
  // undefined = 加载中;null = 无改动/加载失败
  const [set, setSet] = useState<ReviewChangeSet | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ReviewFileDiff | null>(null);

  useEffect(() => {
    let alive = true;
    getReviewChangeSet(runId)
      .then((s) => {
        if (!alive) return;
        setSet(s);
        if (s === null || s.files.length === 0) return;
        // 点的那个文件可能已经不在改动集里(撤销后重开),这时退回第一个而不是空着。
        const hit = wanted === undefined ? undefined : s.files.find((f) => f.path === wanted);
        setSelected(hit?.path ?? s.files[0]!.path);
      })
      .catch(() => {
        if (alive) setSet(null);
      });
    return () => {
      alive = false;
    };
  }, [runId, wanted]);

  useEffect(() => {
    if (selected === null) {
      setDiff(null);
      return;
    }
    let alive = true;
    getReviewFileDiff(runId, selected)
      .then((d) => {
        if (alive) setDiff(d);
      })
      .catch(() => {
        if (alive) setDiff(null);
      });
    return () => {
      alive = false;
    };
  }, [runId, selected]);

  if (set === undefined) return <div className="flex min-h-0 flex-1 bg-canvas" />;
  if (set === null || set.files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas text-[12px] text-fg-faint">
        {t("chat.review.empty")}
      </div>
    );
  }

  const openFile = (path: string): void => useTabsStore.getState().openFile(workspace.id, path);

  return (
    <div className="flex min-h-0 flex-1 bg-canvas">
      <div className="scroll-thin w-64 shrink-0 overflow-auto border-r border-border py-1">
        {set.files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            active={f.path === selected}
            onSelect={() => setSelected(f.path)}
            onOpen={() => openFile(f.path)}
            t={t}
          />
        ))}
      </div>
      <div className="scroll-thin min-w-0 flex-1 overflow-auto p-3">
        {diff === null ? (
          <div className="text-[12px] text-fg-faint">{t("chat.review.selectFile")}</div>
        ) : diff.oversize ? (
          <div className="text-[12px] text-fg-faint">{t("chat.review.oversize")}</div>
        ) : (
          <DiffBlock oldStr={diff.before} newStr={diff.after} maxRows={100_000} />
        )}
      </div>
    </div>
  );
}
