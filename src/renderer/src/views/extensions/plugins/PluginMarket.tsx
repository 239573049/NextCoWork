/**
 * 插件市场的浏览与安装。
 *
 * ## 这一页最要紧的一件事:**能力写在列表里**
 *
 * 装一个插件这个决定的全部信息量,就是「它要哪几条能力」。把它藏到详情页
 * 或者安装弹窗里,等于让用户**先决定再了解** —— 而那时候他已经在心里点头了。
 * 所以每一条都在卡片上直接列出来,和名字、下载量同一屏。
 *
 * ## 空列表与拉不动是两件事
 *
 * 市场连不上时显示「还没有插件」是一种很具体的误导:用户会以为这个市场是空的,
 * 而不是去检查网络。两种状态在这里有两套文案和一颗重试按钮。
 */
import { AlertTriangle, Download, Puzzle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { PluginMarketItem } from '../../../../../shared/plugin/market'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { TextInput } from '../../../components/ui/TextInput'
import { useI18n } from '../../../i18n'
import { usePluginsStore } from '../../../stores/plugins'

export function PluginMarket(): ReactNode {
  const { t } = useI18n()
  const market = usePluginsStore((state) => state.market)
  const loading = usePluginsStore((state) => state.marketLoading)
  const marketError = usePluginsStore((state) => state.marketError)
  const loadMarket = usePluginsStore((state) => state.loadMarket)
  const installFromMarket = usePluginsStore((state) => state.installFromMarket)
  const catalog = usePluginsStore((state) => state.catalog)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const installed = new Set(catalog.plugins.map((plugin) => plugin.id))

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2">
        <TextInput
          className="w-[260px]"
          value={query}
          onChange={setQuery}
          placeholder={t('plugins.marketSearch')}
          ariaLabel={t('plugins.marketSearch')}
        />
        <Button size="sm" disabled={loading} onClick={() => { void loadMarket({ q: query }) }}>
          {t('common.refresh')}
        </Button>
      </div>

      {error !== null && (
        <div className="mt-3 shrink-0 rounded-[10px] border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {marketError !== null ? (
        <EmptyState
          className="my-auto"
          icon={<AlertTriangle size={26} />}
          title={t('plugins.marketUnavailable')}
          hint={t('plugins.marketUnavailableHint')}
        />
      ) : loading ? (
        <div className="py-14 text-center text-[13px] text-fg-faint">{t('common.loading')}</div>
      ) : market.length === 0 ? (
        <EmptyState className="my-auto" icon={<Puzzle size={26} />} title={t('plugins.marketEmpty')} />
      ) : (
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {market.map((item) => (
            <MarketRow
              key={item.pluginId}
              item={item}
              installed={installed.has(item.pluginId)}
              busy={busy === item.slug}
              onInstall={() => {
                setBusy(item.slug)
                setError(null)
                void installFromMarket(item.slug)
                  .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)) })
                  .finally(() => { setBusy(null) })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MarketRow({
  item,
  installed,
  busy,
  onInstall
}: {
  item: PluginMarketItem
  installed: boolean
  busy: boolean
  onInstall: () => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <article className="flex items-start gap-3 rounded-[10px] border border-hairline px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {/* ★ displayName / pluginId / author 都是**领域值**,不翻译 */}
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{item.displayName}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">{item.pluginId}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-fg-muted">{item.description}</p>
        {item.permissions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {/* ★ 能力就在卡片上 —— 装它的决定信息量全在这一行 */}
            <span className="text-[10.5px] text-fg-faint">{t('plugins.permissions')}</span>
            {item.permissions.map((permission) => (
              <span key={permission} className="rounded-[4px] bg-tint px-1.5 py-px font-mono text-[10.5px] text-fg-muted">
                {permission}
              </span>
            ))}
          </div>
        )}
      </div>
      <Button size="sm" disabled={installed || busy} icon={<Download size={13} />} onClick={onInstall}>
        {installed ? t('plugins.installed') : t('plugins.install')}
      </Button>
    </article>
  )
}
