import {
  Check,
  Cpu,
  File,
  Globe,
  Image,
  Pencil,
  Plus,
  Search,
  Trash2,
  Video,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ModelAlias,
  ModelCapabilities,
  ThinkingConfig,
  ThinkingMode,
} from "../../../../../shared/domain/provider";
import type { ModelPricing } from "../../../../../shared/domain/pricing";
import { PRICING_SEED } from "../../../../../shared/domain/pricing-seed";
import { PROVIDER_PRESETS } from "../../../../../shared/domain/presets";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Dialog } from "../../../components/ui/Dialog";
import { TextInput } from "../../../components/ui/TextInput";
import { Toggle } from "../../../components/ui/Toggle";
import { cn } from "../../../lib/cn";
import { updateModel, removeModel } from "../../../services/provider";
import { useModelsStore } from "../../../stores/models";
import type { SettingsPageProps } from "../../props";
import { SettingGroup, TodoRow } from "../../Row";
import { ProviderCatalog } from "./ProviderCatalog";
import { PricingTable } from "./PricingTable";
import { StubModalityPage } from "./StubModalityPage";
import { EnabledModelList } from "./EnabledModelList";
import { ProviderPanel } from "./ProviderPanel";
import { providerEntries, type ProviderEntry } from "./enabled-models";
import { parseModelTab } from "./tabs";
import { useI18n } from "../../../i18n";

export function ModelPage({
  settings,
  sub,
  patch,
}: SettingsPageProps): ReactNode {
  const tab = parseModelTab(sub);
  if (tab === "usage") return <UsageTab />;
  if (tab === "management") return <ModelConsole modality="text" catalogMode />;
  if (tab !== "text") return <StubModalityPage modality={tab} />;
  return <LegacyTextTab settings={settings} patch={patch} />;
}

function LegacyTextTab({
  settings,
  patch,
}: Omit<SettingsPageProps, "sub">): ReactNode {
  const { t } = useI18n();
  const providers = useModelsStore((s) => s.providers),
    models = useModelsStore((s) => s.models),
    loaded = useModelsStore((s) => s.loaded),
    load = useModelsStore((s) => s.load);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  const entries = useMemo(
    () => providerEntries(providers, models, ""),
    [providers, models],
  );
  const selected =
    entries.find((e) => e.provider.id === selectedId) ?? entries[0] ?? null;
  return (
    <>
      <div className="flex items-start gap-4">
        <EnabledModelList
          entries={entries}
          loaded={loaded}
          selectedId={selected?.provider.id ?? null}
          onSelect={setSelectedId}
          onAdd={() => setCatalogOpen(true)}
          footer={
            <div className="space-y-1 text-[11px] text-fg-faint">
              <label className="flex items-center justify-between gap-2">
                {t("models.default")}
                <select
                  value={settings.defaultModel}
                  onChange={(e) => patch({ defaultModel: e.target.value })}
                  className="max-w-[116px] rounded border border-border bg-surface-field px-1 py-0.5 text-[10px] text-fg"
                >
                  <option value="">{t("models.followConversation")}</option>
                  {models.map((m) => (
                    <option key={m.alias} value={m.alias}>
                      {m.alias}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                {t("models.defaultSubagent")}
                <select
                  value={settings.subagent.model}
                  onChange={(e) =>
                    patch({ subagent: { model: e.target.value } })
                  }
                  className="max-w-[116px] rounded border border-border bg-surface-field px-1 py-0.5 text-[10px] text-fg"
                >
                  <option value="">{t("models.followConversation")}</option>
                  {models.map((m) => (
                    <option key={m.alias} value={m.alias}>
                      {m.alias}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          }
        />
        {selected ? (
          <ProviderPanel entry={selected} />
        ) : (
          <EmptyState
            className="min-w-0 flex-1 py-16"
            title={t("models.noProvider")}
            hint={t("models.addProviderHint")}
          />
        )}
      </div>
      <ProviderCatalog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onAdded={(id) => {
          setSelectedId(id);
          setCatalogOpen(false);
        }}
      />
    </>
  );
}

type Manufacturer = {
  id: string;
  label: string;
  match: (modelId: string) => boolean;
};

const MANUFACTURERS: readonly Manufacturer[] = [
  {
    id: "openai",
    label: "OpenAI",
    match: (id) => /^(gpt|o[1-9]|chatgpt)/i.test(id),
  },
  { id: "anthropic", label: "Anthropic", match: (id) => /^claude/i.test(id) },
  { id: "google", label: "Google", match: (id) => /^(gemini|gemma)/i.test(id) },
  { id: "deepseek", label: "DeepSeek", match: (id) => /^deepseek/i.test(id) },
  { id: "zhipu", label: "智谱 GLM", match: (id) => /^(glm|chatglm)/i.test(id) },
  { id: "qwen", label: "阿里云 Qwen", match: (id) => /^(qwen|通义)/i.test(id) },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    match: (id) => /^(moonshot|kimi)/i.test(id),
  },
  { id: "xai", label: "xAI Grok", match: (id) => /^grok/i.test(id) },
  {
    id: "mistral",
    label: "Mistral AI",
    match: (id) => /^(mistral|devstral)/i.test(id),
  },
  { id: "cohere", label: "Cohere", match: (id) => /^command/i.test(id) },
  { id: "minimax", label: "MiniMax", match: (id) => /^minimax/i.test(id) },
  {
    id: "meta",
    label: "Meta Llama",
    match: (id) => /^(llama|meta-llama)/i.test(id),
  },
];

const PROVIDER_MANUFACTURER: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  "gemini-openai": "google",
  deepseek: "deepseek",
  zhipu: "zhipu",
  "zhipu-coding": "zhipu",
  zai: "zhipu",
  "zai-coding": "zhipu",
  dashscope: "qwen",
  "dashscope-intl": "qwen",
  moonshot: "moonshot",
  "moonshot-global": "moonshot",
  "kimi-coding": "moonshot",
  xai: "xai",
  mistral: "mistral",
  cohere: "cohere",
  minimax: "minimax",
  "minimax-global": "minimax",
  groq: "meta",
};

function manufacturerFor(
  modelId: string,
  providerIds: readonly string[] = [],
): Manufacturer & { id: string } {
  // Aggregators commonly prefix the upstream ID (for example
  // `anthropic/claude-*`). Inspect every path segment before using provider
  // metadata so the catalogue remains vendor-first even when a connection is
  // an aggregator such as OpenRouter or SiliconFlow.
  const segments = modelId.split("/").filter(Boolean);
  const byId = (id: string): Manufacturer | undefined =>
    MANUFACTURERS.find((m) => m.id === id);
  for (const segment of segments) {
    const match = MANUFACTURERS.find((m) => m.match(segment));
    if (match) return match;
  }
  for (const providerId of providerIds) {
    const manufacturerId = PROVIDER_MANUFACTURER[providerId];
    const match =
      manufacturerId === undefined ? undefined : byId(manufacturerId);
    if (match) return match;
  }
  return { id: "other", label: "其他厂商", match: () => false };
}

type CatalogRow = ModelAlias & {
  manufacturer: string;
  manufacturerLabel: string;
  configured: boolean;
  pricing?: ModelPricing;
};

function catalogRows(configured: readonly ModelAlias[]): CatalogRow[] {
  const byId = new Map(configured.map((m) => [m.upstreamModel, m]));
  const providersByModel = new Map<string, string[]>();
  for (const model of configured) {
    const owners = providersByModel.get(model.upstreamModel) ?? [];
    owners.push(model.providerId);
    providersByModel.set(model.upstreamModel, owners);
  }
  const ids = new Set<string>([
    ...PRICING_SEED.map((p) => p.modelId),
    ...PROVIDER_PRESETS.flatMap((p) => p.suggestedModels),
    ...configured.map((m) => m.upstreamModel),
  ]);
  return [...ids].map((id) => {
    const existing = byId.get(id);
    const pricing = PRICING_SEED.find((p) => p.modelId === id);
    const manufacturer = manufacturerFor(
      id,
      providersByModel.get(id) ??
        PROVIDER_PRESETS.filter((p) => p.suggestedModels.includes(id)).map(
          (p) => p.id,
        ),
    );
    const catalogDefaults: ModelAlias = {
      alias: id,
      providerId: "catalog",
      upstreamModel: id,
      capabilities: {
        tools: true,
        vision: /^(claude|gemini|gpt-4o|gpt-5|glm|qwen)/i.test(id),
        thinking: /(reason|o[1-9]|deepseek|glm|qwen)/i.test(id),
        caching: true,
        textInput: true,
        fileInput: false,
        videoInput: false,
        audioInput: false,
        textOutput: true,
        imageOutput: false,
        videoOutput: false,
        audioOutput: false,
        webSearch: false,
        structuredOutput: true,
        streaming: true,
        batch: false,
      },
      contextWindow: 0,
      maxOutputTokens: 0,
      enabled: false,
    };
    return {
      ...(existing ?? catalogDefaults),
      manufacturer: manufacturer.id,
      manufacturerLabel: manufacturer.label,
      configured: existing !== undefined,
      pricing,
      displayName: existing?.displayName ?? pricing?.displayName,
    };
  });
}

function ModelConsole({
  modality,
  catalogMode = false,
}: {
  modality: string;
  catalogMode?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const providers = useModelsStore((s) => s.providers),
    models = useModelsStore((s) => s.models),
    loaded = useModelsStore((s) => s.loaded),
    load = useModelsStore((s) => s.load);
  const [providerId, setProviderId] = useState<string | null>(null),
    [selectedKey, setSelectedKey] = useState<string | null>(null),
    [editingModel, setEditingModel] = useState<CatalogRow | ModelAlias | null>(null),
    [catalogOpen, setCatalogOpen] = useState(false),
    [query, setQuery] = useState(""),
    [capability, setCapability] = useState("all"),
    [modalityFilter, setModalityFilter] = useState("all");
  useEffect(() => {
    void load();
  }, [load]);
  const entries = useMemo(
    () => providerEntries(providers, models, ""),
    [providers, models],
  );
  const catalog = useMemo(() => catalogRows(models), [models]);
  const manufacturerList = useMemo(() => {
    const present = new Set(catalog.map((m) => m.manufacturer));
    return [
      ...MANUFACTURERS.filter((m) => present.has(m.id)).map((m) => m.id),
      ...(present.has("other") ? ["other"] : []),
    ];
  }, [catalog]);
  const filtered = useMemo(
    () =>
      (catalogMode
        ? catalog.filter(
            (m) => providerId === null || m.manufacturer === providerId,
          )
        : models.filter(
            (m) =>
              (providerId === null || m.providerId === providerId) &&
              (modality === "text" || m.modality === modality),
          )
      ).filter((m) => {
        const q = query.trim().toLowerCase();
        if (
          q &&
          !`${m.alias} ${m.upstreamModel} ${m.displayName ?? ""}`
            .toLowerCase()
            .includes(q)
        )
          return false;
        if (
          modalityFilter !== "all" &&
          (m.modality ?? "text") !== modalityFilter
        )
          return false;
        if (capability === "vision" && !m.capabilities.vision) return false;
        if (capability === "file" && !m.capabilities.fileInput) return false;
        if (capability === "web" && !m.capabilities.webSearch) return false;
        if (capability === "think" && !m.capabilities.thinking) return false;
        return true;
      }),
    [
      catalogMode,
      catalog,
      models,
      providerId,
      modality,
      query,
      capability,
      modalityFilter,
    ],
  );
  const selected =
    filtered.find((m) => `${m.providerId}:${m.alias}` === selectedKey) ??
    filtered[0] ??
    null;
  return (
    <>
      <div className="flex min-h-[520px] min-w-0 gap-3">
        <aside className="w-[178px] shrink-0 border-r border-hairline pr-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] text-fg">
              {catalogMode ? t("models.manufacturer") : t("models.vendor")}
            </span>
            <button
              type="button"
              aria-label={t("models.addProvider")}
              title={t("models.addProvider")}
              onClick={() => setCatalogOpen(true)}
              className="rounded-[6px] p-1 text-icon hover:bg-tint-hover hover:text-fg"
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setProviderId(null)}
            className={cn(
              "mb-1 flex w-full items-center justify-between rounded-[8px] px-2 py-2 text-left text-[12px]",
              providerId === null
                ? "bg-tint text-fg"
                : "text-fg-muted hover:bg-tint-hover",
            )}
          >
            <span>{catalogMode ? t("models.all") : t("models.allProviders")}</span>
            <span className="text-[11px] text-fg-faint">
              {catalogMode ? catalog.length : models.length}
            </span>
          </button>
          <ul className="space-y-0.5">
            {(catalogMode
              ? manufacturerList.map((id) => ({
                  id,
                  label:
                    MANUFACTURERS.find((m) => m.id === id)?.label ?? t("models.otherVendor"),
                }))
              : entries.map((e) => ({
                  id: e.provider.id,
                  label: e.provider.name,
                }))
            ).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setProviderId(item.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-[8px] px-2 py-2 text-left text-[12px]",
                    providerId === item.id
                      ? "bg-tint text-fg"
                      : "text-fg-muted hover:bg-tint-hover",
                  )}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  <span className="text-[11px] text-fg-faint">
                    {catalogMode
                      ? catalog.filter((m) => m.manufacturer === item.id).length
                      : models.filter((m) => m.providerId === item.id).length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loaded && !catalogMode && entries.length === 0 && (
            <p className="mt-3 text-[11.5px] leading-[1.5] text-fg-faint">
              {t("models.noProviders", { count: PROVIDER_PRESETS.length })}
            </p>
          )}
        </aside>
        <section className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                size="sm"
                value={query}
                onChange={setQuery}
                placeholder={t("models.search")}
                ariaLabel={t("models.searchLabel")}
                icon={<Search size={13} />}
              />
            </div>
            <select
              value={modalityFilter}
              onChange={(e) => setModalityFilter(e.target.value)}
              className="h-8 rounded-[7px] border border-border bg-surface-field px-2 text-[11.5px] text-fg"
            >
              <option value="all">{t("models.allTypes")}</option>
              <option value="text">{t("models.text")}</option>
              <option value="image">{t("models.image")}</option>
              <option value="video">{t("models.video")}</option>
              <option value="speech">{t("models.speech")}</option>
              <option value="transcription">{t("models.transcription")}</option>
            </select>
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              className="h-8 rounded-[7px] border border-border bg-surface-field px-2 text-[11.5px] text-fg"
            >
              <option value="all">{t("models.allCapabilities")}</option>
              <option value="vision">Vision</option>
              <option value="file">File</option>
              <option value="web">Web</option>
              <option value="think">Think</option>
            </select>
          </div>
          <div className="max-h-[510px] overflow-auto scroll-thin rounded-[10px] border border-border">
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-[710px] border-collapse text-[11.5px]">
                <thead className="bg-surface">
                  <tr className="border-b border-hairline text-fg-faint">
                    <th className="w-7 py-2"></th>
                    <th className="py-2 text-left font-normal">{t("models.columns.model")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.type")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.capabilities")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.input")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.output")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.pricing")}</th>
                    <th className="py-2 text-left font-normal">{t("models.columns.status")}</th>
                    <th className="sticky right-0 w-16 bg-surface py-2 pr-2 text-right font-normal shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.35)]">{t("models.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <ModelRow
                      key={`${m.providerId}:${m.alias}`}
                      model={m}
                      selected={
                        selected?.alias === m.alias &&
                        selected?.providerId === m.providerId
                      }
                      onSelect={() =>
                        setSelectedKey(`${m.providerId}:${m.alias}`)
                      }
                      onEdit={() => setEditingModel(m)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <EmptyState
                className="py-12"
                icon={<Cpu size={20} />}
                title={t("models.noMatch")}
                hint={
                  loaded
                    ? t("models.adjustFilters")
                    : t("models.readingCatalog")
                }
              />
            )}
          </div>
        </section>
      </div>
      <Dialog
        open={editingModel !== null}
        onClose={() => setEditingModel(null)}
        title={t("models.edit")}
        description={editingModel?.displayName ?? editingModel?.alias}
        width={420}
      >
        {editingModel && "configured" in editingModel && !editingModel.configured ? (
          <CatalogModelInspector model={editingModel} />
        ) : editingModel ? (
          (() => {
            const entry = entries.find((e) => e.provider.id === editingModel.providerId);
            return entry ? (
              <ModelInspector model={editingModel} entry={entry} onDeleted={() => setEditingModel(null)} />
            ) : (
              <EmptyState className="py-12" title="供应商已不存在" hint="请重新选择一个模型或检查供应商配置。" />
            );
          })()
        ) : null}
      </Dialog>
      <ProviderCatalog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onAdded={(id) => {
          setProviderId(id);
          setCatalogOpen(false);
        }}
      />
      <div className="mt-4 border-t border-hairline pt-2 text-[11px] text-fg-faint">
        {t("models.limitHint")}
      </div>
    </>
  );
}

function ModelRow({
  model: m,
  selected,
  onSelect,
  onEdit,
}: {
  model: CatalogRow | ModelAlias;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}): ReactNode {
  const { t } = useI18n();
  const caps = [
    m.capabilities.vision && "Vision",
    m.capabilities.fileInput && "File",
    m.capabilities.videoInput && "Video",
    m.capabilities.webSearch && "Web",
    m.capabilities.tools && "Tools",
    m.capabilities.thinking && "Think",
  ].filter(Boolean) as string[];
  const price =
    "pricing" in m
      ? m.pricing
      : PRICING_SEED.find((p) => p.modelId === m.upstreamModel);
  const rate = price?.tiers[0]?.rate;
  const currency = price?.currency ?? "USD";
  const money = (value: number | undefined): string =>
    value === undefined
      ? "—"
      : currency === "USD"
        ? `$${value.toFixed(2)}`
        : `${currency === "CNY" ? "¥" : currency} ${value.toFixed(2)}`;
  const configured = "configured" in m ? m.configured : true;
  const modalityLabel =
    {
      text: t("models.text"),
      image: t("models.image"),
      video: t("models.video"),
      speech: t("models.speech"),
      transcription: t("models.transcription"),
    }[m.modality ?? "text"] ?? "文本";
  return (
    <tr
      onClick={onSelect}
      className={cn(
        "cursor-pointer border-b border-hairline last:border-0 hover:bg-tint-hover/50",
        selected && "bg-tint",
      )}
    >
      <td className="py-2 pl-2 text-center">
        {selected && <Check size={13} className="text-accent" />}
      </td>
      <td className="max-w-[150px] py-2">
        <div className="truncate text-fg">{m.displayName ?? m.alias}</div>
        <div className="truncate font-mono text-[10px] text-fg-faint">
          {m.upstreamModel}
        </div>
      </td>
      <td className="py-2 text-fg-muted">{modalityLabel}</td>
      <td className="py-2">
        <div className="flex max-w-[135px] flex-wrap gap-1">
          {caps.slice(0, 4).map((c) => (
            <span
              key={c}
              className="rounded-[4px] bg-surface-sunken px-1 text-[10px] text-fg-muted"
            >
              {c}
            </span>
          ))}
          {caps.length > 4 && (
            <span className="text-[10px] text-fg-faint">
              +{caps.length - 4}
            </span>
          )}
        </div>
      </td>
      <td className="py-2 tabular-nums text-fg-muted">
        {money(rate?.input)}
        {currency !== "USD" && rate?.input !== undefined && (
          <span className="ml-1 text-[9px] text-fg-faint">{t("models.estimatedUsd")}</span>
        )}
      </td>
      <td className="py-2 tabular-nums text-fg-muted">
        {money(rate?.output)}
        {currency !== "USD" && rate?.output !== undefined && (
          <span className="ml-1 text-[9px] text-fg-faint">{t("models.estimatedUsd")}</span>
        )}
      </td>
      <td className="py-2 text-fg-muted">
        {price ? (
          <span>
            {price.tiers.length > 1 ? t("models.tiers", { count: price.tiers.length }) : t("models.singleTier")}
            {price.windows?.length ? t("models.windows", { count: price.windows.length }) : ""}
          </span>
        ) : (
          t("models.pendingValidation")
        )}
      </td>
      <td className="py-2 pr-2 text-right">
        {!configured ? (
          <span className="text-fg-faint">{t("models.unconfigured")}</span>
        ) : m.enabled === false ? (
          <span className="text-fg-faint">{t("models.disabled")}</span>
        ) : (
          <span className="text-accent">{t("models.enabled")}</span>
        )}
      </td>
      <td className="sticky right-0 bg-canvas py-2 pr-2 text-right shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.35)]">
        <button
          type="button"
          aria-label={`${t("models.edit")} ${m.displayName ?? m.alias}`}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
          className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-1 text-[10.5px] text-fg-muted hover:bg-tint-hover hover:text-fg"
        >
          <Pencil size={12} />
          {t("models.edit")}
        </button>
      </td>
    </tr>
  );
}

function ModelInspector({
  model: initial,
  entry,
  onDeleted,
}: {
  model: ModelAlias;
  entry: ProviderEntry;
  onDeleted: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [model, setModel] = useState(initial);
  useEffect(() => setModel(initial), [initial]);
  const save = (p: Partial<ModelAlias>): void => {
    const next = { ...model, ...p };
    setModel(next);
    void updateModel(next).catch((e) => console.error("[model] 保存失败", e));
  };
  const setCap = (key: keyof ModelCapabilities, value: boolean): void =>
    save({ capabilities: { ...model.capabilities, [key]: value } });
  const thinking: ThinkingConfig = model.thinkingConfig ?? {
    mode: model.capabilities.thinking ? "toggle" : "unsupported",
    defaultEnabled: false,
  };
  return (
    <div className="space-y-4 overflow-y-auto pb-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] text-fg">
            {model.displayName ?? model.alias}
          </h3>
          <p className="truncate font-mono text-[10.5px] text-fg-faint">
            {model.upstreamModel}
          </p>
          <p className="mt-1 text-[11px] text-fg-muted">
            {entry.provider.name}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("models.delete")}
          onClick={() => {
            void removeModel(model.providerId, model.alias).then(onDeleted);
          }}
          className="rounded-[6px] p-1 text-fg-faint hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <InspectorSection title={t("models.capabilities")}>
        <Capability
          icon={<Image size={13} />}
          label="Vision"
          value={model.capabilities.vision}
          onChange={(v) => setCap("vision", v)}
        />
        <Capability
          icon={<File size={13} />}
          label="File"
          value={Boolean(model.capabilities.fileInput)}
          onChange={(v) => setCap("fileInput", v)}
        />
        <Capability
          icon={<Video size={13} />}
          label="Video"
          value={Boolean(model.capabilities.videoInput)}
          onChange={(v) => setCap("videoInput", v)}
        />
        <Capability
          icon={<Globe size={13} />}
          label={t("models.webSearch")}
          value={Boolean(model.capabilities.webSearch)}
          onChange={(v) => setCap("webSearch", v)}
        />
        <Capability
          icon={<Wrench size={13} />}
          label="Tools"
          value={model.capabilities.tools}
          onChange={(v) => setCap("tools", v)}
        />
        <Capability
          icon={<Zap size={13} />}
          label={t("models.imageGeneration")}
          value={Boolean(model.capabilities.imageOutput)}
          onChange={(v) => setCap("imageOutput", v)}
        />
      </InspectorSection>
      <InspectorSection title={t("models.reasoning")}>
        <select
          value={thinking.mode}
          onChange={(e) =>
            save({
              thinkingConfig: {
                ...thinking,
                mode: e.target.value as ThinkingMode,
              },
              capabilities: {
                ...model.capabilities,
                thinking: e.target.value !== "unsupported",
              },
            })
          }
          className="h-7 w-full rounded-[6px] border border-border bg-surface-field px-2 text-[11.5px] text-fg"
        >
          <option value="unsupported">{t("models.unsupported")}</option>
          <option value="always">{t("models.always")}</option>
          <option value="toggle">{t("models.toggle")}</option>
          <option value="effort">{t("models.effort")}</option>
          <option value="budget">{t("models.budget")}</option>
        </select>
        <p className="mt-1 text-[10.5px] leading-[1.45] text-fg-faint">
          {t("models.reasoningHint")}
        </p>
      </InspectorSection>
      <InspectorSection title={t("models.requestAdapter")}>
        <div className="flex items-center gap-1 text-[11px] text-fg-muted">
          <Cpu size={13} />
          {t("models.presetAdapter")}
        </div>
        <select
          value={model.requestAdapter?.preset ?? "auto"}
          onChange={(e) =>
            save({
              requestAdapter: {
                preset: e.target.value as NonNullable<
                  ModelAlias["requestAdapter"]
                >["preset"],
                patches: model.requestAdapter?.patches ?? [],
              },
            })
          }
          className="mt-2 h-7 w-full rounded-[6px] border border-border bg-surface-field px-2 text-[11.5px] text-fg"
        >
          <option value="auto">{t("models.autoDetect")}</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai-chat">OpenAI Chat</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="custom">{t("models.customPatch")}</option>
        </select>
        <p className="mt-1 text-[10.5px] leading-[1.45] text-fg-faint">
          {t("models.adapterHint")}
        </p>
      </InspectorSection>
      <InspectorSection title={t("models.officialSource")}>
        <p className="text-[11px] text-fg-muted">
          {model.source?.url ?? t("models.noSource")}
        </p>
        <p className="mt-1 text-[10.5px] text-fg-faint">
          {model.source?.fetchedAt
            ? `抓取于 ${model.source.fetchedAt}`
            : t("models.fetchSourceHint")}
        </p>
      </InspectorSection>
    </div>
  );
}

function CatalogModelInspector({ model }: { model: CatalogRow }): ReactNode {
  const { t } = useI18n();
  const pricing = model.pricing;
  const rate = pricing?.tiers[0]?.rate;
  const currency = pricing?.currency ?? "USD";
  const money = (value: number | undefined): string =>
    value === undefined
      ? "—"
      : currency === "USD"
        ? `$${value.toFixed(2)}`
        : `${currency} ${value.toFixed(2)}`;
  return (
    <div className="space-y-4 overflow-y-auto pb-3">
      <div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] text-fg">
              {model.displayName ?? model.alias}
            </h3>
            <p className="truncate font-mono text-[10.5px] text-fg-faint">
              {model.upstreamModel}
            </p>
          </div>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] text-fg-faint">
            {t("models.catalogModel")}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-[1.5] text-fg-muted">
          {model.manufacturerLabel} · 当前尚未绑定 AI
          连接。先在“文本生成”中配置供应商，绑定后即可编辑该模型的能力和请求策略。
        </p>
      </div>
      <InspectorSection title="目录能力">
        <div className="flex flex-wrap gap-1.5">
          {[
            model.capabilities.vision && "Vision",
            model.capabilities.fileInput && "File",
            model.capabilities.videoInput && "Video",
            model.capabilities.webSearch && "Web",
            model.capabilities.tools && "Tools",
            model.capabilities.thinking && "Think",
            model.capabilities.imageOutput && "Image",
          ]
            .filter(Boolean)
            .map((label) => (
              <span
                key={label as string}
                className="rounded-[5px] bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-fg-muted"
              >
                {label}
              </span>
            ))}
        </div>
        <p className="mt-2 text-[10.5px] text-fg-faint">
          {t("models.unboundHint")}
        </p>
      </InspectorSection>
      <InspectorSection title={t("models.officialPrice")}>
        {pricing ? (
          <>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-fg-faint">{t("models.inputPerMillion")}</div>
                <div className="mt-0.5 tabular-nums text-fg">
                  {money(rate?.input)}
                </div>
              </div>
              <div>
                <div className="text-fg-faint">{t("models.outputPerMillion")}</div>
                <div className="mt-0.5 tabular-nums text-fg">
                  {money(rate?.output)}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[10.5px] text-fg-faint">
              {pricing.currency === "USD"
                ? "官方 USD 价格"
                : "官方原币价格；当前界面未配置换算汇率"}{" "}
              ·{" "}
              {pricing.tiers.length > 1
                ? t("models.tierStep", { count: pricing.tiers.length })
                : t("models.singleTier")}
              {pricing.windows?.length
                ? t("models.windowRules", { count: pricing.windows.length })
                : ""}
            </p>
            <p className="mt-1 truncate text-[10px] text-fg-faint">
              {t("models.sourceFetched", { source: pricing.source, date: pricing.fetchedAt })}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-fg-faint">
            {t("models.noOfficialPrice")}
          </p>
        )}
      </InspectorSection>
      <div className="rounded-[8px] border border-border bg-surface-sunken/50 px-2.5 py-2 text-[10.5px] leading-[1.5] text-fg-faint">
        连接状态：未配置 · 该模型仍会保留在官方目录中，不会因为尚未配置 Provider
        而消失。
      </div>
    </div>
  );
}
function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="border-t border-hairline pt-3">
      <h4 className="mb-2 text-[11.5px] text-fg-faint">{title}</h4>
      {children}
    </section>
  );
}
function Capability({
  icon,
  label,
  value,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-icon">{icon}</span>
      <span className="min-w-0 flex-1 text-[11.5px] text-fg-muted">
        {label}
      </span>
      <Toggle checked={value} onChange={onChange} label={label} />
    </div>
  );
}
function UsageTab(): ReactNode {
  const { t } = useI18n();
  return (
    <>
      <SettingGroup title={t("models.usageAndCost")}>
        <TodoRow
          title="总费用 / 总请求 / 成功率 / 平均延迟"
          description="费用按原币与 USD 估值分别汇总，历史记录冻结当时汇率。"
          step="未接:usage:getSummary"
        />
        <TodoRow
          title="请求日志"
          description="一次 HTTP 尝试记一条，可追溯命中的定价档位与时段规则。"
          step="未接:usage:getRequestLogs"
        />
        <TodoRow
          title="模型 / 供应商统计"
          description="按时间范围查看模型、供应商和币种维度的成本。"
          step="未接:usage:getModelStats"
          last
        />
      </SettingGroup>
      <PricingTable />
    </>
  );
}
