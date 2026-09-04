import {
  AlertTriangle,
  Brain,
  Check,
  CloudDownload,
  GripVertical,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  baseUrlWarnings,
  normalizeBaseUrl,
  previewUrl,
} from "../../../../../shared/domain/baseurl";
import { BUILTIN_PROVIDER_ID } from "../../../../../shared/domain/presets";
import type {
  AnthropicCacheTtl,
  CredentialInfo,
  UpstreamProvider,
} from "../../../../../shared/domain/provider";
import {
  anthropicCacheTtlOf,
  joinProtocol,
  MAX_ALIASES_PER_PROVIDER,
  splitProtocol,
} from "../../../../../shared/domain/provider";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import { TextInput } from "../../../components/ui/TextInput";
import { Toggle } from "../../../components/ui/Toggle";
import { cn } from "../../../lib/cn";
import {
  getCredentialInfo,
  removeProvider,
  setCredential,
  upsertProvider,
} from "../../../services/provider";
import { type ProviderEntry } from "./enabled-models";
import { ImportModelsDialog } from "./ImportModelsDialog";
import { modelListAvailability } from "./import-models";
import { ProviderAvatar } from "./ProviderAvatar";
import { baseUrlForProtocol, presetHasProtocol } from "./provider-edit";

/**
 * 参考图右边那张卡片。
 *
 * ★★ **这张表单以前整个包在 `<fieldset disabled>` 里,现在拆了。**
 * 当时的理由是真的:`provider:upsert` / `setCredential` 在 `main/ipc/index.ts` 里
 * 是 `todo()`,而一个「看着能填、保存时抛错」的表单会让用户第一反应是「我填错了」。
 * 那两条频道现在接上了(`main/ipc/provider.ts` 的写入面),所以禁用的理由没了。
 *
 * **`test` 仍然是 todo**,所以这里**没有「测试连接」按钮** —— 不是漏了。
 * 它要真发一次请求,而非 Anthropic 协议的编解码还没写(步骤 13);
 * 现在放上去,给 OpenAI 格式的供应商点一下必然失败,报出来还是「连不通」。
 *
 * ★ **「从服务商拉取模型列表」和它不一样,那个通了。** 拉列表只是一个
 * `GET`,不经过编解码那条路 —— 所以三个协议今天都能拉。三处协议差异
 * (路径 / 鉴权头 / **Anthropic 的游标分页默认只给 20 条**)在
 * `main/kernel/upstream/model-list.ts`,那边是纯函数、有测试。
 *
 * ## 三个字段的提交时机不一样,这是刻意的
 *
 * | 字段 | 时机 | 为什么 |
 * |---|---|---|
 * | 名称 / API 地址 | **失焦或回车** | 逐键写入 = 每敲一个字符一次 IPC + 一次全窗口广播,而且中间态(只打了 `http://`)会被存进去 |
 * | API 格式 / Responses | **立即** | 它们是离散选择,没有中间态;而且翻开关会连带换地址,拖到失焦才生效会让人以为没生效 |
 * | API 密钥 | 显式点「保存」 | 只写不读,存错了没法回看核对 —— 不该被一次失焦顺手提交 |
 *
 * ★ 地址在提交前跑一遍 `normalizeBaseUrl`(参考图那句「离开输入框后会自动识别并整理」),
 * 并把整理后的值**写回输入框**。不写回的话用户看到的还是自己粘的那条完整请求地址,
 * 而存进去的是另一个 —— 那种不一致比不整理更难查。
 *
 * ★ 写完**不本地 `set`**:主进程广播 `provider:changed`,`stores/models.ts` 订着。
 * 让广播成为唯一的更新入口(同 `stores/mcp.ts` 的规矩),否则多窗口下两条路会算出不同的结果。
 *
 * ★ 删除是**就地两步**,不弹确认框。`Dialog` 会 portal 到 body 并抢焦点陷阱,
 * 为一句「确定吗」搭一层模态,代价比它挡住的误触还大;而两步按钮同样需要
 * 第二次有意的点击。删除连密钥一起删(`provider:remove` 那边),所以这一步不能省。
 */
export function ProviderPanel({ entry }: { entry: ProviderEntry }): ReactNode {
  const { provider: p, aliases } = entry;
  const { family, responses } = splitProtocol(p.protocol);
  /*
    ★ 置灰与否看的是**预设表 + 当前地址**,不是「试了再报错」:
    `supportsModelList: false` 的那几家(DeepSeek / Kimi 的 Anthropic 端等)
    实测没有列表端点,点下去只会拿到一个 404。

    ★ 但地址被改过就照常放行 —— 那张快照描述的已经不是用户那个端点了。
    判据和三条分支写在 `import-models.ts` 的 modelListAvailability,那边有测试。
  */
  const listAvail = modelListAvailability(p);

  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 「地址跟着协议换了」的一次性提示。换供应商或再改一次就消失 */
  const [swapped, setSwapped] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [importOpen, setImportOpen] = useState(false);

  const [cred, setCred] = useState<CredentialInfo | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [cacheTtl, setCacheTtl] = useState<AnthropicCacheTtl>(() =>
    anthropicCacheTtlOf(p),
  );

  /*
    ★ 只认 `p.id`,不认 `p`。挂上 `p` 的话,保存成功后广播回来会再跑一次 ——
    用户已经开始改下一个字段的草稿会被冲掉。切换供应商才该重置草稿。
  */
  useEffect(() => {
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setError(null);
    setSwapped(null);
    setKeyDraft("");
    setEditingKey(false);
    setCred(null);
    setConfirmDelete(false);
    setCacheTtl(anthropicCacheTtlOf(p));

    let alive = true;
    void getCredentialInfo(p.id)
      .then((info) => {
        if (alive) setCred(info);
      })
      .catch((e: unknown) => console.error("[provider] 读取密钥状态失败", e));
    return () => {
      alive = false;
    };
    // 依赖只有 p.id 是刻意的,理由见上面那段注释(这个仓库没开 exhaustive-deps 规则)
  }, [p.id]);

  // Provider broadcasts are the source of truth after a discrete option is
  // saved. Keep the control synchronized when another window changes it.
  useEffect(() => {
    setCacheTtl(anthropicCacheTtlOf(p));
  }, [p.protocolOptions?.anthropic?.cacheTtl]);

  const save = (patch: Partial<UpstreamProvider>): void => {
    setBusy(true);
    setError(null);
    void upsertProvider({ ...p, ...patch })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        // 存不下去就把草稿退回库里那份 —— 留着一个没生效的值在框里,
        // 用户下次打开会以为它已经存进去了
        setName(p.name);
        setBaseUrl(p.baseUrl);
        setCacheTtl(anthropicCacheTtlOf(p));
      })
      .finally(() => setBusy(false));
  };

  const commitName = (): void => {
    const v = name.trim();
    if (v === "" || v === p.name) return setName(p.name);
    save({ name: v });
  };

  const commitUrl = (): void => {
    const v = normalizeBaseUrl(baseUrl);
    setBaseUrl(v); // ★ 整理后的值写回框里,别让显示的和存的是两个东西
    if (v === "" || v === p.baseUrl) return;
    save({ baseUrl: v });
  };

  const switchProtocol = (next: UpstreamProvider["protocol"]): void => {
    const r = baseUrlForProtocol(p, next);
    setBaseUrl(r.baseUrl);
    setSwapped(r.changed ? r.baseUrl : null);
    save({ protocol: next, baseUrl: r.baseUrl });
  };

  const changeCacheTtl = (next: AnthropicCacheTtl): void => {
    setCacheTtl(next);
    save({
      protocolOptions: {
        ...(p.protocolOptions ?? {}),
        anthropic: {
          ...(p.protocolOptions?.anthropic ?? {}),
          cacheTtl: next,
        },
      },
    });
  };

  const saveKey = (): void => {
    const v = keyDraft.trim();
    if (v === "") return;
    setBusy(true);
    setError(null);
    void setCredential(p.id, v)
      .then((info) => {
        setCred(info);
        setKeyDraft(""); // ★ 存完就从 React 状态里抹掉,别留在内存里
        setEditingKey(false);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    setBusy(true);
    setError(null);
    void removeProvider(p.id)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setConfirmDelete(false);
      })
      .finally(() => setBusy(false));
    // 删成功不用收尾:广播回来这条就没了,ModelPage 的 `selected` 自己兜到第一条
  };

  const warnings = baseUrlWarnings(baseUrl, p.protocol);
  const hasKey = cred?.hasKey ?? false;

  return (
    <>
      <div className="min-w-0 flex-1 rounded-[12px] border border-border bg-canvas">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <ProviderAvatar name={p.name} id={p.id} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
            {p.name}
          </span>
          {busy && (
            <Loader2
              size={13}
              className="shrink-0 animate-spin text-fg-faint"
            />
          )}
        </div>

        {error !== null && (
          <p className="border-b border-hairline bg-danger/10 px-4 py-2 text-[12px] leading-[1.6] text-danger">
            {error}
          </p>
        )}

        <div className="space-y-4 px-4 py-4">
          <Field label="供应商名称">
            <TextInput
              value={name}
              onChange={setName}
              onCommit={commitName}
              ariaLabel="供应商名称"
              disabled={busy}
            />
          </Field>

          <Field
            label="API 地址(自定义服务)"
            hint="从服务商接入文档复制 Base URL 或完整请求地址,离开输入框后会自动识别并整理。"
          >
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onCommit={commitUrl}
              ariaLabel="API 地址"
              inputMode="url"
              disabled={busy}
            />
            <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
              实际会请求{" "}
              <code className="text-fg-muted">
                {previewUrl(baseUrl, p.protocol)}
              </code>
            </p>
            {swapped !== null && (
              /* ★ 地址被开关改掉了就说一声。静默换掉是这一整块最不该有的行为 */
              <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-muted">
                换协议时地址已跟着换成这家该协议的地址 ——
                这两个协议在同一个域名下路径前缀不同。
              </p>
            )}
            {warnings.map((w) => (
              <p
                key={w.kind}
                className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-[1.6] text-danger"
              >
                <AlertTriangle size={12} className="mt-[2px] shrink-0" />
                <span className="min-w-0">{w.message}</span>
              </p>
            ))}
          </Field>

          <Field label="API 格式">
            <Segmented
              label="API 格式"
              className="w-full"
              value={family}
              options={[
                { value: "openai", label: "OpenAI 格式" },
                { value: "anthropic", label: "Anthropic 格式" },
              ]}
              onChange={(f) =>
                switchProtocol(joinProtocol(f, f === "openai" && responses))
              }
            />
          </Field>

          {/* ★ 只在 OpenAI 族下出现 —— 三个协议值到「两控件」的投影,见 provider.ts */}
          {family === "openai" && (
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-fg">使用 Responses API</p>
                <p className="mt-1 text-[11.5px] leading-[1.6] text-fg-muted">
                  强制走 /v1/responses。仅当供应商支持 Responses
                  端点时开启,否则会 404。
                </p>
                {responses && !presetHasProtocol(p.id, "openai-responses") && (
                  /*
                  ★ 提示而不是**禁掉**开关:预设表只是我们实测到的形状,
                  厂商随时会加。禁掉等于拿一张快照锁死用户。
                */
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-[1.6] text-danger">
                    <AlertTriangle size={12} className="mt-[2px] shrink-0" />
                    <span className="min-w-0">
                      我们实测这家没有可用的 Responses 端点,开着大概率 404。
                    </span>
                  </p>
                )}
              </div>
              <div className="shrink-0 pt-0.5">
                <Toggle
                  checked={responses}
                  disabled={busy}
                  onChange={(on) => switchProtocol(joinProtocol("openai", on))}
                  label="使用 Responses API"
                />
              </div>
            </div>
          )}

          {family === "anthropic" && (
            <Field
              label="提示缓存"
              hint="一般情况下保持关闭。缓存适合长且重复的上下文；1 小时写入通常更贵，且部分 Anthropic 兼容中转站不支持。"
            >
              <Segmented
                label="提示缓存"
                size="sm"
                value={cacheTtl}
                options={[
                  { value: "off", label: "关闭" },
                  { value: "5m", label: "5 分钟" },
                  { value: "1h", label: "1 小时" },
                ]}
                onChange={changeCacheTtl}
              />
            </Field>
          )}

          <Field label="API 密钥">
            {editingKey || !hasKey ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <TextInput
                    value={keyDraft}
                    onChange={setKeyDraft}
                    onCommit={saveKey}
                    ariaLabel={`${p.name} 的 API 密钥`}
                    placeholder="粘贴 API Key"
                    disabled={busy}
                  />
                </div>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy || keyDraft.trim() === ""}
                  onClick={saveKey}
                >
                  保存
                </Button>
                {hasKey && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditingKey(false)}
                  >
                    取消
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/*
                ★ 这里**不是**一个填了值的输入框 —— 渲染层对密钥只写不读(方案 §9),
                明文永远不回传。掩码是定长的,它表示「有一把 key」,
                **不表示 key 有多长**;后面那四位是主进程回的 `last4`。
              */}
                <div
                  className={cn(
                    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-border",
                    "bg-surface-field px-2.5",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] tracking-[0.18em] text-fg-muted">
                    {"••••••••••••"}
                    {cred?.last4 ?? ""}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-accent">
                    <Check size={11} />
                    已配置
                  </span>
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditingKey(true)}
                >
                  更换
                </Button>
              </div>
            )}
            <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
              明文只在主进程里存在,经 safeStorage 加密后落盘 ——
              设置页永远拿不回来,最多显示后四位。
            </p>
            {cred !== null && !cred.encryptionAvailable && (
              /* ★ 不做明文降级,所以这里会真的存不进去 —— 提前说,别等他填完才报错 */
              <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-[1.6] text-danger">
                <AlertTriangle size={12} className="mt-[2px] shrink-0" />
                <span className="min-w-0">
                  系统密钥环不可用,密钥无法安全存储,保存会被拒绝(不会退回明文落盘)。
                </span>
              </p>
            )}
          </Field>

          <Field
            label="模型优先级(至少添加一个)"
            hint="这家自己的模型顺序。切到别的供应商是另一条轴 —— 那由左列同名别名的候选链决定。"
            action={
              <>
                {listAvail.enabled && aliases.length > 0 && (
                  <span className="shrink-0 text-[11px] text-fg-faint">
                    {aliases.length}/{MAX_ALIASES_PER_PROVIDER}
                  </span>
                )}
                <Button
                  size="sm"
                  disabled={!listAvail.enabled}
                  icon={<CloudDownload size={13} />}
                  onClick={() => setImportOpen(true)}
                >
                  从服务商拉取模型列表
                </Button>
              </>
            }
          >
            {aliases.length === 0 ? (
              <p className="rounded-[8px] border border-dashed border-border px-2.5 py-3 text-[12px] text-fg-faint">
                这家还没有配任何模型 —— 点右上角从服务商拉一份列表。
              </p>
            ) : (
              /*
              ★★ **前一版这里写着「别名的写入频道契约里根本没有」—— 那句已经不成立了。**
              `provider:fetchModels` 和 `provider:setAliases` 现在都在契约里,
              整表的增删就走右上角那颗按钮(弹窗是替换语义:取消勾选 = 删掉)。

              ★ 但**逐行的三个图标仍然不通**,而且不是同一件事:思考档位、改别名、
              单删一行要的是「改一行的字段」,那需要另一条 upsert 频道和一个编辑态,
              不是 `setAliases` 顺手能做的 —— 所以它们照旧置灰,下面那句话直说。
            */
              <ul className="overflow-hidden rounded-[8px] border border-border">
                {aliases.map((m, i) => (
                  <li
                    key={m.alias}
                    className="flex items-center gap-2 border-b border-hairline px-2.5 py-2 last:border-b-0"
                  >
                    <GripVertical
                      size={13}
                      className="shrink-0 text-fg-faint opacity-30"
                      aria-hidden
                    />
                    {i === 0 && (
                      <span className="shrink-0 rounded-[5px] bg-tint px-1.5 py-0.5 text-[10.5px] text-fg-muted">
                        主模型
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                      {m.alias}
                    </span>
                    <RowIcon label="思考档位">
                      <Brain size={13} />
                    </RowIcon>
                    <RowIcon label="编辑">
                      <Pencil size={13} />
                    </RowIcon>
                    <RowIcon label="移除">
                      <Trash2 size={13} />
                    </RowIcon>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
              {listAvail.hint ??
                "整表的增删走上面那颗按钮。逐行的三个图标(思考档位 / 改别名 / 单删)还不通 —— 它们要的是「改一行的字段」,那是另一条频道。"}
            </p>
          </Field>
        </div>

        <div className="border-t border-hairline px-4 py-3">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-[11.5px] leading-[1.6] text-fg-muted">
                连同这家的模型别名和已保存的密钥一起删掉,不能撤销。
              </p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={remove}
              >
                确认删除
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {/*
              ★ **两句话不是同一句的两种说法,是两种不同的后果,所以必须分开写。**
              内置那条是种子数据:删了下次启动它自己回来 —— 不说的话用户重启看见它又在,
              第一反应是「删除没生效」,而实际上删是生效了的(密钥就没回来)。
              自己加的那条删了就真没了,得回目录重新添 —— 把「会回来」这句显示在它下面,
              等于骗用户放心删。
            */}
              <p className="min-w-0 flex-1 text-[11.5px] leading-[1.6] text-fg-faint">
                {p.id === BUILTIN_PROVIDER_ID
                  ? "内置的 RoutinAI 是种子数据,删掉后下次启动会重新出现(密钥不会回来)。"
                  : "删掉后不会自己回来 —— 要再用得回「供应商目录」重新添一次。"}
              </p>
              <Button
                size="sm"
                icon={<Trash2 size={12} />}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                删除
              </Button>
            </div>
          )}
        </div>
      </div>

      <ImportModelsDialog
        open={importOpen}
        providerId={p.id}
        providerName={p.name}
        aliases={aliases}
        onClose={() => setImportOpen(false)}
      />
    </>
  );
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  /** 标签那一行右端的按钮(「从服务商拉取模型列表」) */
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      {/* ★ 只有带按钮的那一行才撑高 —— 无条件加 min-h 会把另外四个字段的行高
          一起改掉,而那套间距是照着设置浮层量准的 */}
      <div
        className={cn(
          "mb-1.5 flex items-center gap-2",
          action !== undefined && "min-h-[26px]",
        )}
      >
        <p className="min-w-0 flex-1 text-[12.5px] text-fg-muted">{label}</p>
        {action}
      </div>
      {children}
      {hint !== undefined && (
        <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
          {hint}
        </p>
      )}
    </div>
  );
}

function RowIcon({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      disabled
      className="app-no-drag shrink-0 text-icon opacity-40"
    >
      {children}
    </button>
  );
}
