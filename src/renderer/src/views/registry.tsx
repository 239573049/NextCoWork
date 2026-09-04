/**
 * 视图分发表。**不引 react-router**(方案 §8):Tab 化应用天然不是 URL 驱动,
 * 且生产环境 `file://` 下必须用 HashRouter,白白多一层。
 *
 * `doc` / `draw` / `browser` 本版只出空壳 —— 它们要验证的是「Tab 系统支持异构
 * kind」这件事,不是各自的领域模型(方案 §十)。
 */
import {
  FileText,
  Image as ImageIcon,
  PenTool,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  FeatureKind,
  InnerTab,
  InnerTabKind,
} from "../../../shared/domain/tab";
import type { Workspace } from "../../../shared/domain/workspace";
import { EmptyState } from "../components/ui/EmptyState";
import { FEATURE_ICON } from "../shell/icons";
import { ChatView } from "./chat/ChatView";
import { FilesTab } from "./files/FilesView";
import { TerminalView } from "./terminal/TerminalView";
import { BrowserView } from "./browser/BrowserView";
import { useI18n } from "../i18n";
import { BrowserFeature } from "./browser/BrowserFeature";

export interface InnerViewProps {
  tab: InnerTab;
  workspace: Workspace;
  /** 应用级默认模型;工作区没选过时兜底 */
  fallbackModel: string;
}

export function InnerView({
  tab,
  workspace,
  fallbackModel,
}: InnerViewProps): ReactNode {
  const { t } = useI18n();
  switch (tab.kind) {
    case "chat":
      return (
        <ChatView
          // ★ key 挂 sessionId 而不是 tab.id:同一个 Tab 换会话时必须重建
          // per-session store 的订阅,否则新会话会继续画上一个会话的转录。
          key={tab.ref.sessionId}
          sessionId={tab.ref.sessionId}
          workspace={workspace}
          fallbackModel={fallbackModel}
        />
      );
    case "terminal":
      return <TerminalView tab={tab} workspace={workspace} />;
    case "doc":
      return (
        <Placeholder
          icon={FileText}
          title={t("view.document")}
          step={t("view.shellOnly")}
        />
      );
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
      return (
        <Placeholder
          icon={ImageIcon}
          title={t("view.preview")}
          step={t("view.previewStep")}
        />
      );
    case "files":
      // key 挂子树根:换根等于换一棵树,展开状态和缓存都必须重来
      return <FilesTab key={tab.ref.path} tab={tab} workspace={workspace} />;
  }
}

/** 外层 feature Tab 的内容。设置**不走这里** —— 它是模态浮层,见 AppShell。 */
export function FeatureView({ feature }: { feature: FeatureKind }): ReactNode {
  const { t } = useI18n();
  if (feature === "browser") return <BrowserFeature />;
  const Icon = FEATURE_ICON[feature];
  const key = feature as "scheduled" | "skills" | "review" | "settings";
  return (
    <Placeholder
      icon={Icon}
      title={t(`view.feature.${key}` as "view.feature.scheduled" | "view.feature.skills" | "view.feature.review" | "view.feature.settings")}
      step={t(`view.feature.${key}Hint` as "view.feature.scheduledHint" | "view.feature.skillsHint" | "view.feature.reviewHint" | "view.feature.settingsHint")}
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
