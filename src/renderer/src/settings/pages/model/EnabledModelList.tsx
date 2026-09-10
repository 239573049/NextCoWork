import { GripVertical, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { PROVIDER_PRESETS } from "../../../../../shared/domain/presets";
import { cn } from "../../../lib/cn";
import { type ProviderEntry } from "./enabled-models";
import { ProviderAvatar } from "./ProviderAvatar";
import { useI18n } from "../../../i18n";

/**
 * 参考图左边那一列。
 *
 * ★ **每一行是一个供应商,不是一个模型**(理由见 `enabled-models.ts` 文件头)。
 *
 * ★ **拖拽把手画出来但是灰的。** 排序要写回 `provider:reorderAliases`,
 * 那条频道还不存在(步骤 4)。给一个能拖、松手后弹回去的把手比不给更糟 ——
 * 用户会以为是自己没拖准。这个做法在 `connection/SearchPane.tsx` 里已经有先例:
 * 用不了的那几家把手压到 30% 不透明度、光标不变手型。
 */
export function EnabledModelList({
  entries,
  loaded,
  selectedId,
  onSelect,
  onAdd,
  footer,
}: {
  entries: readonly ProviderEntry[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /**
   * 参考图在这一列底下放的是「哪个角色用哪个模型」。我们真有的那两个
   * (默认模型 / 默认子代理模型)由 `ModelPage` 塞进来 —— 它们要 `patch()`,
   * 而这个组件不该知道设置是怎么写回去的。
   */
  footer?: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex w-[236px] shrink-0 flex-col">
      <div className="flex items-start gap-2 px-1 pb-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-fg">{t("models.enabledModels")}</p>
          <p className="mt-0.5 text-[11.5px] leading-[1.5] text-fg-faint">{t("models.firstIsDefault")}</p>
        </div>
        <button
          type="button"
          aria-label={t("models.addProvider")}
          onClick={onAdd}
          className={cn(
            "app-no-drag mt-0.5 flex size-6 shrink-0 items-center justify-center",
            "rounded-[7px] text-icon transition-colors hover:bg-tint hover:text-fg",
          )}
        >
          <Plus size={15} />
        </button>
      </div>

      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.provider.id}>
            <button
              type="button"
              onClick={() => onSelect(e.provider.id)}
              aria-current={e.provider.id === selectedId}
              className={cn(
                "app-no-drag flex w-full items-center gap-2 rounded-[9px] px-1.5 py-2 text-left",
                "transition-colors",
                e.provider.id === selectedId ? "bg-tint" : "hover:bg-tint/60",
              )}
            >
              <GripVertical
                size={13}
                className="shrink-0 text-fg-faint opacity-30"
                aria-hidden
              />
              <ProviderAvatar name={e.provider.name} id={e.provider.id} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-[12.5px] text-fg">
                    {e.provider.name}
                  </span>
                  {e.isDefault && (
                    <span className="shrink-0 text-[11px] text-accent">
                      {t("common.default")}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-fg-faint">
                  {e.primaryAlias ?? t("models.unconfigured")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {loaded && entries.length === 0 && (
        <p className="px-1.5 py-3 text-[12px] leading-[1.6] text-fg-faint">
          {t("models.emptyProviders", { count: PROVIDER_PRESETS.length })}
          <Plus size={11} className="mx-0.5 inline align-[-1px]" />
          {t("models.browseProviders")}
        </p>
      )}

      <button
        type="button"
        onClick={onAdd}
        className={cn(
          "app-no-drag mt-1 flex w-full items-center gap-1.5 rounded-[9px] px-1.5 py-2",
          "text-[12.5px] text-fg-muted transition-colors hover:bg-tint/60 hover:text-fg",
        )}
      >
        <Plus size={14} className="shrink-0 text-icon" />
        {t("models.addModel")}
      </button>

      {footer !== undefined && (
        <>
          <div className="my-2 border-t border-hairline" />
          {footer}
        </>
      )}
    </div>
  );
}
