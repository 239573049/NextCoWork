/**
 * 视图分发表。**不引 react-router**(方案 §8):Tab 化应用天然不是 URL 驱动,
 * 且生产环境 `file://` 下必须用 HashRouter,白白多一层。
 *
 * `doc` / `draw` / `browser` 本版只出空壳 —— 它们要验证的是「Tab 系统支持异构
 * kind」这件事,不是各自的领域模型(方案 §十)。
 *
 * ★ **这里同时是全应用唯一的拆包边界。** 主 bundle 一度 5.0MB,其中三坨重型依赖
 * 首屏一个都用不到,却全都静态躺在里面:
 *
 *     xterm(6.0M)         ← 只有 TerminalView 引
 *     streamdown + katex  ← 只经 views/chat/*(→ ChatView)和 MarkdownPreview(→ DocumentView)
 *     codemirror(916K)    ← CodeEditor,只被 DocumentView 和 ExtensionsFeature 下的
 *                            MarkdownResourceEditor 引
 *
 * 所以在这一层把这四个视图 `lazy` 掉,三条依赖链正好全被带走,而**那些组件自己
 * 一行都不用改** —— 不用给 `useRef<Terminal>` 想办法、不用管 `xterm.css` 那个副作用
 * import(Vite 会把动态 chunk 的 CSS 一起提出来、在 chunk 加载时注入)。
 *
 * ★ **别把 lazy 下放到组件自己那一层。** AgentMarkdown 有五个调用方,全在聊天热路径上
 * (Thread / parts / InteractionPanel),**每条消息都渲染一次**。在它那层 lazy 的话
 * 每条消息都要过一次 Suspense。放在这里,它跟着 ChatView 进同一个 chunk ——
 * ChatView 一加载它就在,消息渲染不经过任何 Suspense 边界。
 *
 * ★ **只看直接依赖会判断错。** ScheduledFeature 自己什么重型库都不引,但它
 * **静态 import 了 ChatView** —— 留成静态就等于把 streamdown + katex 原样拽回主 bundle,
 * 上面那个 lazy 白做(第一版就是这么翻的车:ChatView 已经 lazy 了,入口里
 * 还躺着 40 处 streamdown、54 处 katex,连 ChatView chunk 都没生成)。
 * 往这个表里添静态视图之前,先把它的传递依赖跟到底。
 *
 * ★ **FilesTab / BrowserView 保持静态**:它们确实不带重型依赖,拆了只多几次往返。
 * BrowserFeature 尤其不能动 —— AppShell 里还有一个绕过本文件的直接 import,
 * 在这里 lazy 它减不掉主 bundle 一个字节。
 */
import {
  PenTool,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import type {
  FeatureKind,
  InnerTab,
  InnerTabKind,
} from "../../../shared/domain/tab";
import { chatKey } from "../../../shared/domain/tab";
import type { Workspace } from "../../../shared/domain/workspace";
import { EmptyState } from "../components/ui/EmptyState";
import { FEATURE_ICON } from "../shell/icons";
import type { FallbackModel } from "./chat/Composer";
import { FilesTab } from "./files/FilesView";
import { BrowserView } from "./browser/BrowserView";
import { useI18n, type Translate } from "../i18n";
import { BrowserFeature } from "./browser/BrowserFeature";

// `.then(m => ({ default: ... }))` 是因为这几个都是具名导出,React.lazy 要的是默认导出。
const ChatView = lazy(() => import("./chat/ChatView").then((m) => ({ default: m.ChatView })));
const TerminalView = lazy(() => import("./terminal/TerminalView").then((m) => ({ default: m.TerminalView })));
const DocumentView = lazy(() => import("./files/DocumentView").then((m) => ({ default: m.DocumentView })));
const ExtensionsFeature = lazy(() => import("./extensions/ExtensionsFeature").then((m) => ({ default: m.ExtensionsFeature })));
// ★ 它自己很轻,lazy 是因为它**静态 import 了 ChatView**(见 ScheduledFeature.tsx)——
// 留成静态的话 ChatView 连同 streamdown + katex 会被它一路拽回主 bundle,
// 上面给 ChatView 做的 lazy 就白做了。
const ScheduledFeature = lazy(() => import("./scheduled/ScheduledFeature").then((m) => ({ default: m.ScheduledFeature })));

/**
 * chunk 还在路上时占位。**和面板同色的空块,不要 spinner** ——
 * 切 Tab 本来就是内容替换,转个圈反而把「瞬间完成」渲染成「正在等待」。
 * 命中预热(见 AppShell 的 idle 预取)时它一帧都不会出现。
 */
const VIEW_FALLBACK = <div className="flex min-h-0 flex-1 bg-canvas" />;

export interface InnerViewProps {
  tab: InnerTab;
  workspace: Workspace;
  /** 应用级默认模型;工作区没选过时兜底 */
  fallbackModel: FallbackModel;
}

export function InnerView(props: InnerViewProps): ReactNode {
  // Suspense 放在本文件内部,`InnerView` 的两个调用方(shell/Panels、shell/Dock)
  // 因此什么都不用改。
  // `t` 在这里取、往下传:renderInner 不是组件,在它里面调 Hook 过不了 lint。
  const { t } = useI18n();
  return <Suspense fallback={VIEW_FALLBACK}>{renderInner(props, t)}</Suspense>;
}

function renderInner(
  { tab, workspace, fallbackModel }: InnerViewProps,
  t: Translate,
): ReactNode {
  switch (tab.kind) {
    case "chat":
      return (
        <ChatView
          // ★ key 挂 chatKey 而不是 tab.id:同一个 Tab 换会话时必须重建
          // per-session store 的订阅,否则新会话会继续画上一个会话的转录。
          // 草稿期 chatKey 是 tabId,绑定 sessionId 的那一刻它变一次 —— 那次
          // 重挂是**故意**的,同一个理由:store 换了,订阅必须跟着换。
          key={chatKey(tab)}
          sessionId={tab.ref.sessionId}
          tabId={tab.id}
          workspace={workspace}
          fallbackModel={fallbackModel}
          readOnly={tab.ref.readOnly === true}
          subagentOf={tab.ref.subagentOf}
        />
      );
    case "terminal":
      return <TerminalView tab={tab} workspace={workspace} />;
    case "doc":
      return <DocumentView key={`${workspace.id}:${tab.ref.path}`} workspaceId={workspace.id} path={tab.ref.path} />;
    case "draw":
      return (
        <Placeholder
          icon={PenTool}
          title={t("view.draw")}
          step={t("view.shellOnly")}
        />
      );
    case "browser":
      return <BrowserView tab={tab} workspace={workspace} />;
    case "preview":
      return <DocumentView key={`${workspace.id}:${tab.ref.path}`} workspaceId={workspace.id} path={tab.ref.path} />;
    case "files":
      // key 挂子树根:换根等于换一棵树,展开状态和缓存都必须重来
      return <FilesTab key={tab.ref.path} tab={tab} workspace={workspace} />;
  }
}

/** 外层 feature Tab 的内容。设置**不走这里** —— 它是模态浮层,见 AppShell。 */
export function FeatureView({ feature, onClose }: { feature: FeatureKind; onClose?: () => void }): ReactNode {
  const { t } = useI18n();
  if (feature === "browser") return <BrowserFeature />;
  // 唯一一个 lazy 的 feature —— 它下面的 MarkdownResourceEditor 拖着整个 codemirror
  if (feature === "extensions") return <Suspense fallback={VIEW_FALLBACK}><ExtensionsFeature onClose={onClose} /></Suspense>;
  if (feature === "scheduled") return <Suspense fallback={VIEW_FALLBACK}><ScheduledFeature onClose={onClose} /></Suspense>;
  const Icon = FEATURE_ICON[feature];
  const key = feature as "scheduled" | "review" | "settings";
  return (
    <Placeholder
      icon={Icon}
      title={t(`view.feature.${key}` as "view.feature.scheduled" | "view.feature.review" | "view.feature.settings")}
      step={t(`view.feature.${key}Hint` as "view.feature.scheduledHint" | "view.feature.reviewHint" | "view.feature.settingsHint")}
    />
  );
}

function Placeholder({
  icon: Icon,
  title,
  step,
}: {
  icon: LucideIcon;
  title: string;
  step: string;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState icon={<Icon size={26} />} title={title} hint={step} />
    </div>
  );
}

/** 只用于类型层面确认每种 kind 都有落点(加一种 kind 忘了写视图,这里编译期就挂)。 */
export const INNER_VIEW_KINDS: Record<InnerTabKind, true> = {
  chat: true,
  terminal: true,
  doc: true,
  draw: true,
  browser: true,
  preview: true,
  files: true,
};
