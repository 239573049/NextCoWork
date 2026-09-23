/**
 * 账号列表里的一行:名字 + 状态徽章 + 四个操作 + (Codex 的)两条额度条。
 *
 * ## 为了什么需求建的
 *
 * 一家 OAuth 供应商下面挂着多个登录身份,用户要看得到「哪个在用、哪个被限流了、
 * 还有多久恢复、额度还剩多少」,并且能手动排序 / 停用 / 解除限流 / 设为当前。
 *
 * ## 它拥有哪条不变式
 *
 * **一切判断都来自纯函数**(`provider-accounts.ts` 与 `shared/domain/provider-account.ts`),
 * 这里只负责把它们画出来。在这个文件里写 `account.limit.until > Date.now()` 之类的
 * 判断,就会出现「主进程说可用、界面说限流中」——而两边都没报错。
 *
 * ## 故意不做什么
 *
 * - **不自己起定时器**。倒计时的 `now` 由父组件那一个 tick 喂进来(见 `ProviderAccounts`):
 *   每行一个 `setInterval`,三个账号就是三个,而且它们不同步、互相错开半秒。
 * - **不画后端接不住的控件**(§5):没有限流就没有「立即解除」按钮。
 */
import { useState, type ReactNode } from "react";
import { Check, LogIn, Star, Trash2, GripVertical } from "lucide-react";
import type { ProviderAccount } from "../../../../../shared/domain/provider-account";
import { accountDisplay } from "../../../../../shared/domain/provider-account";
import { Button } from "../../../components/ui/Button";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { TextInput } from "../../../components/ui/TextInput";
import { Toggle } from "../../../components/ui/Toggle";
import { useI18n } from "../../../i18n";
import { cn } from "../../../lib/cn";
import {
  accountBadge,
  countdownTo,
  isQuotaStale,
  quotaBar,
  type AccountBadge,
  type QuotaBar,
} from "./provider-accounts";

/** 徽章的颜色档。★ 四态各一个,不共用 —— 共用会让「已停用」和「限流中」看起来是同一件事 */
const BADGE_CLASS: Readonly<Record<AccountBadge, string>> = {
  ready: "text-accent",
  limited: "text-warning",
  "needs-reauth": "text-danger",
  disabled: "text-fg-faint",
};

const BADGE_KEY: Readonly<Record<AccountBadge, string>> = {
  ready: "providerAccount.badge.ready",
  limited: "providerAccount.badge.limited",
  "needs-reauth": "providerAccount.badge.needsReauth",
  disabled: "providerAccount.badge.disabled",
};

export function AccountRow({
  account,
  now,
  isActive,
  busy,
  onSetCurrent,
  onToggleEnabled,
  onRemove,
  onReauth,
  onClearLimit,
  onRename,
  onMove,
}: {
  account: ProviderAccount;
  /** 由父组件的单一 tick 喂进来 —— 每行自己起定时器会让它们互相错开半秒 */
  now: number;
  /** 「下一次请求会用它」。★ 和 `account.current` 是两件事,见 selectAccount 的注释 */
  isActive: boolean;
  busy: boolean;
  onSetCurrent: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  onReauth: () => void;
  onClearLimit: () => void;
  onRename: (label: string) => void;
  /** 键盘路径:鼠标能拖的,键盘也要能移(§8「要么都通,要么都不画」) */
  onMove: (delta: -1 | 1) => void;
}): ReactNode {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const badge = accountBadge(account, now);
  const display = accountDisplay(account);
  const name = display.kind === "unknown" ? t("providerAccount.unnamed") : display.text;
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });

  const countdown = account.limit === undefined ? null : countdownTo(account.limit.until, now);
  const countdownText =
    countdown === null
      ? null
      : countdown.hours > 0
        ? t("providerAccount.countdownHours", { hours: countdown.hours, minutes: countdown.minutes })
        : countdown.minutes > 0
          ? t("providerAccount.countdownMinutes", {
              minutes: countdown.minutes,
              seconds: countdown.seconds,
            })
          : t("providerAccount.countdownSeconds", { seconds: countdown.seconds });

  const commitRename = (): void => {
    setRenaming(false);
    onRename(draft);
  };

  return (
    <li
      className={cn(
        "rounded-[12px] border border-border bg-surface-field px-2.5 py-2",
        // ★ 停用的那行整体压暗,但**不隐藏** —— 用户要找得到它才能再打开
        !account.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        {/* 拖拽把手。键盘路径走下面那两颗上下移按钮,两条路都通(§8) */}
        <span className="shrink-0 cursor-grab text-fg-faint" aria-hidden>
          <GripVertical size={14} />
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <TextInput
              value={draft}
              onChange={setDraft}
              onCommit={commitRename}
              ariaLabel={t("providerAccount.rename")}
              placeholder={t("providerAccount.renamePlaceholder")}
              disabled={busy}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] text-fg">{name}</span>
              {account.current && (
                <span
                  title={t("providerAccount.currentHint")}
                  className="shrink-0 rounded-pill bg-accent/10 px-1.5 py-px text-[10.5px] text-accent"
                >
                  {t("providerAccount.current")}
                </span>
              )}
              {isActive && !account.current && (
                <span className="shrink-0 text-[10.5px] text-fg-faint">
                  {t("providerAccount.active")}
                </span>
              )}
            </div>
          )}
          <p className={cn("mt-0.5 flex items-center gap-1 text-[11.5px]", BADGE_CLASS[badge])}>
            <span>{t(BADGE_KEY[badge])}</span>
            {badge === "limited" && countdownText !== null && (
              <>
                <span aria-hidden>·</span>
                <span>{countdownText}</span>
                {account.limit !== undefined && (
                  <span className="text-fg-faint">
                    {t("providerAccount.limitedUntil", {
                      time: timeFormat.format(new Date(account.limit.until)),
                    })}
                  </span>
                )}
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* ★ 只在限流时出现:画一个永远灰着的按钮是一次会失败的承诺(§5) */}
          {badge === "limited" && (
            <Button size="sm" disabled={busy} onClick={onClearLimit}>
              {t("providerAccount.clearLimit")}
            </Button>
          )}
          {badge === "needs-reauth" && (
            <Button size="sm" variant="accent" icon={<LogIn size={12} />} disabled={busy} onClick={onReauth}>
              {t("providerAccount.reauth")}
            </Button>
          )}
          {!account.current && (
            <button
              type="button"
              title={t("providerAccount.setCurrent")}
              aria-label={t("providerAccount.setCurrent")}
              disabled={busy}
              onClick={onSetCurrent}
              className="flex size-7 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-tint-strong hover:text-fg disabled:opacity-40 motion-reduce:transition-none"
            >
              <Star size={13} aria-hidden />
            </button>
          )}
          <Toggle
            checked={account.enabled}
            disabled={busy}
            onChange={onToggleEnabled}
            label={account.enabled ? t("providerAccount.disable") : t("providerAccount.enable")}
          />
          <button
            type="button"
            title={t("providerAccount.rename")}
            aria-label={t("providerAccount.rename")}
            disabled={busy}
            onClick={() => {
              setDraft(account.label ?? "");
              setRenaming((v) => !v);
            }}
            className="flex size-7 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-tint-strong hover:text-fg disabled:opacity-40 motion-reduce:transition-none"
          >
            <Check size={13} aria-hidden className={cn(!renaming && "hidden")} />
            <span className={cn("text-[11px]", renaming && "hidden")} aria-hidden>
              Aa
            </span>
          </button>
          <button
            type="button"
            title={t("providerAccount.remove")}
            aria-label={t("providerAccount.remove")}
            disabled={busy}
            onClick={onRemove}
            className="flex size-7 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40 motion-reduce:transition-none"
          >
            <Trash2 size={13} aria-hidden />
          </button>
          {/* 键盘可达的排序路径 —— 拖拽之外的那一半(§8) */}
          <div className="flex flex-col">
            <button
              type="button"
              aria-label={t("providerAccount.moveUp")}
              disabled={busy}
              onClick={() => onMove(-1)}
              className="px-1 text-[9px] leading-[1.1] text-fg-faint hover:text-fg disabled:opacity-40"
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={t("providerAccount.moveDown")}
              disabled={busy}
              onClick={() => onMove(1)}
              className="px-1 text-[9px] leading-[1.1] text-fg-faint hover:text-fg disabled:opacity-40"
            >
              ▼
            </button>
          </div>
        </div>
      </div>

      <AccountQuota account={account} now={now} />
    </li>
  );
}

/**
 * Codex 的两条额度条。
 *
 * ★ 其余 issuer 的 `quota` 恒为 undefined(主进程只给 ChatGPT 解析),
 * 所以这里不需要按 issuer 判断 —— 少一处会和主进程分叉的地方。
 */
function AccountQuota({ account, now }: { account: ProviderAccount; now: number }): ReactNode {
  const { t, locale } = useI18n();
  if (account.issuer !== "chatgpt") return null;

  const quota = account.quota;
  if (quota === undefined) {
    return (
      <p className="mt-1.5 pl-6 text-[11px] text-fg-faint">{t("providerAccount.quota.empty")}</p>
    );
  }

  const bars = [quotaBar(quota.primary), quotaBar(quota.secondary)].filter(
    (bar): bar is QuotaBar => bar !== null,
  );
  if (bars.length === 0) {
    return (
      <p className="mt-1.5 pl-6 text-[11px] text-fg-faint">{t("providerAccount.quota.empty")}</p>
    );
  }

  const timeFormat = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const staleHours = Math.floor((now - quota.capturedAt) / 3600_000);

  return (
    <div className="mt-1.5 space-y-1 pl-6">
      {bars.map((bar) => (
        <div key={bar.windowMinutes} className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[10.5px] text-fg-faint">
            {bar.window === "other"
              ? t("providerAccount.quota.other", { minutes: bar.windowMinutes })
              : t(`providerAccount.quota.${bar.window}`)}
          </span>
          <ProgressBar
            value={bar.percent / 100}
            label={t("providerAccount.quota.used", { percent: bar.percent })}
            className={cn("flex-1", bar.critical && "[&>span]:bg-warning")}
          />
          <span className={cn("w-10 shrink-0 text-right text-[10.5px]", bar.critical ? "text-warning" : "text-fg-muted")}>
            {bar.percent}%
          </span>
          <span className="w-24 shrink-0 text-right text-[10.5px] text-fg-faint">
            {t("providerAccount.quota.resetsAt", { time: timeFormat.format(new Date(bar.resetsAt)) })}
          </span>
        </div>
      ))}
      {/* ★ 数据只在发消息时搭便车更新,久不用的账号要说清楚「这是旧数据」 */}
      {isQuotaStale(quota.capturedAt, now) && (
        <p className="text-[10.5px] text-fg-faint">
          {t("providerAccount.quota.stale", { hours: staleHours })}
        </p>
      )}
    </div>
  );
}
