/**
 * 转录里的三种非文本块:思考 / 工具调用 / 子代理。
 *
 * 单独一个文件是因为**已提交的消息和还在流的块要用同一套渲染**:
 * `messages[].parts` 走这里,`transcript.live` 也走这里。两处各写一份的话,
 * 一个块从「流式中」变成「已提交」的那一瞬间会跳一下 —— 而那正是用户
 * 最容易注意到的时刻。
 *
 * ★ 批次 2 之后,工具行的**长相由 `shared/domain/tool-presenter.ts` 决定**,
 * 这个文件只负责把 presenter 的输出摆进版式里。新增一个工具的展示规则
 * 不需要动这里一行。
 */
import { Bot, Brain, ChevronRight, CornerDownRight, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatCallDuration } from "../../../../shared/agent/duration";
import { elapsedOf, formatDuration } from "../../../../shared/agent/duration";
import type { SubagentState, ToolCallState } from "../../../../shared/agent/transcript";
import { presenterOf } from "../../../../shared/domain/tool-presenter";
import { cn } from "../../lib/cn";
import { useI18n } from "../../i18n";
import { agentErrorText } from "../../i18n/agent";
import { AgentMarkdown } from "../../components/markdown";
import { ToolDetail } from "./ToolDetail";
import { ToolIcon, type ToolViewStatus } from "./ToolIcon";
import { abortRun } from "../../services/agent";

/**
 * 「深度思考 N 秒」—— 截图里是一条可折叠的行,默认收起。
 *
 * 流式过程中默认展开:思考先于正文到达,收着的话用户会盯着一个
 * 什么都不动的空白等好几秒。提交之后再收起来。
 */
export function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): ReactNode {
  const { t } = useI18n();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;
  if (!streaming && text.trim() === '') return null;
  return (
    <div className="rounded-card bg-surface-raised/60" data-testid="thinking-block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-fg-muted transition-colors hover:text-fg"
      >
        <ChevronRight
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Brain size={13} className="shrink-0 text-accent-soft" />
        <span className="min-w-0 flex-1 truncate">
          {streaming ? t("chat.thinkingNow") : t("chat.thinking")}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pl-[30px]">
          <AgentMarkdown content={text} streaming={streaming} variant="compact" />
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用卡片。
 *
 * ★ 入参和结果都**折叠**:一个 `Read` 的结果可能是 60KB
 * (`MAX_TOOL_OUTPUT_CHARS` 之内的合法体积),全铺开会把对话冲垮。
 * 展开是用户的选择,不是默认 —— **除了失败**,见下面 `open` 的算法。
 *
 * ★ **props 保持三参不变**(`call` / `name` / `input`)。批次 2 新增的所有能力
 * (图标、耗时、差异化标题与详情)全部收在组件内部,`Thread.tsx` 两处调用点
 * 一行都不用改 —— 那两处必须同构,少改一处就是「已提交」和「流式中」长得不一样。
 */
export function ToolCallCard({
  call,
  name,
  input,
}: {
  /** 从 `transcript.tools[callId]` 来;还没收到 tool_start 时可能是 undefined */
  call: ToolCallState | undefined;
  /** 兜底:`tool_call` part 自带名字,即使 tools 表里还没有它 */
  name: string;
  input: unknown;
}): ReactNode {
  /**
   * `null` = 用户还没表态,按默认规则走;一旦点过就永久接管。
   *
   * ★ 不能写成 `useState(status === 'error')` —— 初始值只在挂载时算一次,
   * 而工具是先 running 后 error 的,那样失败永远不会自动展开。
   */
  const [manual, setManual] = useState<boolean | null>(null);

  const status: ToolViewStatus = call === undefined ? "pending" : call.status;
  const shownInput = call?.input ?? input;
  const toolName = call?.name ?? name;
  const presenter = presenterOf(toolName);

  // 失败默认展开:`toolFail` 的文案是设计过的可执行提示(见 fs.ts 里 Edit 失败
  // 那段三段式说明),把它藏在折叠里等于白写。
  const open = manual ?? status === "error";

  const duration = call === undefined ? undefined : formatCallDuration(call);
  const summary = presenter.summary?.(shownInput, call?.output);

  return (
    <div
      // 状态同时给一个机器可读的属性:e2e 探针读它,而不是去正则「完成/失败」
      // 这几个会改的中文字(同 StatusLine 的理由)
      data-testid="tool-call"
      data-tool-status={status}
      data-tool-shape={presenter.shape}
      className={cn(
        "overflow-hidden rounded-card border bg-surface-raised/60",
        status === "error" ? "border-danger/40" : "border-border",
      )}
    >
      {/* 失败时左侧一道竖条:在一屏十几行工具里,颜色差比文字差更快被扫到 */}
      <div className="flex">
        {status === "error" && (
          <span aria-hidden className="w-[2px] shrink-0 bg-danger" />
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setManual(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-tint-hover/40"
        >
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 text-fg-faint transition-transform",
              open && "rotate-90",
            )}
          />
          <ToolIcon shape={presenter.shape} status={status} />
          <span className="min-w-0 flex-1 truncate text-fg">
            {presenter.title(shownInput)}
          </span>

          {/* 运行中的一行进度优先于摘要 —— 它是此刻唯一在变的信息 */}
          {call?.progress !== undefined ? (
            <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-faint">
              {call.progress}
            </span>
          ) : (
            summary !== undefined && (
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-faint">
                {summary}
              </span>
            )
          )}

          <StatusSlot status={status} duration={duration} />
        </button>
      </div>

      {open && (
        <div className="border-t border-hairline px-3 py-2">
          <ToolDetail
            shape={presenter.shape}
            input={shownInput}
            output={call?.output}
            isError={status === "error"}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 行右端那一个插槽。
 *
 * ★ **成功态显示耗时而不是「完成」二字。** 一行只有一个右侧插槽,而「完成」
 * 是默认结果、信息量接近于零;耗时才是用户会主动去看的那个数。
 * 失败态相反 —— 它必须占满这个插槽,不能被任何数字挤掉。
 */
function StatusSlot({
  status,
  duration,
}: {
  status: ToolViewStatus;
  duration: string | undefined;
}): ReactNode {
  const { t } = useI18n();
  if (status === "error") {
    return (
      <span className="shrink-0 text-[11px] text-danger">
        {t("chat.tool.failedStatus")}
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="shrink-0 text-[11px] text-accent">
        {t("chat.tool.runningStatus")}
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="shrink-0 text-[11px] text-fg-faint">
        {t("chat.tool.waitingStatus")}
      </span>
    );
  }
  // ok:有耗时就显示耗时,没有(旧转录)就什么都不显示 —— 空着比写「完成」干净
  return duration === undefined ? null : (
    <span className="shrink-0 font-mono text-[11px] text-fg-faint">
      {duration}
    </span>
  );
}

/** 子代理：展示子 run 的状态、耗时、模型、工具统计和上下文压力。 */
export function SubagentNode({
  summary,
  state,
}: {
  summary: string | undefined;
  state?: SubagentState;
}): ReactNode {
  const { t } = useI18n();
  const [manual, setManual] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = state?.status === 'running';

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const status = state?.status ?? 'done';
  const errorText = state?.error === undefined ? undefined : agentErrorText(state.error, t);
  /*
    ★★ 「正在退避重试」以前**只画在主对话的状态行上**,而子代理不看状态行 ——
    于是限流退避在这张卡片上和「跑得慢」一模一样,几次退避全失败之后直接跳到
    错误框,看起来就像子代理根本没重试(它和主代理走的是同一份 `router.ts`)。

    ★ 卡片默认折叠(只有失败才自动展开),所以标题行那一格必须先说一句短的;
    带原因的完整句子放在展开后的横幅里,复用状态行那两条文案。
  */
  const notice = running ? state?.notice : undefined;
  const noticeLabel = notice === undefined
    ? undefined
    : notice.kind === 'retry'
      ? t('chat.subagent.notice.retry', { attempt: notice.attempt })
      : t('chat.subagent.notice.switch', { to: notice.to });
  const noticeDetail = notice === undefined
    ? undefined
    : notice.kind === 'retry'
      ? t('chat.status.retrying', { attempt: notice.attempt, reason: notice.reason })
      : t('chat.status.providerSwitched', { to: notice.to, reason: notice.reason });
  // Failed subagents expose their diagnostic automatically; users can still collapse it.
  const open = manual ?? status === 'error';
  const duration = state?.startedAt === undefined
    ? undefined
    : formatDuration(elapsedOf({ startedAt: state.startedAt, endedAt: state.endedAt }, now) ?? 0)
  const title = state?.description ?? summary ?? t("chat.subagent.default");
  const phaseKey = state?.phase === undefined ? undefined : `chat.subagent.phase.${state.phase}` as
    | 'chat.subagent.phase.starting'
    | 'chat.subagent.phase.thinking'
    | 'chat.subagent.phase.tool'
    | 'chat.subagent.phase.finishing'
    | 'chat.subagent.phase.background'
  const stop = (): void => {
    if (state?.childRunId !== undefined) void abortRun(state.childRunId, true)
  }

  return (
    <div
      className="overflow-hidden rounded-card border border-border bg-surface-raised/40 text-[12.5px] text-fg-muted"
      data-testid="subagent-node"
      data-subagent-status={status}
      data-subagent-background={state?.background === true ? 'true' : 'false'}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-tint-hover/40"
      >
        <ChevronRight size={13} className={cn("shrink-0 text-fg-faint transition-transform", open && "rotate-90")} />
        <CornerDownRight size={13} className="shrink-0 text-accent-soft" />
        <Bot size={14} className={cn("shrink-0", running ? "text-accent" : status === 'error' ? "text-danger" : "text-fg-faint")} />
        <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
        {state?.subagentType !== undefined && <span className="max-w-[24%] truncate text-[11px] text-fg-faint">{state.subagentType}</span>}
        {state?.background === true && <span className="shrink-0 text-[11px] text-accent-soft">{t('chat.subagent.mode.background')}</span>}
        <span className={cn("shrink-0 text-[11px]",
          noticeLabel !== undefined ? "text-danger" : running ? "text-accent" : status === 'error' ? "text-danger" : "text-fg-faint")}>
          {noticeLabel ?? t(`chat.subagent.status.${status}` as 'chat.subagent.status.running' | 'chat.subagent.status.done' | 'chat.subagent.status.error' | 'chat.subagent.status.aborted')}
        </span>
        {duration !== undefined && <span className="shrink-0 font-mono text-[11px] text-fg-faint">{duration}</span>}
      </button>
      {open && (
        <div className="border-t border-hairline px-3 py-2.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-fg-faint">
            <span>{t('chat.subagent.detail.model')}</span><span className="truncate text-right text-fg">{state?.model ?? t('common.default')}</span>
            <span>{t('chat.subagent.detail.mode')}</span><span className="text-right text-fg">{state?.background === true ? t('chat.subagent.mode.background') : state?.background === false ? t('chat.subagent.mode.foreground') : t('chat.subagent.unavailable')}</span>
            <span>{t('chat.subagent.detail.phase')}</span><span className="text-right text-fg">{phaseKey === undefined ? t('chat.subagent.unavailable') : t(phaseKey)}</span>
            <span>{t('chat.subagent.detail.duration')}</span><span className="text-right font-mono text-fg">{duration ?? t('chat.subagent.unavailable')}</span>
            <span>{t('chat.subagent.detail.tools')}</span><span className="text-right text-fg">{state?.toolCalls ?? 0}</span>
            <span>{t('chat.subagent.detail.errors')}</span><span className={cn("text-right", (state?.toolErrors ?? 0) > 0 ? "text-danger" : "text-fg")}>{state?.toolErrors ?? 0}</span>
            {state?.contextUsage !== undefined && <>
              <span>{t('chat.subagent.detail.context')}</span>
              <span className="text-right text-fg">{state.contextUsage.used.toLocaleString()} / {state.contextUsage.window.toLocaleString()}</span>
            </>}
            <span>{t('chat.subagent.detail.runId')}</span><code className="truncate text-right text-fg-faint">{state?.childRunId ?? t('chat.subagent.unavailable')}</code>
          </div>
          {noticeDetail !== undefined && (
            <div
              data-testid="subagent-notice"
              className="selectable mt-2 whitespace-pre-wrap break-words rounded-[5px] border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] leading-relaxed text-danger"
            >
              {noticeDetail}
            </div>
          )}
          {state?.currentTool !== undefined && (
            <div className="mt-2 truncate rounded-[5px] bg-tint px-2 py-1 text-[11px] text-fg">
              {t('chat.subagent.detail.currentTool', { tool: state.currentTool })}
            </div>
          )}
          {status === 'error' && (
            <div className="selectable mt-2 whitespace-pre-wrap break-words rounded-[5px] border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11.5px] leading-relaxed text-danger">
              {errorText === undefined || errorText.trim() === ''
                ? t('chat.subagent.detail.errorUnknown')
                : t('chat.subagent.detail.errorMessage', { error: errorText })}
            </div>
          )}
          {state?.summary !== undefined && state.summary !== summary && (
            <p className="selectable mt-2 border-t border-hairline pt-2 text-[11.5px] leading-relaxed text-fg">{state.summary}</p>
          )}
          {running && (
            <button
              type="button"
              onClick={stop}
              className="mt-2 inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10"
            >
              <Square size={11} />
              {t('chat.subagent.stop')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
