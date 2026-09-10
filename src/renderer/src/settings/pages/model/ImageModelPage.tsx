import { ArrowLeft, Image as ImageIcon, Info, Plus, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ModelAlias, UpstreamProvider } from "../../../../../shared/domain/provider";
import { PROVIDER_PRESETS } from "../../../../../shared/domain/presets";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { TextInput } from "../../../components/ui/TextInput";
import { cn } from "../../../lib/cn";
import { useI18n } from "../../../i18n";
import { useModelsStore } from "../../../stores/models";
import { setProviderAliases, updateModel, upsertProvider } from "../../../services/provider";
import { ProviderAvatar } from "./ProviderAvatar";
import { ProviderPanel } from "./ProviderPanel";
import { providerEntries, type ProviderEntry } from "./enabled-models";
import { providerFromPreset, seedModelsForPreset } from "./provider-edit";

type ImagePreset = {
  id: string;
  name: string;
  models: readonly string[];
  baseUrl?: string;
  hintKey: "models.imageOpenAiHint" | "models.imageGrokHint" | "models.imageGeminiHint" | "models.imageDashscopeHint" | "models.imageGptnbHint" | "models.imageRoutinHint";
  protocol?: UpstreamProvider["protocol"];
  recommended?: boolean;
};

const IMAGE_PRESETS: readonly ImagePreset[] = [
  { id: "openai", name: "OpenAI", models: ["gpt-image-2"], hintKey: "models.imageOpenAiHint", recommended: true },
  { id: "xai", name: "Grok 订阅", models: ["grok-imagine-image", "grok-imagine-image-edit"], hintKey: "models.imageGrokHint" },
  { id: "gemini-openai", name: "Gemini API", models: ["gemini-3.1-flash-image", "gemini-3-pro-image"], hintKey: "models.imageGeminiHint" },
  { id: "dashscope-image", name: "百炼按量 API", models: ["z-image-turbo"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", hintKey: "models.imageDashscopeHint" },
  { id: "gptnb", name: "GPTNB", models: ["gpt-image-2-vip", "gpt-image-2"], baseUrl: "https://api.gptnb.com/v1", hintKey: "models.imageGptnbHint" },
  { id: "routin", name: "RoutinAI", models: ["gpt-image-2"], hintKey: "models.imageRoutinHint" },
];

function isImageModel(model: ModelAlias): boolean {
  return model.modality === "image" || model.capabilities.imageOutput === true;
}

export function ImageModelPage(): ReactNode {
  const { t } = useI18n();
  const providers = useModelsStore((s) => s.providers);
  const models = useModelsStore((s) => s.models);
  const load = useModelsStore((s) => s.load);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(() => providerEntries(
    providers,
    models.filter(isImageModel),
    "",
  ).filter((entry) => entry.aliases.length > 0), [providers, models]);
  const selected = entries.find((entry) => entry.provider.id === selectedId) ?? entries[0] ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-4">
      <ImageProviderList entries={entries} onAdd={() => setCatalogOpen(true)} selectedId={catalogOpen ? null : selected?.provider.id ?? null} onSelect={(id) => { setSelectedId(id); setCatalogOpen(false); }} />
      {catalogOpen ? (
        <ImageProviderCatalog providers={providers} onClose={() => setCatalogOpen(false)} onAdded={(id) => { setSelectedId(id); setCatalogOpen(false); }} />
      ) : selected ? (
        <ProviderPanel
          entry={selected}
          modality="image"
          preserveAliases={models.filter(
            (model) => model.providerId === selected.provider.id && !isImageModel(model),
          )}
        />
      ) : (
        <div className="min-w-0 flex-1 rounded-[12px] border border-border bg-canvas px-3 py-3">
          <div className="mb-3 flex items-start gap-2 rounded-[9px] bg-tint px-3 py-2.5 text-[11.5px] leading-[1.6] text-fg-muted">
            <Info size={14} className="mt-0.5 shrink-0 text-icon" />
            <span>{t("models.imageEmptyHint")}</span>
          </div>
          <EmptyState icon={<ImageIcon size={22} />} title={t("models.imageNoProvider")} hint={t("models.imageAddHint")} />
        </div>
      )}
    </div>
  );
}

function ImageProviderList({ entries, onAdd, selectedId, onSelect }: { entries: readonly ProviderEntry[]; onAdd: () => void; selectedId: string | null; onSelect: (id: string) => void }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex w-[216px] shrink-0 flex-col">
      <div className="flex items-start gap-2 px-1 pb-2">
        <div className="min-w-0 flex-1"><p className="text-[13px] text-fg">{t("models.imageProviders")}</p><p className="mt-0.5 text-[11.5px] leading-[1.5] text-fg-faint">{t("models.firstIsDefault")}</p></div>
        <button type="button" aria-label={t("models.imageAddProvider")} onClick={onAdd} className="mt-0.5 flex size-6 items-center justify-center rounded-[7px] text-icon hover:bg-tint"><Plus size={15} /></button>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {entries.map((entry) => <li key={entry.provider.id}><button type="button" onClick={() => onSelect(entry.provider.id)} className={cn("flex w-full items-center gap-2 rounded-[9px] px-1.5 py-2 text-left", entry.provider.id === selectedId ? "bg-tint" : "hover:bg-tint/60")}><ProviderAvatar name={entry.provider.name} id={entry.provider.id} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] text-fg">{entry.provider.name}</span><span className="mt-0.5 block truncate text-[11.5px] text-fg-faint">{entry.primaryAlias ?? t("models.unconfigured")}</span></span></button></li>)}
      </ul>
      <button type="button" onClick={onAdd} className="mt-1 flex w-full items-center gap-1.5 rounded-[9px] px-1.5 py-2 text-[12.5px] text-fg-muted hover:bg-tint/60"><Plus size={14} />{t("models.imageAddProvider")}</button>
    </div>
  );
}

function ImageProviderCatalog({ providers, onClose, onAdded }: { providers: readonly UpstreamProvider[]; onClose: () => void; onAdded: (id: string) => void }): ReactNode {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const existingModels = useModelsStore((s) => s.models);
  const [custom, setCustom] = useState(false);
  const list = IMAGE_PRESETS.filter((item) => `${item.name} ${t(item.hintKey)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const add = async (item: ImagePreset): Promise<void> => {
    if (providers.some((p) => p.id === item.id)) { onAdded(item.id); return; }
    setBusy(item.id);
    try {
      const preset = PROVIDER_PRESETS.find((p) => p.id === item.id);
      const base = preset === undefined ? { id: item.id, name: item.name, protocol: item.protocol ?? "openai-chat" as const, baseUrl: item.baseUrl ?? "https://api.openai.com/v1", credentialRef: `provider:${item.id}`, priority: 60, enabled: true } : providerFromPreset(preset);
      if (base === null) return;
      await upsertProvider(base);
      const imageIds = item.models.length > 0 ? item.models : seedModelsForPreset(preset!, base.protocol);
      const currentIds = existingModels.filter((model) => model.providerId === item.id).map((model) => model.upstreamModel);
      const aliases = await setProviderAliases(item.id, [...new Set([...currentIds, ...imageIds])]);
      // Model discovery cannot infer modality for private/preview image IDs. Mark
      // models chosen from this image catalogue explicitly so they appear in this tab.
      await Promise.all(aliases.filter((model) => item.models.includes(model.upstreamModel)).map((model) => updateModel({ ...model, modality: "image", capabilities: { ...model.capabilities, textInput: false, textOutput: false, imageOutput: true } })));
      onAdded(item.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-border bg-canvas">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3"><button type="button" aria-label={t("models.backToPresets")} onClick={onClose} className="flex size-6 items-center justify-center rounded-[7px] text-icon hover:bg-tint"><ArrowLeft size={14} /></button><span className="flex-1 text-[13px] text-fg">{t("models.imageAddProvider")}</span><button type="button" aria-label={t("common.close")} onClick={onClose} className="flex size-6 items-center justify-center rounded-[7px] text-icon hover:bg-tint"><X size={14} /></button></div>
      {custom ? <div className="min-h-0 flex-1 overflow-y-auto"><CustomImageProviderForm onCancel={() => setCustom(false)} onAdded={onAdded} /></div> : <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3"><div className="mb-3 flex items-center gap-2 rounded-[9px] bg-tint px-3 py-2.5 text-[11.5px] leading-[1.6] text-fg-muted"><Info size={14} className="shrink-0 text-icon" />{t("models.imageCatalogHint")}</div>{error !== null && <p className="mb-3 rounded-[8px] bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</p>}<div className="mb-3 flex items-center gap-2"><TextInput size="sm" value={query} onChange={setQuery} placeholder={t("models.searchProvider")} ariaLabel={t("models.searchProviderLabel")} icon={<Search size={13} />} /><button type="button" onClick={() => setCustom(true)} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] bg-tint px-2.5 text-[11.5px] text-fg"><Settings2 size={13} />{t("models.customProvider")}</button></div><div className="grid grid-cols-2 gap-2">{list.map((item) => { const added = providers.some((p) => p.id === item.id); return <button key={item.id} type="button" disabled={added || busy !== null} onClick={() => void add(item)} className={cn("min-w-0 rounded-[12px] border border-border px-3 py-2.5 text-left transition-colors", added ? "bg-tint/60 opacity-70" : "hover:bg-tint")}><div className="flex items-center gap-2"><ProviderAvatar name={item.name} id={item.id} size="sm" /><span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{item.name}</span>{item.recommended && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{t("models.recommended")}</span>}</div><p className="mt-1 truncate text-[11px] text-fg-muted">{item.models.join(" / ")}</p><p className="mt-1 truncate text-[10.5px] text-fg-faint">{added ? t("models.added") : t(item.hintKey)}</p></button>; })}</div></div>}
    </div>
  );
}

function CustomImageProviderForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: (id: string) => void }): ReactNode {
  const { t } = useI18n();
  const [name, setName] = useState(""); const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => { const id = `image-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"}`; if (!name.trim() || !baseUrl.trim() || !model.trim()) return; setBusy(true); setError(null); try { await upsertProvider({ id, name: name.trim(), baseUrl: baseUrl.trim(), protocol: "openai-chat", credentialRef: `provider:${id}`, priority: 60, enabled: true }); const aliases = await setProviderAliases(id, [model.trim()]); await Promise.all(aliases.map((entry) => updateModel({ ...entry, modality: "image", capabilities: { ...entry.capabilities, textInput: false, textOutput: false, imageOutput: true } }))); onAdded(id); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <div className="space-y-3 px-4 py-4"><p className="text-[12px] leading-[1.6] text-fg-muted">{t("models.imageCustomHint")}</p>{error !== null && <p className="rounded-[8px] bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</p>}<label className="block text-[11.5px] text-fg-muted">{t("provider.name")}<TextInput value={name} onChange={setName} ariaLabel={t("provider.name")} /></label><label className="block text-[11.5px] text-fg-muted">{t("provider.apiAddress")}<TextInput value={baseUrl} onChange={setBaseUrl} ariaLabel={t("provider.apiAddress")} inputMode="url" /></label><label className="block text-[11.5px] text-fg-muted">{t("provider.modelIdLabel")}<TextInput value={model} onChange={setModel} ariaLabel={t("provider.modelIdLabel")} /></label><div className="flex justify-end gap-2"><Button size="sm" onClick={onCancel}>{t("common.cancel")}</Button><Button size="sm" variant="accent" disabled={busy} onClick={() => void submit()}>{t("common.save")}</Button></div></div>;
}
