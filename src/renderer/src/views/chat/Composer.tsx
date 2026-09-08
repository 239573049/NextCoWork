/**
 * 输入框 —— 连同它下面那排药丸。
 *
 * ★ **药丸不是设置项的快捷方式,它就是发送时读取的那个值**(方案 §4.5)。
 * 界面把权限档位放在输入框左下角而不是设置页里,说明档位是**每次发送时**
 * 读的当前值,run 一旦开始就冻结在 `RunRequest` 里不再变 —— 这正是设置页
 * 那句「更改会在下一次新回复生效」。
 *
 * 所以本地 state 是权威,发送时打快照;顺带写回工作区当新默认值。
 * 反过来(以工作区为权威、每次改都等一轮 IPC 回来)会让药丸点下去有延迟。
 *
 * ★ **生成中不禁用输入框**,占位符改成「当前回复完成后按队列继续执行」。
 * 队列语义在 session store 里(`queuedInputs`),这里只是不拦着用户打字。
 */
import {
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe,
  Lightbulb,
  Paperclip,
  Plus,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Target,
  Unlock,
  Wrench,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { PermissionMode } from "../../../../shared/agent/permission";
import {
  PERMISSION_MODES,
} from "../../../../shared/agent/permission";
import type {
  SessionMode,
  ThinkingLevel,
} from "../../../../shared/agent/run-request";
import {
} from "../../../../shared/agent/run-request";
import { modelThinkingLevels, normalizeModelThinkingLevel } from "../../../../shared/domain/model-runtime";
import type {
  Workspace,
  WorkspaceSettings,
} from "../../../../shared/domain/workspace";
import type {
  ModelAlias,
  UpstreamProvider,
} from "../../../../shared/domain/provider";
import { ProviderIcon } from "../../components/brand/ProviderIcon";
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useI18n } from "../../i18n";
import { updateWorkspace } from "../../services/app";
import { useModelsStore } from "../../stores/models";
import { AttachmentTray, type TrayItem } from "./AttachmentTray";
import { MentionInput, type MentionInputHandle } from "./MentionInput";
import { MentionPopup } from "./MentionPopup";
import type { MentionQuery } from "../../../../shared/domain/file-mention";
import { insertMention, mentionQueryAt } from "../../../../shared/domain/file-mention";
import type { FileSuggestion } from "../../../../shared/domain/file-tree";
import { searchWorkspaceFiles } from "../../services/app";

/**
 * 可编辑区和它的占位符**共用**的度量类:内边距、字号、行高。
 *
 * ★ 常量而不是两处各写一遍 —— 两层是叠在一起的,任何一处单独改了 `px-4`,
 * 占位符从此偏移四个像素,而那看起来像是渲染 bug 不像是笔误。
 */
const DRAFT_METRICS = "px-4 pt-3.5 pb-1 text-[13.5px] leading-relaxed";

export interface ComposerValue {
  permissionMode: PermissionMode;
  model: string;
  /**
   * 用户显式选定的供应商。★ 和 `model` 是**一对**,任何一处写 `model` 的地方
   * 都必须同时写它(哪怕是 `undefined`),否则会留下「新别名 + 旧供应商」。
   */
  modelProviderId?: string;
  mode: SessionMode;
  thinking: ThinkingLevel;
  webSearch: boolean;
}

/** 应用级默认模型(设置页那个)。别名和供应商必须一起传,拆成两个 prop 必漏 */
export interface FallbackModel {
  model: string;
  modelProviderId?: string;
}

export function Composer({
  workspace,
  fallbackModel,
  draft,
  onDraft,
  running,
  onSend,
  onStop,
  attachments = [],
  onAttachFiles,
  onPickAttachment,
  onRemoveAttachment,
  onRetryAttachment,
}: {
  workspace: Workspace;
  /** 应用级默认模型(设置页那个)。工作区还没选过时用它兜底 */
  fallbackModel: FallbackModel;
  draft: string;
  onDraft: (v: string) => void;
  running: boolean;
  onSend: (text: string, value: ComposerValue) => void;
  onStop: () => void;
  /**
   * 草稿附件。★ **状态不在这里** —— 它与 draft 同级,住在 ChatView,
   * 因为发送时要把它转成 `ContentPart[]`,而那是 ChatView 的职责。
   * 这里只负责渲染与三个入口。
   */
  attachments?: TrayItem[];
  /** 拖拽 / 粘贴共用 */
  onAttachFiles?: (files: File[]) => void;
  /** 点 `+` → 走主进程 dialog */
  onPickAttachment?: () => void;
  onRemoveAttachment?: (key: string) => void;
  onRetryAttachment?: (key: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const { models: configuredModels, providers, loaded, providerOf, load } = useModelsStore();
  const models = configuredModels.filter((m) => m.enabled !== false &&
    providers.some((p) => p.id === m.providerId && p.enabled));
  const [value, setValue] = useState<ComposerValue>(() =>
    fromSettings(workspace.settings),
  );
  const input = useRef<MentionInputHandle | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 切工作区 = 换一套默认值。
   *
   * ★ **刻意不用 `useEffect([workspace.settings])`。** 药丸每改一次就会
   * `updateWorkspace` 写回,主进程随即广播 `workspace:changed` —— 那条推送回来时
   * `settings` 是个新引用,effect 会拿它把用户刚点的值再「重置」一遍。
   * 看起来就是药丸点下去闪一下又弹回原样。
   *
   * 用 React 官方那个「渲染期按 key 调整 state」的写法:只认 workspace.id 变没变。
   */
  const [seenWorkspace, setSeenWorkspace] = useState(workspace.id);
  /** 拖拽悬停高亮。★ 纯视觉状态,不影响任何数据流 */
  const [dragging, setDragging] = useState(false);

  /*
    ── `@` 文件引用 ──

    ★ `mention` 是从「草稿 + 光标位置」算出来的,不是「刚才敲了 `@`」这个事件。
      于是用户点回一个写了一半的 `@comp` 中间时,列表会重新出现 ——
      而按事件记的话,那次点击之后就再也弹不出来了。
  */
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);
  /**
   * 按过 Esc 的那个 `@` 的下标。★ 记**位置**而不是布尔:记布尔的话,
   * 用户接着往下打字会立刻又弹出来,Esc 等于没按。
   */
  const dismissedAt = useRef<number | null>(null);
  /**
   * 输入法组词中。★ 组词串**不在 `value` 里**,此刻算出来的 query 是残缺的
   * (打「文件」的过程中 value 里可能还是空的),据此去检索只会闪一串错的结果。
   */
  const composing = useRef(false);
  const mentionListId = useId();
  if (seenWorkspace !== workspace.id) {
    setSeenWorkspace(workspace.id);
    setValue(fromSettings(workspace.settings));
  }

  /**
   * 光标此刻是不是落在一个 `@查询` 里。文本变化和光标移动都过它。
   *
   * ★ `caret` 为 null 表示「此刻没有折叠光标」—— 有选区(用户在选文字)
   * 或者正在组词。两种情况都不该弹列表。
   */
  function syncMention(text: string, caret: number | null): void {
    if (composing.current) return;
    const q = caret === null ? null : mentionQueryAt(text, caret);
    if (q === null) {
      // 那个 `@` 已经不在了 —— 连同它的「按过 Esc」一起忘掉
      dismissedAt.current = null;
      setMention(null);
      return;
    }
    if (q.start === dismissedAt.current) {
      setMention(null);
      return;
    }
    setMention(q);
  }

  /*
    查询 → 候选。★ **排序在主进程做**,这里拿到的已经是最终顺序
    (见 `shared/domain/fuzzy-path.ts`);渲染层再排一遍就有两套顺序了。

    ★ 失败静默吞掉:`@` 只是个便利入口,工作区根被删掉时它给不出结果是对的,
      但不该在输入框上弹一个错误 —— 用户照样可以把路径直接打出来。
  */
  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    if (mentionQuery === null) return;
    let cancelled = false;
    setLoadingFiles(true);
    void searchWorkspaceFiles(workspace.id, mentionQuery)
      .then((r) => {
        if (cancelled) return;
        setSuggestions(r);
        setActiveSuggestion(0);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery, workspace.id]);

  /**
   * 选中一个文件:把 `@查询` 换成 `[名字](工作区相对路径)`。
   *
   * ★ 走输入框的 `replace` 而不是只 `onDraft`:草稿要经过 session store 才回来,
   * 等它回来再摆光标已经晚了一帧,而且那一帧里 tag 是「跳」出来的。
   * `replace` 当场把 DOM 和光标都摆好,`onDraft` 只是随后追平数据。
   */
  function pickFile(file: FileSuggestion): void {
    if (mention === null) return;
    const r = insertMention(draft, mention, file);
    dismissedAt.current = null;
    setMention(null);
    input.current?.replace(r.text, r.caret);
  }

  /**
   * 弹层开着时,方向键 / Enter / Tab / Esc 归它。**返回 true = 这一下已经用掉了。**
   *
   * ★ 必须在输入框的 `onKeyDown` 里截,不能让弹层自己收键:
   * 焦点一旦移出输入框,输入法组词就会被打断。
   */
  function handleMentionKey(e: React.KeyboardEvent<HTMLDivElement>): boolean {
    if (mention === null || e.nativeEvent.isComposing) return false;
    const n = suggestions.length;
    if (e.key === "ArrowDown" && n > 0) {
      e.preventDefault();
      setActiveSuggestion((i) => (i + 1) % n);
      return true;
    }
    if (e.key === "ArrowUp" && n > 0) {
      e.preventDefault();
      setActiveSuggestion((i) => (i - 1 + n) % n);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissedAt.current = mention.start;
      setMention(null);
      return true;
    }
    // ★ 没有候选时 Enter **不拦** —— 用户打了个 `@zzz` 没找到东西,
    //   这时按回车的意思是「把这句话发出去」,不是「选中那个不存在的文件」。
    if ((e.key === "Enter" || e.key === "Tab") && n > 0) {
      e.preventDefault();
      pickFile(suggestions[activeSuggestion] ?? (suggestions[0] as FileSuggestion));
      return true;
    }
    return false;
  }

  function patch(p: Partial<ComposerValue>): void {
    const next = { ...value, ...p };
    setValue(next);
    // 写回工作区当新默认值。失败只记日志 —— 药丸已经生效了,
    // 一个存不下来的默认值不值得打断用户正在写的这句话。
    void updateWorkspace({
      id: workspace.id,
      settings: toSettings(next),
    }).catch((err: unknown) => {
      console.error("[composer] 工作区默认值写回失败:", err);
    });
  }

  /**
   * 生效模型 = 工作区选过的 → 应用默认 → 列表第一个。
   *
   * **兜底结果不写回工作区**:用户没选过,那 `defaultModel` 就该继续是空的。
   * 静默替他做主的话,以后他在设置页改了应用默认模型,这个工作区却不跟着变,
   * 而他并不知道自己什么时候「选」过。
   *
   * ★ 别名和供应商**整对**地兜底,不能各挑各的:三档来源里挑出别名 A、又从
   * 另一档挑出供应商 B 的话,拼出来的是一个谁也没配过的组合,候选集直接为空。
   */
  const { model, modelProviderId } =
    value.model !== ""
      ? { model: value.model, modelProviderId: value.modelProviderId }
      : fallbackModel.model !== ""
        ? { model: fallbackModel.model, modelProviderId: fallbackModel.modelProviderId }
        : { model: models[0]?.alias ?? "", modelProviderId: models[0]?.providerId };
  const provider = providerOf(model, modelProviderId);
  const selectedModel = models.find((m) => m.alias === model && m.providerId === provider?.id);
  const thinking = loaded ? normalizeModelThinkingLevel(value.thinking, selectedModel) : value.thinking;
  useEffect(() => {
    if (!loaded || thinking === value.thinking) return;
    setValue((current) => ({ ...current, thinking }));
    void updateWorkspace({ id: workspace.id, settings: { defaultThinking: thinking } }).catch(console.error);
  }, [loaded, thinking, value.thinking, workspace.id]);
  const modelLabel =
    model !== "" ? model : loaded ? t("chat.noModel") : t("common.loading");

  function submit(): void {
    const text = draft.trim();
    // ★ 只有附件、没有文字也该能发 —— 拖一张图进来直接问「这是什么」是常见用法。
    //   但上传还没完成时不发:那样 parts 里会缺一张图,而用户以为发出去了。
    const hasReady = attachments.some((a) => a.status === "done");
    const pending = attachments.some((a) => a.status === "uploading");
    if (pending) return;
    if ((text === "" && !hasReady) || model === "") return;
    // 发送时打快照:药丸此刻的值进 RunRequest,run 跑起来后再改药丸不影响它
    // ★ `modelProviderId` 必须和 `model` 一起覆盖:两者都可能来自兜底而不在 `value` 里,
    //   只覆盖一半就会把「兜底的别名」配上「value 里那个陈旧的供应商」。
    onSend(text, { ...value, model, modelProviderId, thinking });
    onDraft("");
    // 草稿清空了,弹层也得跟着走 —— 不清的话它会挂在一个已经不存在的查询上
    dismissedAt.current = null;
    setMention(null);
  }

  /**
   * 拖拽落入。★ **过滤掉目录** —— `DataTransfer` 里的目录项 `size` 为 0 且
   * 读不出内容,不拦的话会变成一堆失败的 chip。不递归展开:
   * 一个 `node_modules` 拖进来是几万个文件。
   */
  function handleDrop(e: React.DragEvent): void {
    if (onAttachFiles === undefined) return;
    const files = [...e.dataTransfer.files].filter(
      (f) => f.size > 0 || f.type !== "",
    );
    if (files.length === 0) return;
    e.preventDefault();
    setDragging(false);
    onAttachFiles(files);
  }

  /** 粘贴。★ 截图粘贴是最高频入口,而它只有 `files`,没有文件名 */
  function handlePaste(e: React.ClipboardEvent): void {
    if (onAttachFiles === undefined) return;
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    // 不 preventDefault:剪贴板里可能同时有文字,那部分仍该正常粘进输入框
    onAttachFiles(files);
  }

  return (
    <div className="shrink-0 px-6 pb-5">
      {/*
        ★ `surface-input` 不是 `surface-raised`:深色下两者同值,浅色下输入框是**纯白**
        (#ffffff),而 raised 卡片是 #f2eee6。合并了浅色主题下输入框就沉进背景里。
      */}
      <div
        className={cn(
          "relative mx-auto w-full max-w-[760px] rounded-panel border bg-surface-input transition-colors",
          dragging ? "border-accent" : "border-border",
        )}
        onDragOver={(e) => {
          if (onAttachFiles === undefined) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={handleDrop}
      >
        {mention !== null && (
          <MentionPopup
            id={mentionListId}
            items={suggestions}
            active={activeSuggestion}
            loading={loadingFiles}
            onPick={pickFile}
            onHover={setActiveSuggestion}
          />
        )}

        <AttachmentTray
          items={attachments}
          onRemove={(k) => onRemoveAttachment?.(k)}
          onRetry={(k) => onRetryAttachment?.(k)}
        />

        <MentionInput
          value={draft}
          handle={input}
          metrics={DRAFT_METRICS}
          placeholder={running ? t("chat.queuePlaceholder") : t("chat.placeholder")}
          aria-expanded={mention !== null}
          aria-controls={mention !== null ? mentionListId : undefined}
          aria-activedescendant={
            mention !== null && suggestions.length > 0
              ? `${mentionListId}-${String(activeSuggestion)}`
              : undefined
          }
          onChange={(text, caret) => {
            onDraft(text);
            syncMention(text, caret);
          }}
          // 点击 / 方向键挪动光标也要重算 —— `@` 的判据是位置不是按键
          onCaret={(text, caret) => {
            syncMention(text, caret);
          }}
          onComposing={(v) => {
            composing.current = v;
          }}
          onBlur={() => setMention(null)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // 弹层开着时方向键 / Enter / Tab / Esc 归它,先问一句
            if (handleMentionKey(e)) return;
            // Enter 发送,Shift+Enter 换行。输入法组词期间的 Enter 是「上屏」,
            // 不是「发送」—— 少了 isComposing 这个判断,中文用户每打一个词就发一次。
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          {/* ── 权限档位:界面上就在这个位置 ── */}
          <Menu
            label={t("composer.permission")}
            width={280}
            panelClassName="rounded-xl bg-surface-input p-1 shadow-lg shadow-black/10"
            triggerClassName="rounded-full focus-visible:outline-2 focus-visible:outline-accent"
            trigger={
              <Pill accent={value.permissionMode === "full"}>
                {t(`permission.${value.permissionMode}` as "permission.ask" | "permission.auto" | "permission.full")}
                <ChevronDown size={11} className="text-fg-faint" />
              </Pill>
            }
          >
            {(close) => (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[11px] text-fg-faint">{t("composer.permission")}</div>
                {PERMISSION_MODES.map((m) => (
                  <ComposerMenuItem
                    key={m}
                    checked={m === value.permissionMode}
                    selection="radio"
                    icon={m === "ask" ? <ShieldQuestion size={16} /> : m === "auto" ? <ShieldCheck size={16} /> : <Unlock size={16} />}
                    description={t(`permission.${m}Hint` as "permission.askHint" | "permission.autoHint" | "permission.fullHint")}
                    onSelect={() => {
                      patch({ permissionMode: m });
                      close();
                    }}
                  >
                    {t(`permission.${m}` as "permission.ask" | "permission.auto" | "permission.full")}
                  </ComposerMenuItem>
                ))}
                <div className="mx-2 mt-1 border-t border-border pt-1.5 pb-1 text-[10px] leading-4 text-fg-faint">
                  {t("composer.approvalHint")}
                </div>
              </>
            )}
          </Menu>

          {/* ── `+` 统一收纳附件、会话模式和联网开关 ── */}
          <Menu
            label={t("composer.more")}
            width={320}
            panelClassName="rounded-xl bg-surface-input p-1 shadow-lg shadow-black/10"
            triggerClassName="group rounded-full focus-visible:outline-2 focus-visible:outline-accent"
            trigger={
              <span className={cn(
                "relative flex h-7 w-7 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-tint-hover hover:text-fg group-aria-expanded:bg-tint",
                (value.mode !== "normal" || value.webSearch) && "bg-tint text-fg",
              )}>
                <Plus size={16} />
                {(value.mode !== "normal" || value.webSearch) && (
                  <span aria-hidden="true" className="absolute top-1 right-1 h-1 w-1 rounded-full bg-accent" />
                )}
              </span>
            }
          >
            {(close) => (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[11px] text-fg-faint">{t("composer.add")}</div>
                <ComposerMenuItem
                  icon={<Paperclip size={16} />}
                  disabled={onPickAttachment === undefined}
                  description={t("composer.attachmentHint")}
                  onSelect={() => {
                    close();
                    onPickAttachment?.();
                  }}
                >
                  {t("composer.addAttachment")}
                </ComposerMenuItem>
                <ComposerMenuItem
                  icon={<Lightbulb size={16} />}
                  checked={value.mode === "plan"}
                  description={t("composer.planHint")}
                  onSelect={() => patch({ mode: value.mode === "plan" ? "normal" : "plan" })}
                >
                  {t("composer.plan")}
                </ComposerMenuItem>
                <ComposerMenuItem
                  icon={<Target size={16} />}
                  checked={value.mode === "goal"}
                  description={t("composer.goalHint")}
                  onSelect={() => patch({ mode: value.mode === "goal" ? "normal" : "goal" })}
                >
                  {t("composer.goal")}
                </ComposerMenuItem>
                <MenuSeparator />
                <div className="px-2 pt-1 pb-1 text-[11px] text-fg-faint">{t("common.settings")}</div>
                <ComposerMenuItem
                  checked={value.webSearch}
                  icon={<Globe size={16} />}
                  // 「完全访问」也不解除这个开关(方案 §4.5),菜单上要说出来
                  description={t("composer.webSearchHint")}
                  onSelect={() => {
                    patch({ webSearch: !value.webSearch });
                  }}
                >
                  {t("composer.webSearch")}
                </ComposerMenuItem>
              </>
            )}
          </Menu>

          {thinking !== "auto" && (
            <Pill readonly>
              <Wrench size={12} />
              <span>{t(selectedModel?.thinkingConfig?.mode === 'toggle' && thinking === 'medium'
                ? 'chat.thinkingOn' : `chat.thinkingLevel.${thinking}`)}</span>
            </Pill>
          )}

          <div className="flex-1" />

          {/*
            ── 模型选择器:靠右,紧挨发送按钮 ──
            截图 c6184031 里这一排是**两头分布**的:左边是「这一轮怎么执行」
            (权限档位 / `+` 会话选项),右边是「发给谁」加发送。
            模型属于后者 —— 它和发送按钮是一件事的两半,挤在左边那堆开关里
            会被当成又一个开关。
          */}
          <ModelPicker
            model={model}
            modelProviderId={modelProviderId}
            modelLabel={modelLabel}
            provider={provider}
            providers={providers}
            models={models}
            loaded={loaded}
            thinking={thinking}
            onModel={(nextModel, nextProviderId) => patch({
              model: nextModel,
              // 用户从菜单里点选是**唯一**会把供应商写进工作区的时机(兜底不写回)。
              modelProviderId: nextProviderId,
              thinking: normalizeModelThinkingLevel(thinking, models.find(
                (m) => m.alias === nextModel && m.providerId === nextProviderId
              ))
            })}
            onThinking={(thinking) => patch({ thinking })}
          />

          <button
            type="button"
            data-testid="composer-send"
            aria-label={running ? t("chat.stop") : t("chat.send")}
            // 生成中按钮变「停止」,但输入框仍可打字 —— 排队走 Enter
            onClick={running ? onStop : submit}
            disabled={!running && (draft.trim() === "" || model === "")}
            title={
              running
                ? t("composer.stopGeneration")
                : model === ""
                  ? t("composer.noAvailableModel")
                  : model
            }
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-pill transition-colors",
              running
                ? "bg-tint-strong text-fg hover:bg-tint-hover"
                : "bg-accent text-accent-fg hover:opacity-90",
              "disabled:cursor-not-allowed disabled:bg-tint disabled:text-fg-faint",
            )}
          >
            {running ? (
              <Square size={12} fill="currentColor" />
            ) : (
              <ArrowUp size={15} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 输入框菜单的操作与开关共用一行布局，开关保持菜单展开以便连续调整。 */
function ComposerMenuItem({
  children,
  icon,
  description,
  checked,
  selection = "toggle",
  disabled = false,
  onSelect,
}: {
  children: ReactNode;
  icon: ReactNode;
  description: string;
  checked?: boolean;
  selection?: "radio" | "toggle";
  disabled?: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : selection === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={checked}
      title={description}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-fg transition-colors hover:bg-tint focus-visible:bg-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:opacity-40",
        checked && selection === "radio" && "bg-tint/70",
      )}
    >
      <span aria-hidden="true" className="shrink-0 text-fg-muted [&>svg]:size-3.5">{icon}</span>
      <span className={cn("min-w-0 flex-1", selection !== "radio" && "flex items-baseline gap-1.5")}>
        <span className="block shrink-0 text-[12px] leading-[18px]">{children}</span>
        <span className="block truncate text-[11px] leading-4 text-fg-faint">{description}</span>
      </span>
      {checked !== undefined && (
        selection === "radio" ? (
          <Check aria-hidden="true" size={13} className={cn("shrink-0 text-accent", !checked && "invisible")} />
        ) : (
          <span aria-hidden="true" className={cn("flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors", checked ? "bg-accent" : "bg-tint-strong")}>
            <span className={cn("h-2.5 w-2.5 rounded-full transition-transform motion-reduce:transition-none", checked ? "translate-x-2.5 bg-accent-fg" : "bg-fg-muted")} />
          </span>
        )
      )}
    </button>
  );
}

function Pill({
  children,
  active = false,
  readonly = false,
  accent = false,
}: {
  children: ReactNode;
  active?: boolean;
  /** 只读徽标:重复显示 `+` 菜单里已开的项,让它们在收起状态下也看得见 */
  readonly?: boolean;
  /**
   * 参考实现里**整个浅色界面只有两处用色**,这排药丸占掉一处(另一处是发送按钮):
   * 「完全访问」是底 `accent/10` + 字/图标 accent,其余档位是中性的。
   * 所以这不是「一种药丸样式」,是「这一档要提醒你它放开了权限」——
   * 拿它去染别的药丸,界面里唯一的色相就失去意义了。
   *
   * ★ 底色写半透明而不是一个实色 token:量到的深 #2a3d33 / 浅 #e8ebe9
   *   反解出来正好都是 accent @10% 压在输入框底上(`theme.css` §5)。
   *   于是换颜色主题时药丸底自己跟着 accent 走,不用另外声明。
   */
  accent?: boolean;
}): ReactNode {
  return (
    <span
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-[12.5px]",
        readonly
          ? "bg-tint/60 text-fg-muted"
          : accent
            ? "bg-accent/10 text-accent transition-colors"
            : "transition-colors hover:bg-tint-hover " +
              (active ? "bg-tint text-fg" : "text-fg-muted hover:text-fg"),
      )}
    >
      {children}
    </span>
  );
}

/**
 * 模型选择采用两级结构：第一次打开先选供应商，进入供应商后再选模型。
 * 这样模型别名很多时不会把所有供应商混在一个长菜单里；底部固定保留本轮模型
 * 配置（当前是思考强度），切换模型时不需要再去“更多”菜单里找。
 */
function ModelPicker({
  model,
  modelProviderId,
  modelLabel,
  provider,
  providers,
  models,
  loaded,
  thinking,
  onModel,
  onThinking,
}: {
  model: string;
  modelProviderId?: string;
  modelLabel: string;
  provider?: UpstreamProvider;
  providers: UpstreamProvider[];
  models: ModelAlias[];
  loaded: boolean;
  thinking: ThinkingLevel;
  onModel: (model: string, modelProviderId: string) => void;
  onThinking: (thinking: ThinkingLevel) => void;
}): ReactNode {
  const { t } = useI18n();
  const [providerId, setProviderId] = useState<string | null>(null);
  const selectedModel = models.find((m) => m.alias === model && m.providerId === provider?.id);
  const thinkingLevels = modelThinkingLevels(selectedModel);
  const thinkingConfig = selectedModel?.thinkingConfig;
  const thinkingLabel = (level: ThinkingLevel): string => t(
    thinkingConfig?.mode === 'toggle' && level === 'medium' ? 'chat.thinkingOn' : `chat.thinkingLevel.${level}`
  );
  const defaultLevel: ThinkingLevel = thinkingConfig?.defaultEnabled !== true || thinkingConfig.defaultEffort === 'none'
    ? 'off' : thinkingConfig.defaultEffort === 'xhigh' ? 'higher' : thinkingConfig.defaultEffort ?? 'medium';
  const thinkingDescription = thinkingConfig?.mode === 'unsupported' ? t('chat.thinkingUnsupported')
    : thinkingConfig?.mode === 'always' ? t('chat.thinkingAlways')
    : thinking === 'auto' && thinkingConfig !== undefined
      ? t('chat.thinkingAutomatic', { level: thinkingLabel(defaultLevel) })
      : t('chat.thinkingLevelDescription', { level: thinkingLabel(thinking) });
  const [configOpen, setConfigOpen] = useState(false);
  const [submenuAnchor, setSubmenuAnchor] = useState<HTMLButtonElement | null>(
    null,
  );
  const providerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeMenuRef = useRef<() => void>(() => {});
  const availableProviders = providers.filter((p) =>
    models.some((m) => m.providerId === p.id),
  );
  const openProviderSubmenu = (id: string): void => {
    setProviderId(id);
    setSubmenuAnchor(providerRefs.current[id] ?? null);
  };

  return (
    <>
      <Menu
        label={t("chat.modelPicker")}
        width={300}
        align="end"
        trigger={
          <Pill>
            <ProviderIcon
              name={[model, provider?.name, provider?.id]}
              size={13}
            />
            <span className="max-w-[150px] truncate">{modelLabel}</span>
            <ChevronRight size={12} className="ml-0.5 text-fg-faint" />
          </Pill>
        }
        onOpenChange={(open) => {
          if (!open) {
            setProviderId(null);
            setConfigOpen(false);
            setSubmenuAnchor(null);
          }
        }}
        containsTarget={(target) =>
          submenuRef.current?.contains(target) ?? false
        }
      >
        {(close) => {
          closeMenuRef.current = close;
          if (configOpen) {
            return (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfigOpen(false)}
                  className="app-no-drag mb-1 flex w-full items-center gap-1.5 rounded-[7px] px-2.5 py-2 text-left text-[12px] text-fg-muted transition-colors hover:bg-tint-strong hover:text-fg"
                >
                  <ChevronLeft size={14} />
                  <span>{t("chat.backToProviders")}</span>
                </button>
                <MenuSeparator />
                <MenuLabel>
                  <span className="flex items-center gap-1.5">
                    <BrainCircuit size={12} />
                    {t("chat.modelConfigThinking")}
                  </span>
                </MenuLabel>
                <MenuLabel>{thinkingDescription}</MenuLabel>
                {thinkingLevels.map((level) => (
                  <MenuItem
                    key={level}
                    checked={level === thinking}
                    onSelect={() => {
                      onThinking(level);
                      close();
                    }}
                  >
                    {thinkingLabel(level)}
                  </MenuItem>
                ))}
              </>
            );
          }

          return (
            <>
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <Settings2 size={12} />
                  {t("chat.selectProvider")}
                </span>
              </MenuLabel>
              {!loaded ? (
                <MenuLabel>{t("common.loading")}</MenuLabel>
              ) : availableProviders.length === 0 ? (
                <MenuLabel>{t("chat.noModelsConfigured")}</MenuLabel>
              ) : (
                availableProviders.map((p) => {
                  const count = models.filter(
                    (m) => m.providerId === p.id,
                  ).length;
                  return (
                    <MenuItem
                      key={p.id}
                      checked={p.id === provider?.id}
                      description={t("chat.availableModels", { count })}
                      buttonRef={(node) => {
                        providerRefs.current[p.id] = node;
                      }}
                      onHover={() => openProviderSubmenu(p.id)}
                      onSelect={() => openProviderSubmenu(p.id)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {p.name}
                        </span>
                        <ChevronRight size={13} className="text-fg-faint" />
                      </span>
                    </MenuItem>
                  );
                })
              )}
              <MenuSeparator />
              <MenuItem
                icon={<BrainCircuit size={14} />}
                description={thinkingDescription}
                disabled={thinkingLevels.length < 2}
                onSelect={() => {
                  setConfigOpen(true);
                  setProviderId(null);
                  setSubmenuAnchor(null);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {t("chat.modelConfig")}
                  </span>
                  <ChevronRight size={13} className="text-fg-faint" />
                </span>
              </MenuItem>
            </>
          );
        }}
      </Menu>
      {submenuAnchor !== null &&
      providerId !== null &&
      typeof document !== "undefined"
        ? createPortal(
            <ModelSubmenu
              anchor={submenuAnchor}
              panelRef={(node) => {
                submenuRef.current = node;
              }}
              provider={providers.find((p) => p.id === providerId)}
              models={models.filter((m) => m.providerId === providerId)}
              model={model}
              modelProviderId={modelProviderId}
              onSelect={(alias, selectedProviderId) => {
                onModel(alias, selectedProviderId);
                closeMenuRef.current();
                setSubmenuAnchor(null);
                setProviderId(null);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function ModelSubmenu({
  anchor,
  panelRef,
  provider,
  models,
  model,
  modelProviderId,
  onSelect,
}: {
  anchor: HTMLElement;
  panelRef: (node: HTMLDivElement | null) => void;
  provider?: UpstreamProvider;
  models: ModelAlias[];
  model: string;
  modelProviderId?: string;
  onSelect: (alias: string, modelProviderId: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const width = 300;
  const panelNode = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const panelHeight = Math.min(
        panelNode.current?.scrollHeight ?? 0,
        Math.max(0, viewportHeight - 16),
      );
      const preferredLeft =
        rect.right + 6 + width <= viewportWidth
          ? rect.right + 6
          : rect.left - width - 6;
      const left = Math.max(
        8,
        Math.min(preferredLeft, viewportWidth - width - 8),
      );
      // 与触发项顶部对齐；下方空间不足时向上推，确保整个弹层留在视口内。
      const top = Math.max(
        8,
        Math.min(rect.top, viewportHeight - panelHeight - 8),
      );
      setPosition({ top, left });
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    if (panelNode.current !== null) resizeObserver.observe(panelNode.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, models.length]);

  return (
    <div
      ref={(node) => {
        panelNode.current = node;
        panelRef(node);
      }}
      role="menu"
      style={{
        width,
        top: position.top,
        left: position.left,
        maxHeight: "calc(100vh - 16px)",
      }}
      className="app-no-drag scroll-thin fixed z-[60] overflow-y-auto rounded-card border border-border bg-surface-raised p-1 shadow-2xl shadow-black/40"
    >
      <MenuLabel>{provider?.name ?? t("chat.modelPicker")}</MenuLabel>
      {models.map((m) => {
        return (
          <MenuItem
            key={`${m.providerId}/${m.alias}`}
            // ★ 必须带上 providerId:同一个别名在两家的子菜单里都会出现,只比别名的话
            //   **两边同时打勾**,用户会以为自己选了两个。
            checked={m.alias === model && m.providerId === modelProviderId}
            onSelect={() => onSelect(m.alias, m.providerId)}
          >
            {m.alias}
          </MenuItem>
        );
      })}
    </div>
  );
}

// ── 药丸值 ↔ 工作区设置。两边字段名一致,但**不是同一个类型** ──
// WorkspaceSettings 还有 activeSkillIds,而药丸不碰它。直接 spread 会把它抹掉。

function fromSettings(s: WorkspaceSettings): ComposerValue {
  return {
    permissionMode: s.permissionMode,
    model: s.defaultModel,
    modelProviderId: s.defaultModelProviderId,
    mode: s.defaultMode,
    thinking: s.defaultThinking,
    webSearch: s.webSearch,
  };
}

function toSettings(v: ComposerValue): Partial<WorkspaceSettings> {
  return {
    permissionMode: v.permissionMode,
    defaultModel: v.model,
    // ★ **无条件**写,不能条件展开:主进程那边是深合并,漏写这一项时旧的供应商
    //   会原样留下,于是得到「新别名 + 旧供应商」—— 正是这次修复要消灭的那个形状。
    defaultModelProviderId: v.modelProviderId,
    defaultMode: v.mode,
    defaultThinking: v.thinking,
    webSearch: v.webSearch,
  };
}
