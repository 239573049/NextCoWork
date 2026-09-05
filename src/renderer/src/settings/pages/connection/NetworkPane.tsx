/**
 * 网络(代理)—— 参考图的「网络」页,而且**这一页是真生效的**。
 *
 * 改这里的任何一个字段都会走 `settings:update` → `main/ipc/settings.ts` 察觉
 * `patch.proxy` → `applyProxy()` → `session.defaultSession.setProxy()`,
 * 于是模型请求、MCP 的 http/sse、六个搜索适配器一起改道(它们都过
 * `KernelHost.fetch`,而那是 Chromium 的 `net.fetch`)。
 *
 * ★ **密码不在 `settings` 里**,单独走 `proxy:*` 三条频道进 safeStorage。
 * 它因此是这一页唯一有本地状态的东西 —— 其余字段一律从 prop 读(见 `props.ts`)。
 */
import { Check, Eye, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProxyScheme } from "../../../../../shared/domain/proxy";
import {
  DIRECT_BYPASS,
  PROXY_SCHEMES,
} from "../../../../../shared/domain/proxy";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { Toggle } from "../../../components/ui/Toggle";
import { useI18n } from "../../../i18n";
import { cn } from "../../../lib/cn";
import {
  clearProxyPassword,
  getProxyPasswordInfo,
  setProxyPassword,
} from "../../../services/proxy";
import { SettingField, SettingGroup, SettingRow } from "../../Row";
import type { SettingsPageProps } from "../../props";
import {
  bypassSummary,
  parsePortInput,
  splitPastedAddress,
  validateProxyForm,
} from "../../validate";

const SCHEME_OPTIONS = PROXY_SCHEMES.map((s) => ({ value: s, label: s }));

export function NetworkPane({ settings, patch }: SettingsPageProps): ReactNode {
  const { t } = useI18n();
  const p = settings.proxy;
  const manual = p.enabled && p.mode === "manual";
  const errors = validateProxyForm(p);
  const summary = bypassSummary(p.bypass);
  const [showBuiltin, setShowBuiltin] = useState(false);

  return (
    <SettingGroup>
      <SettingRow
        title={t("connection.network.enable")}
        description={t("connection.network.enableHint")}
      >
        <Toggle
          label={t("connection.network.enable")}
          checked={p.enabled}
          onChange={(enabled) => patch({ proxy: { enabled } })}
        />
      </SettingRow>

      <SettingRow
        title={t("connection.network.mode")}
        description={t("connection.network.modeHint")}
        wide
      >
        <Segmented
          label={t("connection.network.mode")}
          value={p.mode}
          options={[
            { value: "system", label: t("connection.network.followSystem") },
            { value: "manual", label: t("connection.network.manual") },
          ]}
          onChange={(mode) => patch({ proxy: { mode } })}
          className={cn(!p.enabled && "pointer-events-none opacity-40")}
        />
      </SettingRow>

      <SettingField
        title={t("connection.network.server")}
        description={<>{t("connection.network.addressHint")}</>}
      >
        <div className="flex items-center gap-2">
          <Segmented
            label={t("connection.network.protocol")}
            size="sm"
            value={p.scheme}
            options={SCHEME_OPTIONS}
            onChange={(scheme: ProxyScheme) => patch({ proxy: { scheme } })}
            className={cn(!manual && "pointer-events-none opacity-40")}
          />
          <div className="min-w-0 flex-1">
            <HostInput
              value={p.host}
              disabled={!manual}
              invalid={errors.host !== undefined}
              onCommit={(host) => patch({ proxy: { host } })}
              onPasteFull={(ep) => patch({ proxy: ep })}
            />
          </div>
          <div className="w-[88px] shrink-0">
            <PortInput
              value={p.port}
              disabled={!manual}
              invalid={errors.port !== undefined}
              onCommit={(port) => patch({ proxy: { port } })}
            />
          </div>
        </div>
        {(errors.host ?? errors.port) !== undefined && (
          <p className="mt-2 text-[12px] text-danger">
            {errors.host ?? errors.port}
          </p>
        )}
      </SettingField>

      <SettingRow
        title={t("connection.network.auth")}
        description={t("connection.network.authHint")}
      >
        <Toggle
          label={t("connection.network.auth")}
          checked={p.authEnabled}
          disabled={!manual}
          onChange={(authEnabled) => patch({ proxy: { authEnabled } })}
        />
      </SettingRow>

      {p.authEnabled && (
        <SettingField title={t("connection.network.credentials")}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <DraftInput
                value={p.authUser}
                disabled={!manual}
                invalid={errors.authUser !== undefined}
                ariaLabel={t("connection.network.username")}
                placeholder={t("connection.network.username")}
                onCommit={(authUser) => patch({ proxy: { authUser } })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <ProxyPasswordField disabled={!manual} />
            </div>
          </div>
          {errors.authUser !== undefined && (
            <p className="mt-2 text-[12px] text-danger">{errors.authUser}</p>
          )}
        </SettingField>
      )}

      <SettingField
        title={t("connection.network.bypass")}
        description={
          <>
            命中任意一条就绕过代理直连,一行一条,支持{" "}
            <code className="text-fg-muted">*.example.com</code> 和 CIDR 网段。
            {/* ★ 这个数由 DIRECT_BYPASS 的长度算出来,不写死 —— 见 validate.ts 的 bypassSummary */}
            {t("connection.network.builtin", { count: summary.builtinCount })}
            <button
              type="button"
              className="ml-1 text-accent hover:underline"
              onClick={() => setShowBuiltin((v) => !v)}
            >
              {showBuiltin
                ? t("connection.network.hide")
                : t("connection.network.show")}
            </button>
          </>
        }
        last
      >
        <BypassInput
          value={p.bypass}
          disabled={!p.enabled}
          onCommit={(bypass) => patch({ proxy: { bypass } })}
        />
        {summary.userCount > 0 && (
          <p className="mt-2 text-[12px] text-fg-faint">
            {t("connection.network.userRules", { count: summary.userCount })}
          </p>
        )}
        {showBuiltin && (
          <div className="mt-2 flex flex-wrap gap-1.5 rounded-[8px] bg-tint p-2.5">
            {DIRECT_BYPASS.map((b) => (
              <code key={b} className="text-[11.5px] text-fg-muted">
                {b}
              </code>
            ))}
          </div>
        )}
      </SettingField>
    </SettingGroup>
  );
}

/**
 * 草稿态输入框的共用壳 —— 逐键写入等于每个字符一次 IPC + 一次全窗口广播,
 * 而且中间态(打到一半的地址)不该被存进设置。
 *
 * 回灌用**渲染期比对**,不用 `useEffect([value])` —— 后者正是 `Composer.tsx`
 * 注释点名的那个 bug(广播回来时把用户正在打的字冲掉)。有焦点时不回灌:
 * 别的窗口在你打字期间改了同一字段也冲不掉你,你失焦提交时最后写,你赢。
 */
function DraftInput({
  value,
  disabled,
  invalid = false,
  ariaLabel,
  placeholder,
  onCommit,
  transform,
}: {
  value: string;
  disabled: boolean;
  invalid?: boolean;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  /** 提交前的最后一次加工。返回 `null` = 别提交,还原成 `value` */
  transform?: (draft: string) => string | null;
}): ReactNode {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const focused = useRef(false);

  if (value !== seen && !focused.current) {
    setSeen(value);
    setDraft(value);
  }

  const commit = (): void => {
    focused.current = false;
    const next = transform === undefined ? draft.trim() : transform(draft);
    if (next === null) {
      setDraft(value);
      return;
    }
    setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <div onFocusCapture={() => (focused.current = true)}>
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        onRevert={() => {
          focused.current = false;
          setDraft(value);
        }}
        invalid={invalid}
        disabled={disabled}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * 地址栏。★ 粘一整条 `socks5://host:port` 进来时把它拆到三栏 ——
 * 不拆的话 host 里会留着整条 URL,拼出来的 `proxyRules` 是
 * `http://socks5://host:port`,而 Chromium **静默忽略**这条烂规则:
 * 界面上代理开着,流量却在直连。
 */
function HostInput({
  value,
  disabled,
  invalid,
  onCommit,
  onPasteFull,
}: {
  value: string;
  disabled: boolean;
  invalid: boolean;
  onCommit: (v: string) => void;
  onPasteFull: (ep: {
    scheme: ProxyScheme;
    host: string;
    port: number;
  }) => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <DraftInput
      value={value}
      disabled={disabled}
      invalid={invalid}
      ariaLabel={t("connection.network.address")}
      placeholder="127.0.0.1"
      onCommit={onCommit}
      transform={(draft) => {
        const full = splitPastedAddress(draft);
        if (full !== null) {
          onPasteFull(full);
          // 三栏一起被上面那次 patch 改了,这里就别再单独提交 host 了
          return null;
        }
        return draft.trim();
      }}
    />
  );
}

/** 端口栏。空 = 用协议默认端口;打不出数字时保持原值不动 */
function PortInput({
  value,
  disabled,
  invalid,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  invalid: boolean;
  onCommit: (n: number) => void;
}): ReactNode {
  const { t } = useI18n();
  const shown = value === 0 ? "" : String(value);
  return (
    <DraftInput
      value={shown}
      disabled={disabled}
      invalid={invalid}
      ariaLabel={t("connection.network.port")}
      placeholder={t("connection.network.port")}
      onCommit={() => {
        /* 真正的提交在 transform 里做完了 —— 这里拿到的是字符串,而落库要数字 */
      }}
      transform={(draft) => {
        const n = parsePortInput(draft);
        if (n === null) return null;
        if (n !== value) onCommit(n);
        return n === 0 ? "" : String(n);
      }}
    />
  );
}

/** 白名单多行框。草稿与失焦提交都在 `TextArea` 里,这里只给文案 */
function BypassInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <TextArea
      value={value}
      disabled={disabled}
      ariaLabel={t("connection.network.bypass")}
      placeholder={"*.example.com\n192.168.1.0/24"}
      onCommit={onCommit}
    />
  );
}

/**
 * 代理密码。★ **只写不读** —— 界面只知道「有没有」,没有任何路径能把它读回来
 * (`proxy:getPasswordInfo` 的回程是 `{hasKey, encryptionAvailable}`,连 last4
 * 都没有:密码只有一个,末四位帮不上忙却实实在在泄了四个字符)。
 */
function ProxyPasswordField({ disabled }: { disabled: boolean }): ReactNode {
  const { t } = useI18n();
  const [info, setInfo] = useState<{
    hasKey: boolean;
    encryptionAvailable: boolean;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getProxyPasswordInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch((e: unknown) => console.error("[proxy] 读取密码状态失败", e));
    return () => {
      alive = false;
    };
  }, []);

  const save = (): void => {
    if (draft === "") return;
    setBusy(true);
    void setProxyPassword(draft)
      .then((i) => {
        setInfo(i);
        setDraft(""); // ★ 存完就从内存里抹掉,不留在 React 状态里
      })
      .catch((e: unknown) => console.error("[proxy] 保存密码失败", e))
      .finally(() => setBusy(false));
  };

  const clear = (): void => {
    setBusy(true);
    void clearProxyPassword()
      .then(setInfo)
      .catch((e: unknown) => console.error("[proxy] 清除密码失败", e))
      .finally(() => setBusy(false));
  };

  // 密钥环不可用时如实说 —— `secrets.set` 会拒绝存储(明文落盘不是可接受的降级)
  if (info !== null && !info.encryptionAvailable) {
    return (
      <p className="pt-2 text-[12px] text-danger">
        {t("connection.network.keyringUnavailable")}
      </p>
    );
  }

  if (info?.hasKey === true && draft === "") {
    return (
      <div className="flex h-8 items-center gap-2">
        <Check size={14} className="shrink-0 text-accent" />
        <span className="flex-1 text-[12.5px] text-fg-muted">
          {t("connection.network.saved")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          onClick={clear}
        >
          {t("connection.network.clear")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <TextInput
          value={draft}
          onChange={setDraft}
          onCommit={save}
          ariaLabel={t("connection.network.password")}
          placeholder={t("connection.network.password")}
          disabled={disabled || busy}
          icon={<Eye size={13} />}
        />
      </div>
      <Button
        size="sm"
        variant="accent"
        disabled={disabled || busy || draft === ""}
        onClick={save}
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          t("connection.network.save")
        )}
      </Button>
    </div>
  );
}
