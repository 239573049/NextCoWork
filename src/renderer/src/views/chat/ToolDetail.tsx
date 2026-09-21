/**
 * 展开后的详情区 —— 按形态类分派的渲染器表。
 *
 * ★ **这里是 G2(零差异化)真正被解决的地方。** 现状是所有工具的入参和结果
 * 一律 `JSON.stringify` 塞进 `<pre>`,于是一次 `Write` 会把整个文件内容
 * 当作 JSON 字符串转义后显示出来 —— 换行变成 `\n`,几千字符挤成一坨,
 * 而那恰恰是用户最想看清楚的东西。
 *
 * ★ **`external` 分支保留了现状的 JSON 行为**,而且必须保留:MCP 工具的入参形状
 * 编译期不可知,任何「智能」猜测都会在某个 server 上猜错。通用 JSON 是唯一
 * 对未知输入永远正确的呈现。
 */
import type { ReactNode } from "react";
import type { ToolOutput } from "../../../../shared/agent/message";
import type { ToolShape } from "../../../../shared/domain/tool-presenter";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/cn";
import { DiffBlock } from "./DiffView";
import { CardRenderer } from "./CardRenderer";
import { InteractionPreviewBlock } from "./InteractionPreviewBlock";
import { TaskChecklist } from "./TaskChecklist";
import { WidgetDetail } from "./WidgetDetail";
import { previewTodos } from "./todo-preview";

// ─────────────────────────── 原语 ───────────────────────────

/** 详情区里的一个带标签的块。样式沿用改造前 `parts.tsx` 的 Labeled,不新增 token。 */
export function Labeled({
  label,
  children,
  tone = "normal",
}: {
  label: string;
  children: ReactNode;
  tone?: "normal" | "danger";
}): ReactNode {
  return (
    <div className="mt-1.5 first:mt-0">
      <p
        className={cn(
          "mb-0.5 text-[11px]",
          tone === "danger" ? "text-danger" : "text-fg-faint",
        )}
      >
        {label}
      </p>
      <pre
        className={cn(
          "selectable scroll-thin max-h-56 overflow-auto rounded-[7px] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
          tone === "danger"
            ? "bg-danger/5 text-danger"
            : "bg-canvas text-fg-muted",
        )}
      >
        {children}
      </pre>
    </div>
  );
}

/** 未知形状的入参/结果:退回通用 JSON 呈现(对任何 MCP 工具都永远正确)。 */
export function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    // 循环引用 / BigInt / Symbol 都会走到这里。详情区显示一行退化文本,
    // 好过让整个转录因为一次序列化异常白屏。
    return String(v);
  }
}

/** 安全取字段(与 tool-presenter 的 pick 同构,但这里允许返回非字符串) */
function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

function str(input: unknown, key: string): string {
  const v = field(input, key);
  return typeof v === "string" ? v : "";
}

/**
 * 超长文本按行截断,并注明省略了多少。
 *
 * 不用 CSS `max-height` 截断的原因:那样滚动条里仍然挂着几万行 DOM 文本,
 * 而这个组件在一次 run 里可能存在几十份。行数截断是把它挡在渲染之前。
 */
function clipLines(
  text: string,
  max: number,
): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, omitted: 0 };
  return { text: lines.slice(0, max).join("\n"), omitted: lines.length - max };
}

function Truncated({ omitted }: { omitted: number }): ReactNode {
  const { t } = useI18n();
  if (omitted <= 0) return null;
  return (
    <span className="text-fg-faint">
      {t("chat.tool.linesOmitted", { count: omitted })}
    </span>
  );
}

/** 结果块 —— 八个渲染器里有七个都要用,所以抽出来。`WidgetDetail` 用的是它。 */
export function OutputBlock({
  output,
  label,
  isError = false,
  maxLines = 40,
}: {
  output: ToolOutput | undefined;
  label?: string;
  isError?: boolean;
  maxLines?: number;
}): ReactNode {
  const { t } = useI18n();
  if (output === undefined) return null;
  const effectiveLabel = label ?? t("chat.tool.result");
  const { text, omitted } = clipLines(output.content, maxLines);
  return (
    <Labeled
      label={isError ? t("chat.tool.failureReason") : effectiveLabel}
      tone={isError ? "danger" : "normal"}
    >
      {text}
      <Truncated omitted={omitted} />
      {output.truncated === true && (
        <span className="text-fg-faint">
          {t("chat.tool.truncated", { bytes: output.originalBytes ?? "?" })}
        </span>
      )}
      {(output.images ?? []).map((image, index) => (
        <img
          key={`${image.dataRef.slice(0, 48)}:${index}`}
          src={image.dataRef}
          alt={t("chat.tool.result")}
          className="mt-2 max-h-96 max-w-full rounded-lg border border-hairline object-contain"
        />
      ))}
    </Labeled>
  );
}

// ─────────────────────────── 各形态渲染器 ───────────────────────────

export interface DetailProps {
  input: unknown;
  output: ToolOutput | undefined;
  isError: boolean;
  /**
   * 转录里的工具名(externalName)。
   *
   * 需求:`interaction` 这一档的三个工具**入参形状各不相同**(题目数组 / 一句条件 /
   * 空对象),而形态类只分到「这是一次等你表态」为止。再往下分到具体工具的那一步
   * 由 `interaction-preview.ts` 的表完成,所以这里必须把名字传下去。
   * 其余渲染器用不到它 —— 别拿它在别处开按工具名分叉的口子,那正是注册表要消掉的东西。
   */
  toolName?: string;
}

/** read:路径单独一行,输出当代码预览(Read 的输出本身已带 `cat -n` 行号) */
function ReadDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const path = str(input, "file_path") || str(input, "path");
  return (
    <>
      {path !== "" && <PathLine path={path} />}
      <OutputBlock
        output={output}
        isError={isError}
        label={t("chat.tool.content")}
        maxLines={40}
      />
    </>
  );
}

/**
 * mutate:**入参里的 `content` / `new_string` 才是重点**,而它们正是现状
 * JSON 化之后最不可读的部分。这里单独拎出来按原文渲染(保留换行)。
 *
 * ★ **新文本一律走 `DiffBlock`,参数还在流的时候也一样。** 判据原先是
 * 「old 和 new 都到齐」,于是一次 Edit 在流式阶段先显示成两块纯文本,
 * `new_string` 收尾的那一刻整块换成 diff —— 同一件事两套画法,而切换恰好发生在
 * 用户正盯着看的时刻。只有新文本时(Write 的 `content`、或 new 先到)就是一份
 * 「全是新增」的 diff,与改动审查里新建文件的画法一致。
 */
function MutateDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const path = str(input, "file_path");
  const content = str(input, "content");
  const oldStr = str(input, "old_string");
  const newStr = str(input, "new_string");

  return (
    <>
      {path !== "" && <PathLine path={path} />}
      {newStr !== "" && (
        <DiffBlock oldStr={oldStr} newStr={newStr} label={t("chat.tool.change")} />
      )}
      {/* new 还没开始流:此刻只有「要被换掉的那一段」,没有第二侧可对照 */}
      {newStr === "" && oldStr !== "" && (
        <Labeled label={t("chat.tool.before")}>
          {clipLines(oldStr, 12).text}
          <Truncated omitted={clipLines(oldStr, 12).omitted} />
        </Labeled>
      )}
      {content !== "" && (
        <DiffBlock oldStr="" newStr={content} label={t("chat.tool.writeContent")} />
      )}
      <OutputBlock output={output} isError={isError} maxLines={12} />
    </>
  );
}

/** search:模式 + 命中列表。命中多时只显示前 40 行,余量注明。 */
function SearchDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const pattern = str(input, "pattern");
  const scope = str(input, "path") || str(input, "glob");
  return (
    <>
      {pattern !== "" && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-faint">
          <span className="rounded-[5px] bg-canvas px-1.5 py-0.5 font-mono text-fg-muted">
            {pattern}
          </span>
          {scope !== "" && (
            <span className="truncate">
              {t("chat.tool.query")} {scope}
            </span>
          )}
        </div>
      )}
      <OutputBlock
        output={output}
        isError={isError}
        label={t("chat.tool.match")}
        maxLines={40}
      />
    </>
  );
}

/** command:命令原文 + 终端样式输出 */
function CommandDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const command = str(input, "command");
  return (
    <>
      {command !== "" && (
        <Labeled label={t("chat.tool.command")}>
          <span className="text-accent-soft">$ </span>
          {command}
        </Labeled>
      )}
      <OutputBlock
        output={output}
        isError={isError}
        label={t("chat.tool.output")}
        maxLines={60}
      />
    </>
  );
}

/** network:URL 可点开性留给将来,先保证它完整可见且不撑破布局 */
function NetworkDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const url = str(input, "url");
  const query = str(input, "query");
  const prompt = str(input, "prompt");
  return (
    <>
      {url !== "" && <PathLine path={url} />}
      {query !== "" && (
        <div className="mb-1.5 text-[11.5px] text-fg-muted">
          <span className="text-fg-faint">{t("chat.tool.query")}</span> {query}
        </div>
      )}
      {prompt !== "" && (
        <Labeled label={t("chat.tool.prompt")}>
          {clipLines(prompt, 6).text}
        </Labeled>
      )}
      <OutputBlock
        output={output}
        isError={isError}
        label={t("chat.tool.response")}
        maxLines={40}
      />
    </>
  );
}

/**
 * orchestration:TodoWrite 的 `todos` 是**结构化数据**,渲染成清单比 JSON
 * 有用得多 —— 这是用户在整个转录里唯一会反复回看的一份状态。
 *
 * ★ **清单本体就是输入框上方那张 `TaskChecklist`,不是另画的一份。**
 * 这里原本有一套自绘的 ○▸✓ 列表,于是同一份 todos 在同一屏里有两种长相
 * (卡片里是带删除线的文本行,输入框上方是带进度环和 Spinner 的清单),
 * 改一处必漏一处。半截入参的收窄规则在 `todo-preview.ts`。
 * 外层定位由 `className` 抹掉 —— 那套居中/限宽是输入框上方那个位置的需求。
 */
function OrchestrationDetail({
  input,
  output,
  isError,
}: DetailProps): ReactNode {
  const { t } = useI18n();
  const todos = previewTodos(input);
  if (todos.length > 0) {
    return (
      <>
        <TaskChecklist todos={todos} className="max-w-none px-0 pb-1.5" />
        <OutputBlock output={output} isError={isError} maxLines={6} />
      </>
    );
  }

  // Task / Skill:提示词往往很长,截断显示
  const prompt = str(input, "prompt");
  const name = str(input, "name") || str(input, "subagent_type");
  return (
    <>
      {name !== "" && (
        <div className="mb-1.5 text-[11.5px] text-fg-muted">
          <span className="text-fg-faint">{t("chat.tool.name")}</span> {name}
        </div>
      )}
      {prompt !== "" && (
        <Labeled label={t("chat.tool.task")}>
          {clipLines(prompt, 10).text}
          <Truncated omitted={clipLines(prompt, 10).omitted} />
        </Labeled>
      )}
      <OutputBlock output={output} isError={isError} maxLines={30} />
    </>
  );
}

/** reasoning:纯文本流,不加等宽字体 —— 它是自然语言,不是代码 */
function ReasoningDetail({ output }: DetailProps): ReactNode {
  if (output === undefined) return null;
  return (
    <p className="selectable text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-faint">
      {output.content}
    </p>
  );
}

/**
 * interaction:入参**就是给人读的题面**,所以整块按题面渲染,而且在参数还在流的
 * 时候就渲染 —— 见 `InteractionPreviewBlock` 与 `interaction-preview.ts`。
 *
 * 结果块照样保留:答完之后那段 JSON 是「用户当时选了什么」的唯一记录,
 * 而历史转录里那张可作答的卡片早就不在了。
 */
function InteractionDetail({
  input,
  output,
  isError,
  toolName,
}: DetailProps): ReactNode {
  return (
    <>
      <InteractionPreviewBlock
        toolName={toolName}
        input={input}
        live={output === undefined}
      />
      <OutputBlock output={output} isError={isError} maxLines={20} />
    </>
  );
}

/** external:兜底 —— 通用 JSON。这正是改造前所有工具的行为。 */
function ExternalDetail({ input, output, isError }: DetailProps): ReactNode {
  const { t } = useI18n();
  const raw = stringify(input);
  const { text, omitted } = clipLines(raw, 30);
  return (
    <>
      <Labeled label={t("chat.tool.input")}>
        {text}
        <Truncated omitted={omitted} />
      </Labeled>
      <OutputBlock output={output} isError={isError} maxLines={40} />
    </>
  );
}

function PathLine({ path }: { path: string }): ReactNode {
  return (
    <p
      className="mb-1.5 truncate font-mono text-[11px] text-fg-faint"
      title={path}
      dir="rtl"
    >
      {/* dir=rtl 让超长路径从**头部**省略 —— 尾部的文件名才是有用的那一半 */}
      <span dir="ltr">{path}</span>
    </p>
  );
}

/**
 * 形态类 → 详情渲染器。
 *
 * `Record<ToolShape, …>` 而不是 `Partial<…>`:少写一个形态类会**编译期**报错,
 * 而不是运行时渲染出一片空白。
 */
export const DETAIL_RENDERERS: Record<
  ToolShape,
  (p: DetailProps) => ReactNode
> = {
  reasoning: ReasoningDetail,
  read: ReadDetail,
  mutate: MutateDetail,
  search: SearchDetail,
  command: CommandDetail,
  network: NetworkDetail,
  orchestration: OrchestrationDetail,
  interaction: InteractionDetail,
  /*
    widget:生成期由它渲染半截 HTML;跑完之后 `ToolDetail` 会先被 `card` 那条
    短路接走(`if (card !== undefined)`),走 `CardRenderer` 的 widget 分支。
    两个分支共用同一个 `WidgetFrame` —— 见 `WidgetDetail.tsx` 的文件头。
  */
  widget: WidgetDetail,
  external: ExternalDetail,
};

export function ToolDetail({
  shape,
  input,
  output,
  isError,
  toolName,
  callId,
  card,
}: {
  shape: ToolShape;
  /*
    `toolName` 原先只为 frame 卡片反查 pluginId 而存在,现在同时被 `interaction`
    渲染器用来分派题面投影 —— 所以它移进了 `DetailProps`(见那里的注释),
    不再在这里单独声明。
  */
  callId?: string;
  /**
   * 要渲染的卡片。调用方决定优先级:结果快照(`output.card`)或运行中的实时卡片
   * (`ToolCallState.card`,第 2 层)。给了它就渲染卡片,**与 shape 正交**。
   */
  card?: import("../../../../shared/agent/tool-card").ToolCard;
} & DetailProps): ReactNode {
  // ★ card 是 UI 轨专属,编码器早已 strip,模型看不到它。
  if (card !== undefined) {
    return <CardRenderer card={card} toolName={toolName} callId={callId} />;
  }
  const Renderer = DETAIL_RENDERERS[shape];
  return (
    <Renderer
      input={input}
      output={output}
      isError={isError}
      toolName={toolName}
    />
  );
}
