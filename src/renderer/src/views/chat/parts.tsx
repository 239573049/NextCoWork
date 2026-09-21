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
import { Bot, Brain, CheckCircle2, ChevronRight, CircleAlert, Clock3, ListChecks, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatCallDuration } from "../../../../shared/agent/duration";
import { elapsedOf, formatDuration } from "../../../../shared/agent/duration";
import type { SubagentState, ToolCallState } from "../../../../shared/agent/transcript";
import {
  presenterOf,
  pluginPresentersSnapshot,
  subscribePluginPresenters,
} from "../../../../shared/domain/tool-presenter";
import { agentColorHex } from "../../../../shared/domain/agent-def";
import { cn } from "../../lib/cn";
import { useI18n } from "../../i18n";
import { agentErrorText } from "../../i18n/agent";
import { AgentMarkdown } from "../../components/markdown";
import { Surface, SurfaceReveal, SurfaceRow } from "../../components/ui/Surface";
import { ToolDetail } from "./ToolDetail";
import { previewOf } from "./interaction-preview";
import { MAX_PARTIAL_JSON_CHARS, parsePartialJson } from "./partial-json";
import { ToolIcon, type ToolViewStatus } from "./ToolIcon";
import { abortRun } from "../../services/agent";
import { getSession } from "../../services/sessions";
import { visibleText } from "../../../../shared/agent/message";
import { useOpenSubagent } from "./subagent-open";
import { useStopToolCall } from "./tool-stop";
import { AgentActivityGrid, AgentShimmerText } from "./AgentActivity";

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
  const body = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const open = manual ?? streaming;

  useEffect(() => {
    if (!streaming || !open || !followBottom.current || body.current === null) return;
    body.current.scrollTop = body.current.scrollHeight;
  }, [open, streaming, text]);

  if (!streaming && text.trim() === '') return null;
  return (
    <Surface data-testid="thinking-block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-tint-hover/40 hover:text-fg"
      >
        <ChevronRight
          size={13}
          className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")}
        />
        {streaming
          ? <AgentActivityGrid className="text-accent" />
          : <Brain size={13} className="shrink-0 text-fg-faint" />}
        <span className="min-w-0 flex-1 truncate">
          {streaming
            ? <AgentShimmerText>{t("chat.thinkingNow")}</AgentShimmerText>
            : t("chat.thinking")}
        </span>
      </button>
      <SurfaceReveal open={open} className="pl-[30px]">
        <div
          ref={body}
          className="scroll-thin max-h-[min(40vh,320px)] overflow-y-auto border-l border-hairline pl-3 pr-1"
          onScroll={(event) => {
            const el = event.currentTarget;
            followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          <AgentMarkdown content={text} streaming={streaming} variant="compact" />
        </div>
      </SurfaceReveal>
    </Surface>
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
  const { t } = useI18n();
  /**
   * `null` = 用户还没表态,按默认规则走;一旦点过就永久接管。
   *
   * ★ 不能写成 `useState(status === 'error')` —— 初始值只在挂载时算一次,
   * 而工具是先 running 后 error 的,那样失败永远不会自动展开。
   */
  const [manual, setManual] = useState<boolean | null>(null);

  // 订阅插件 presenter 注入版本:catalog 若在这张卡片**提交之后**才加载,
  // presenterOf 是命令式查表、不会自动重渲,已提交的插件工具卡片会永久停在
  // 兜底标题。订阅 version 让注入到达时重渲一次。见 tool-presenter 注入层注释。
  useSyncExternalStore(subscribePluginPresenters, pluginPresentersSnapshot);

  const status: ToolViewStatus = call === undefined ? "pending" : call.status;
  // 卡片只需要一个有界预览。否则 Write 的大段 content 每来一帧就从头重扫一次，
  // 参数生成过程会退化成二次方工作量；超过上限后前缀不变，useMemo 也不再重算。
  const pendingSource = typeof input === "string"
    ? input.slice(0, MAX_PARTIAL_JSON_CHARS)
    : input;
  const pendingInput = useMemo(() => {
    if (typeof pendingSource !== "string") return pendingSource;
    const parsed = parsePartialJson(pendingSource);
    return parsed === undefined ? pendingSource : parsed;
  }, [pendingSource]);
  // ★ 上游参数还没闭合时 `input` 是原始 JSON 前缀。只把解析出的快照交给展示层；
  // tool_start 到达后立刻切回内核严格解析的 `call.input`，绝不拿容错结果执行工具。
  const shownInput = call?.input ?? pendingInput;
  const toolName = call?.name ?? name;
  const presenter = presenterOf(toolName);

  // 结果快照卡片(output.card,静态)或运行中的实时卡片(call.card,第 2 层交互)。
  // 实时卡片优先:工具还在跑、这张才是此刻在变的。
  const liveCard = call?.card;
  const card = liveCard ?? call?.output?.card;

  // 失败默认展开:`toolFail` 的文案是设计过的可执行提示(见 fs.ts 里 Edit 失败
  // 那段三段式说明),把它藏在折叠里等于白写。
  // 运行中的实时卡片也默认展开:它可能要用户点(审批/表单),藏起来就没人应答。
  /*
    需求：AskUserQuestion / ProposeGoal 的题面要在模型**还在写参数**时就能读到，
    而不是等工具开跑、待决面板弹出来才第一次看见（题面到可作答之间常隔好几秒）。

    ★ 判据是 `status === "pending"`，即**这次调用还没开跑**：tool_start 一到，
    下面那张可作答的卡片就出现了，这张只读预览必须同时收起来 —— 同屏摆两份
    一模一样的题，用户不知道该点哪一份，而只有一份是真能提交的。
    `previewOf` 拿不出内容时不展开：ExitPlanMode 的入参是空对象（题面在计划文件里），
    自动展开只会得到一个永远空着的详情区。
  */
  const previewable = presenter.shape === "interaction"
    && status === "pending"
    && previewOf(toolName, shownInput) !== null;
  /*
    需求：`widget` 形态的产物（`visualize_show_widget` 画的那张图）**默认展开**。

    ★ 判据是形态类，不是工具名 —— 见 `ToolShape` 里 `widget` 那一段。按工具名
    分叉的话，下一个"自己画一张图"的工具要在这里再开一个口子，而漏掉它不会有
    任何编译错误：表现是**工具跑完、图上什么也没有**，因为 `SurfaceReveal`
    在收起态是直接卸载子树（`components/ui/Surface.tsx`），折叠时连 iframe 都
    不存在。用户看到的会是一个"成功的工具"配一片空白。

    ★ 与上面那条 interaction 预览的区别：那条只看 `pending`（工具一开跑就收起，
    因为下面会冒出可作答的卡片）；这条**全程展开** —— 生成期是边走边画，
    跑完就是成品本身，不存在"另一处更权威的展示"。
  */
  const inlineWidget = presenter.shape === "widget";
  const open = manual ?? (status === "error" || liveCard !== undefined || previewable || inlineWidget);

  const duration = call === undefined ? undefined : formatCallDuration(call);
  const summary = presenter.summary?.(shownInput, call?.output);
  // 需求：工具的目标/进度收进紧凑 chip；底层 presenter 仍是唯一文案来源，
  // 否则视觉替换会把插件工具和流式中的参数重新降级成通用名称。
  const progress = call?.progress?.trim();
  const detail = progress !== undefined && progress !== "" ? progress : summary;
  const detailMono = presenter.shape === "read" || presenter.shape === "mutate" || presenter.shape === "command";
  /*
    需求：一条跑飞的命令（`npm test` 挂住、构建停不下来）要能被单独掐掉，
    而不是只能停掉整轮回复。主进程只为 `Bash` 寄存了停止句柄，所以这里的判据是
    presenter 里那条**能力声明**，不是「反正画上总没坏处」——
    画一颗按下去没反应的按钮，比没有按钮难解释得多（§5 不做防御式 UI）。
  */
  const stopToolCall = useStopToolCall();
  const stoppableCallId = presenter.stoppable === true && status === "running" && call !== undefined
    ? call.callId
    : undefined;
  const stop = stopToolCall === undefined || stoppableCallId === undefined
    ? undefined
    : (): void => { stopToolCall(stoppableCallId) };

  return (
    <Surface
      // 状态同时给一个机器可读的属性:e2e 探针读它,而不是去正则「完成/失败」
      // 这几个会改的中文字(同 StatusLine 的理由)
      data-testid="tool-call"
      data-tool-status={status}
      data-tool-shape={presenter.shape}
      // 失败时左侧一道竖条:在一屏十几行工具里,颜色差比文字差更快被扫到
      tone={status === "error" ? "danger" : "default"}
      rail={status === "error" ? "danger" : undefined}
    >
      {/* 停止按钮是标题行的**兄弟**,不是它的子节点 —— 按钮不能套按钮(同 SubagentNode) */}
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setManual(!open)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-tint-hover/40"
        >
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 text-fg-faint transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <ToolIcon shape={presenter.shape} status={status} />
          <span className="min-w-0 flex-1 truncate font-medium text-fg">
            {presenter.title(shownInput)}
          </span>

          {detail !== undefined && (
            <span className={cn(
              "inline-flex h-5 max-w-[42%] min-w-0 shrink-0 items-center rounded-[6px] border border-hairline bg-surface-input/55 px-1.5 text-[10.5px] text-fg-muted",
              detailMono && "font-mono",
            )}>
              <span className="min-w-0 truncate">{detail}</span>
            </span>
          )}

          <StatusSlot status={status} duration={duration} />
        </button>
        {stop !== undefined && (
          <button
            type="button"
            data-testid="tool-stop"
            onClick={stop}
            aria-label={t("chat.tool.stop")}
            title={t("chat.tool.stop")}
            className="mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-danger transition-colors hover:bg-danger/10 motion-reduce:transition-none"
          >
            <Square size={10} />
          </button>
        )}
      </div>

      <SurfaceReveal open={open}>
        <ToolDetail
          shape={presenter.shape}
          input={shownInput}
          output={call?.output}
          isError={status === "error"}
          toolName={toolName}
          callId={call?.callId}
          card={card}
        />
      </SurfaceReveal>
    </Surface>
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
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
        <AgentActivityGrid />
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

/**
 * 子代理卡片 —— **一张摘要,不是一个抽屉。**
 *
 * ★ 它以前是个手风琴:点标题行展开,里面塞着详情网格、活动列表、错误框,
 * 以及**停止按钮**。那个形态是「跑了一个钟头没人看出它卡死了」的一半原因:
 *
 * 1. **停止按钮藏在折叠里。** 想掐掉一个卡住的子代理,得先点开一张
 *    从外面完全看不出异常的卡片 —— 而会去点的人,首先得怀疑它有异常。
 * 2. **详情摊在对话流中间。** 一张展开的卡片能把转录顶掉半屏,于是没人愿意展开;
 *    可那几格(停在哪个阶段、距上次事件多久、工具数/错误数)恰恰是排查时唯一要看的。
 *
 * 现在整张卡片点一下,在**右侧工作区**开一个只读会话(复用主智能体那套渲染),
 * 详情搬进那边的身份栏;停止按钮提到标题行上 —— 不展开就能按。
 */
export function SubagentNode({
  summary,
  state,
  pending = false,
}: {
  summary: string | undefined;
  state?: SubagentState;
  /**
   * 子代理**还没派出去**:`Task` 的参数还在流,`subagent_start` 没到。
   *
   * 需求:那几秒里卡片就该长成子代理卡的样子(见 `thread-content.ts` 里那段),
   * 但状态得说实话。★ 不能靠「state 为空」判断 —— 旧转录里的子代理块同样没有 state,
   * 而它们早就跑完了,下面那行 `?? 'done'` 正是为它们写的。
   */
  pending?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const openSubagent = useOpenSubagent();
  const [now, setNow] = useState(() => Date.now());
  const running = state?.status === 'running';

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const status = pending && state === undefined ? 'pending' : state?.status ?? 'done';
  const errorText = state?.error === undefined ? undefined : agentErrorText(state.error, t);
  /*
    ★★ 「正在退避重试」以前**只画在主对话的状态行上**,而子代理不看状态行 ——
    于是限流退避在这张卡片上和「跑得慢」一模一样,几次退避全失败之后直接跳到
    错误框,看起来就像子代理根本没重试(它和主代理走的是同一份 `router.ts`)。

    ★ 卡片不再折叠,所以完整那句话直接挂在标题行下面,不必再分「短标签 + 展开后的横幅」
    两份 —— 短标签仍然留在状态那一格,因为标题行本身没有位置写一整句。
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
  const duration = state?.startedAt === undefined
    ? undefined
    : formatDuration(elapsedOf({ startedAt: state.startedAt, endedAt: state.endedAt }, now) ?? 0)
  const title = state?.description ?? summary ?? t("chat.subagent.default");
  /*
    ★★ 「汇报」这件事**只对后台子代理成立**。前台子代理的结果就是它那条
    `tool_result`,同步回到主代理,根本不存在「回传」这一步 —— 而这里以前的兜底是
    「没写 reportStatus 且不在跑 → reported」,前台在 `runtime.ts` 里恰恰从不写
    这个字段(只有 background 才写 'pending'),于是**每一张跑完的前台卡片**
    都挂着一句「结果已汇报给主代理」。那句话本该是后台专属的信号,
    结果人人都有,等于把两者的区别抹平了。
  */
  const background = state?.background === true;
  const reportStatus = !background
    ? 'none'
    : state?.reportStatus ?? (status === 'done' ? 'pending' : status === 'running' ? 'none' : 'reported');
  const reportLabel = reportStatus === 'pending'
    ? t('chat.subagent.report.pending')
    : reportStatus === 'injecting'
      ? t('chat.subagent.report.injecting')
      : reportStatus === 'reported'
        ? t('chat.subagent.report.reported')
        : reportStatus === 'blocked'
          ? t('chat.subagent.report.blocked')
        : undefined;
  const color = status === 'error' ? undefined : agentColorHex(state?.color);
  const stop = (): void => {
    if (state?.childRunId !== undefined) void abortRun(state.childRunId, true)
  }
  /*
    ★ 没有 `childSessionId` 的是**旧转录**(那个字段是随这次改动才加进
    `subagent_start` 的)。它们点开会是一个空面板,所以这里索性不让点 ——
    一张点了没反应的卡片比一张不能点的卡片难解释得多。
  */
  const canOpen = openSubagent !== undefined && state !== undefined && state.childSessionId !== undefined;

  return (
    <Surface
      tone={status === 'error' ? 'danger' : 'default'}
      rail={color === undefined && background ? 'accent' : undefined}
      style={color === undefined || status === 'error' ? undefined : {
        borderColor: `${color}66`,
        background: `color-mix(in srgb, ${color} 5%, var(--color-surface-raised))`,
        boxShadow: `inset 3px 0 0 ${color}`
      }}
      className="text-[12.5px] text-fg-muted"
      data-testid="subagent-node"
      data-subagent-call-id={state?.callId}
      data-subagent-status={status}
      data-subagent-background={state?.background === true ? 'true' : 'false'}
      data-subagent-color={state?.color}
    >
      {/* 停止按钮是标题行的**兄弟**,不是它的子节点 —— 按钮不能套按钮 */}
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          data-testid="subagent-open"
          disabled={!canOpen}
          title={canOpen ? t('chat.subagent.open') : undefined}
          onClick={() => { if (state !== undefined) openSubagent?.(state) }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
            canOpen && "hover:bg-tint-hover/40"
          )}
        >
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]",
              color === undefined && (status === 'error' ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent")
            )}
            style={color === undefined ? undefined : { color, backgroundColor: `${color}1f` }}
          >
            {status === 'error'
              ? <CircleAlert size={14} />
              : status === 'done'
                ? <CheckCircle2 size={14} />
                // 还没派出去和「后台排队中」是同一种「还没开始」,共用沙漏/时钟那个图标
                : background || status === 'pending'
                  ? <Clock3 size={14} />
                  : <Bot size={14} />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-fg">{title}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-fg-faint">
              {state?.subagentType !== undefined && (
                <span className="truncate" style={color === undefined ? undefined : { color }}>
                  {state.subagentType}
                </span>
              )}
              {background && (
                <span
                  className={cn("shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-medium", color === undefined && "bg-accent/10 text-accent")}
                  style={color === undefined ? undefined : { color, backgroundColor: `${color}1a` }}
                >
                  {t('chat.subagent.mode.background')}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span className={cn("text-[11px] font-medium",
              noticeLabel !== undefined ? "text-danger" : running ? "text-accent" : status === 'error' ? "text-danger" : "text-fg-faint")}
              style={color !== undefined && running && noticeLabel === undefined ? { color } : undefined}>
              {noticeLabel ?? t(`chat.subagent.status.${status}` as 'chat.subagent.status.running' | 'chat.subagent.status.done' | 'chat.subagent.status.error' | 'chat.subagent.status.aborted' | 'chat.subagent.status.pending')}
            </span>
            {duration !== undefined && <span className="font-mono text-[10.5px] text-fg-faint">{duration}</span>}
          </span>
        </button>
        {running && (
          <button
            type="button"
            data-testid="subagent-stop"
            onClick={stop}
            aria-label={t('chat.subagent.stop')}
            title={t('chat.subagent.stop')}
            className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-danger transition-colors hover:bg-danger/10"
          >
            <Square size={11} />
          </button>
        )}
      </div>
      {noticeDetail !== undefined && (
        <SurfaceRow
          data-testid="subagent-notice"
          className="selectable bg-danger/10 py-1.5 text-[11px] leading-relaxed text-danger"
        >
          {noticeDetail}
        </SurfaceRow>
      )}
      {!running && reportLabel !== undefined && (
        <SurfaceRow className={cn(reportStatus === 'pending' ? "text-accent" : "text-fg-muted")}>
          <ListChecks size={12} className="shrink-0" />
          <span>{reportLabel}</span>
        </SurfaceRow>
      )}
      {/*
        ★ 失败原因**留一行在卡片上**,完整的错误框在面板里。
        详情整体搬走的那一条对错误不成立:一张只写着「错误」的卡片,等于逼着
        用户为了看一句话去开一个面板 —— 而失败恰恰是最该一眼看见的那件事。
      */}
      {status === 'error' && (
        <SurfaceRow data-testid="subagent-error" className="bg-danger/10 py-1.5 text-danger">
          <span className="min-w-0 truncate">
            {errorText === undefined || errorText.trim() === ''
              ? t('chat.subagent.detail.errorUnknown')
              : errorText}
          </span>
        </SurfaceRow>
      )}
    </Surface>
  );
}

/**
 * 后台子代理的结果**回到主线的那一行**。
 *
 * ★★ 在此之前这条消息在界面上整条不存在(它是 `internal` 的,被
 * `threadRows` 的可见性过滤直接跳过)。于是主代理会毫无来由地开口,
 * 讲一件几百轮之前派出去的事 —— 而**看不见输入的输出,比看不见输出更难解释**。
 *
 * ★ 它默认收起,只占一行。这终究不是用户说的话,不该长得像一条提问:
 * 一屏后台任务全文摊开的话,主线索性读不下去了。
 */
export function SubagentReportRow({
  summary,
  state,
}: {
  summary: string | undefined;
  state?: SubagentState;
}): ReactNode {
  const { t } = useI18n();
  const openSubagent = useOpenSubagent();
  const [open, setOpen] = useState(false);
  const canOpen = openSubagent !== undefined && state?.childSessionId !== undefined;

  /*
    ★★ **`summary` 只有 240 字,而且是主进程切的。**

    `runtime.ts` 发 `subagent_end` 和落盘时都做了 `text.slice(0, 240)` ——
    那个字段生来是给卡片当一行预览的。后台这条路把它当成了汇报正文,于是
    一份「改了八个文件、逐条说明」的报告在这里断在半个标识符上
    (真实案例:`added \`ModelStatusC`)。前台子代理没有这个问题:它的结果是
    `toolOk(outcome.text)`,全文直接进 tool_result。

    所以展开时现去子会话取全文 —— 和右侧那个只读面板同一个数据源
    (`runtime.ts` 取的也正是「最后一条 assistant 消息的 visibleText」)。
    放在展开时而不是汇报时,是因为**历史消息也能因此补全**:已经写进库里的
    那些汇报,正文里存的就是那 240 字,汇报时再取已经晚了。

    读取期间先摆着摘要,不摆空白或转圈 —— 用户点开是想看内容,
    先给他能给的那部分,全文到了再原地换掉。
  */
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requested = useRef<string | undefined>(undefined);
  const childSessionId = state?.childSessionId;

  useEffect(() => {
    // 旧转录没有 `childSessionId` —— 取不到子会话,摘要就是全部了
    if (!open || childSessionId === undefined || requested.current === childSessionId) return;
    requested.current = childSessionId;
    let cancelled = false;
    setLoading(true);
    void getSession(childSessionId)
      .then((detail) => {
        if (cancelled) return;
        const last = [...detail.messages].reverse().find((m) => m.role === "assistant");
        const body = last === undefined ? "" : visibleText(last).trim();
        if (body === "") setFailed(true);
        else setFull(body);
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) });
    return () => { cancelled = true };
  }, [open, childSessionId]);

  const brief = summary?.trim() ?? "";
  const text = full ?? brief;
  /*
    ★ 取不到全文时要**说出来**。悄悄摆着摘要的话,用户看到的是一段
    断在半路的报告,而没有任何东西告诉他这不是全部 —— 他会以为子代理
    本来就只说了这些。

    判据是「试过了没成」或「压根没得试」,不是「此刻还没有全文」——
    后者在效果跑起来之前那一帧也成立,会闪一下假的提示。
  */
  const legacy = childSessionId === undefined;
  const truncated = full === null && brief !== "" && (failed || legacy);

  return (
    <Surface
      tone="accent"
      dashed
      data-testid="subagent-report-row"
      data-report-call-id={state?.callId}
      className="text-[12px] text-fg-muted"
    >
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          data-testid="subagent-report-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-tint-hover/40"
        >
          <ChevronRight size={13} className={cn("shrink-0 text-fg-faint transition-transform", open && "rotate-90")} />
          <ListChecks size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {state?.subagentType === undefined
              ? t("chat.subagent.report.rowGeneric")
              : t("chat.subagent.report.row", { agent: state.subagentType })}
          </span>
          {state?.description !== undefined && (
            <span className="max-w-[38%] shrink-0 truncate text-[11px] text-fg-faint">{state.description}</span>
          )}
        </button>
        {canOpen && (
          <button
            type="button"
            data-testid="subagent-report-open"
            onClick={() => { if (state !== undefined) openSubagent?.(state) }}
            title={t("chat.subagent.open")}
            className="mr-1.5 shrink-0 rounded-[5px] px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/10"
          >
            {t("chat.subagent.report.openRecord")}
          </button>
        )}
      </div>
      <SurfaceReveal open={open} className="selectable py-2.5">
        <div className="scroll-thin max-h-[min(40vh,320px)] overflow-y-auto pr-1">
          {/*
            ★ 只渲染子代理**自己那段正文**,不是注入给模型的那整段英文
            (它外面还包着一层 "Background subagent result (...) / Review this result..."
            的指令壳)。那层壳是写给模型的,给人看只会碍事。
          */}
          {text === ""
            ? <p className="text-[11.5px] text-fg-faint">
                {loading ? t("chat.subagent.report.loading") : t("chat.subagent.report.empty")}
              </p>
            : <AgentMarkdown content={text} variant="compact" />}
          {loading && text !== "" && (
            <p data-testid="subagent-report-loading" className="mt-2 text-[11px] text-fg-faint">
              {t("chat.subagent.report.loading")}
            </p>
          )}
          {truncated && (
            <p data-testid="subagent-report-truncated" className="mt-2 text-[11px] text-fg-faint">
              {legacy ? t("chat.subagent.report.partialLegacy") : t("chat.subagent.report.partialFailed")}
            </p>
          )}
        </div>
      </SurfaceReveal>
    </Surface>
  );
}
