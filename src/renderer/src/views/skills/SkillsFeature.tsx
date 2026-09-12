import {
  ArrowLeft,
  Check,
  CircleAlert,
  Folder,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SkillInstallScope, SkillListItem } from '../../../../shared/domain/skill'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { IconButton } from '../../components/ui/IconButton'
import { Segmented } from '../../components/ui/Segmented'
import { Select } from '../../components/ui/Select'
import { TextInput } from '../../components/ui/TextInput'
import { Toggle } from '../../components/ui/Toggle'
import { cn } from '../../lib/cn'
import { IS_MAC } from '../../lib/platform'
import { useI18n, type Translate } from '../../i18n'
import { useWindowStore } from '../../stores/window'
import { useSkillsStore } from '../../stores/skills'
import {
  getSkillMarketDetail,
  installMarketSkill,
  installSkillZip,
  listSkillMarket,
  listSkillMarketCategories,
  pickSkillZip,
  uninstallSkill
} from '../../services/skills'
import type { SkillMarketItem } from '../../../../shared/domain/skill'
import { useSkillInWorkspace } from './use-skill'

type ViewMode = 'market' | 'mine'
type ScopeFilter = 'all' | SkillInstallScope
type StatusFilter = 'all' | 'active' | 'enabled' | 'inactive' | 'untriggered'

export function SkillsFeature({
  onClose,
  chromeless = false
}: {
  onClose?: () => void
  /**
   * 嵌在扩展面板里时为 true —— 去掉自己的返回按钮和标题，只留右侧那三颗
   * Skill 专属的操作按钮。外层已经画了同样一条 header，不去掉就是两条。
   */
  chromeless?: boolean
}): ReactNode {
  const { t } = useI18n()
  const skillError = (error: unknown): string => {
    const key = error instanceof Error ? error.message : ''
    const known = [
      'skills.authRequired',
      'skills.clientAssetsUnavailable',
      'skills.scopeRequired',
      'skills.versionUnavailable',
      'skills.networkFailed',
      'skills.digestMismatch',
      'skills.packageTooLarge'
    ] as const
    return (known as readonly string[]).includes(key)
      ? t(key as (typeof known)[number])
      : t('skills.operationFailed')
  }
  const workspaceId = useWindowStore((state) => state.activeWorkspaceId)
  const items = useSkillsStore((state) => state.items)
  const diagnostics = useSkillsStore((state) => state.diagnostics)
  const loading = useSkillsStore((state) => state.loading)
  const storeError = useSkillsStore((state) => state.error)
  const load = useSkillsStore((state) => state.load)
  const toggleGlobal = useSkillsStore((state) => state.toggleGlobal)
  const toggleWorkspace = useSkillsStore((state) => state.toggleWorkspace)
  const [view, setView] = useState<ViewMode>('market')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<SkillListItem | null>(null)
  const [marketDetail, setMarketDetail] = useState<SkillMarketItem | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [installScope, setInstallScope] = useState<SkillInstallScope>('global')
  const [marketItems, setMarketItems] = useState<SkillListItem[]>([])
  const [marketCategories, setMarketCategories] = useState<string[]>([])
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState(false)
  const [marketNonce, setMarketNonce] = useState(0)

  const refresh = (): void => {
    void load(workspaceId)
  }

  useEffect(() => {
    refresh()
  }, [workspaceId])

  useEffect(() => {
    if (storeError !== null)
      setError(
        t(
          storeError === 'skills.diagnosticsFailed'
            ? 'skills.diagnosticsFailed'
            : 'skills.loadFailed'
        )
      )
  }, [storeError, t])
  useEffect(() => {
    if (view !== 'market' || selected === null) {
      setMarketDetail(null)
      return
    }
    let alive = true
    void getSkillMarketDetail(selected.id)
      .then((detail) => {
        if (alive) setMarketDetail(detail)
      })
      .catch(() => {
        if (alive) setMarketDetail(null)
      })
    return () => {
      alive = false
    }
  }, [selected, view])

  useEffect(() => {
    if (view !== 'market') return
    let alive = true
    setMarketLoading(true)
    setMarketError(false)
    void Promise.all([
      listSkillMarket(query.trim() || undefined, category || undefined),
      listSkillMarketCategories()
    ])
      .then(([market, categories]) => {
        if (!alive) return
        setMarketItems(
          market.map((item) => ({
            id: item.slug,
            name: item.name,
            ...(item.displayName ? { displayName: item.displayName } : {}),
            ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
            description: item.description,
            category: item.category,
            ...(item.author ? { author: item.author } : {}),
            sourceKind: 'zip',
            globalEnabled: false,
            activeInWorkspace: false,
            ...(item.version ? { version: item.version } : {}),
            ...(item.sha256 ? { sha256: item.sha256 } : {}),
            ...(item.downloadCount !== undefined ? { downloadCount: item.downloadCount } : {})
          }))
        )
        setMarketCategories(categories.filter(Boolean))
      })
      .catch(() => {
        if (alive) setMarketError(true)
      })
      .finally(() => {
        if (alive) setMarketLoading(false)
      })
    return () => {
      alive = false
    }
  }, [category, marketNonce, query, view])

  const categories = useMemo(
    () => [
      ...new Set(
        (view === 'market' ? marketCategories.map((category) => ({ category })) : items)
          .map((item) => item.category)
          .filter(Boolean)
      )
    ],
    [items, marketCategories, view]
  )
  const sourceItems = view === 'market' ? marketItems : items
  const selectedInstalled = selected !== null && items.some((item) => item.name === selected.name)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return sourceItems.filter((item) => {
      if (view === 'mine' && item.sourceKind === 'builtin') return false
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return `${item.name} ${item.description} ${item.category}`
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [category, query, sourceItems, view])
  const mineItems = useMemo(() => items.filter((item) => item.sourceKind !== 'builtin'), [items])
  const mineFiltered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return mineItems.filter((item) => {
      if (scopeFilter !== 'all' && (item.scope ?? 'global') !== scopeFilter) {
        return false
      }
      if (statusFilter === 'active' && !item.activeInWorkspace) return false
      if (statusFilter === 'enabled' && !item.globalEnabled) return false
      if (statusFilter === 'inactive' && item.activeInWorkspace) return false
      if (statusFilter === 'untriggered' && (item.usageCount ?? 0) > 0) {
        return false
      }
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return `${item.name} ${item.displayName ?? ''} ${item.description} ${item.category}`
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [category, mineItems, query, scopeFilter, statusFilter])
  const recentMineCount = mineItems.filter(
    (item) =>
      item.lastUsedAt !== undefined && item.lastUsedAt >= Date.now() - 30 * 24 * 60 * 60 * 1000
  ).length
  const untriggeredMineCount = mineItems.filter((item) => (item.usageCount ?? 0) === 0).length
  const activeMineCount = mineItems.filter(
    (item) => item.activeInWorkspace && item.globalEnabled
  ).length
  const issueMineCount =
    mineItems.filter((item) => (item.diagnostics?.length ?? 0) > 0).length + diagnostics.length
  const contextChars = mineItems
    .filter((item) => item.activeInWorkspace && item.globalEnabled)
    .reduce((total, item) => total + item.name.length + item.description.length, 0)
  const contextPercent = Math.min(100, Math.round((contextChars / 15000) * 100))

  const updateGlobal = async (item: SkillListItem): Promise<void> => {
    setBusy(`${item.id}:global`)
    try {
      await toggleGlobal(item.id)
    } catch {
      setError(t('skills.operationFailed'))
    } finally {
      setBusy(null)
    }
  }

  const updateWorkspace = async (item: SkillListItem): Promise<void> => {
    if (workspaceId === null) return
    setBusy(`${item.id}:workspace`)
    try {
      await toggleWorkspace(item.id)
    } catch {
      setError(t('skills.operationFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header
        className={cn(
          'app-drag flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4',
          !chromeless && !IS_MAC && 'pr-window-controls'
        )}
      >
        {!chromeless && (
          <>
            <IconButton
              label={t('skills.back')}
              size={28}
              width={40}
              onClick={onClose}
              className="rounded-pill bg-tint"
            >
              <ArrowLeft size={15} />
            </IconButton>
            <h1 className="text-[14px] font-medium text-fg">{t('skills.title')}</h1>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={refresh} disabled={loading}>
            {t('common.refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => setInstallScope((scope) => (scope === 'global' ? 'project' : 'global'))}
          >
            {installScope === 'global' ? t('skills.global') : t('skills.project')}
          </Button>
          <Button
            size="sm"
            icon={<Package size={13} />}
            onClick={() => {
              void pickSkillZip().then(
                (picked) =>
                  picked &&
                  installSkillZip(picked.path, workspaceId ?? undefined, installScope)
                    .then(refresh)
                    .catch((error: unknown) => setError(skillError(error)))
              )
            }}
          >
            {t('skills.install')}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-[1080px]">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={view}
              onChange={(mode) => {
                setView(mode)
                setCategory('')
                setScopeFilter('all')
                setStatusFilter('all')
              }}
              shape="pill"
              label={t('skills.viewMode')}
              options={(['market', 'mine'] as const).map((mode) => ({
                value: mode,
                label: (
                  <>
                    {t(mode === 'market' ? 'skills.market' : 'skills.mine')}
                    <span className="ml-1 text-fg-faint tabular-nums">
                      {mode === 'market'
                        ? marketItems.length
                        : items.filter((x) => x.sourceKind !== 'builtin').length}
                    </span>
                  </>
                )
              }))}
            />
            <TextInput
              value={query}
              onChange={setQuery}
              ariaLabel={t('skills.search')}
              placeholder={t('skills.searchPlaceholder')}
              icon={<Search size={14} />}
              className="ml-auto w-[260px]"
            />
          </div>
          {view === 'market' && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCategory('')}
                className={cn(
                  'skills-category rounded-pill px-3 py-1.5 text-[12px] transition-[background-color,color,translate] duration-150 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:translate-y-0 motion-reduce:hover:translate-y-0',
                  category === ''
                    ? 'bg-accent text-accent-fg'
                    : 'bg-tint text-fg-muted hover:bg-tint-hover hover:text-fg'
                )}
                aria-pressed={category === ''}
              >
                {t('skills.all')}
              </button>
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setCategory(name)}
                  className={cn(
                    'skills-category rounded-pill px-3 py-1.5 text-[12px] transition-[background-color,color,translate] duration-150 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:translate-y-0 motion-reduce:hover:translate-y-0',
                    category === name
                      ? 'bg-accent text-accent-fg'
                      : 'bg-tint text-fg-muted hover:bg-tint-hover hover:text-fg'
                  )}
                  aria-pressed={category === name}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <div key={view} className="skills-view-enter">
            {view === 'mine' && (
              <MineDashboard
                items={mineItems}
                filtered={mineFiltered}
                diagnostics={diagnostics}
                scopeFilter={scopeFilter}
                statusFilter={statusFilter}
                category={category}
                categories={categories}
                contextPercent={contextPercent}
                recentCount={recentMineCount}
                issueCount={issueMineCount}
                activeCount={activeMineCount}
                untriggeredCount={untriggeredMineCount}
                onScopeChange={setScopeFilter}
                onStatusChange={setStatusFilter}
                onCategoryChange={setCategory}
                onDetails={setSelected}
                onGlobal={(item) => void updateGlobal(item)}
                onWorkspace={(item) => void updateWorkspace(item)}
                busy={busy}
                t={t}
              />
            )}
            {error !== null && (
              <div className="mt-4 rounded-[10px] border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                {error}
              </div>
            )}
            {view === 'market' && marketError && (
              <div className="mt-4 rounded-[10px] border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                {t('skills.marketLoadFailed')}
                <Button
                  size="sm"
                  className="ml-2"
                  onClick={() => setMarketNonce((value) => value + 1)}
                >
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {view === 'market' &&
              (marketLoading ? (
                <div className="py-14 text-center text-[13px] text-fg-faint">
                  {t('common.loading')}
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-14 text-center text-[13px] text-fg-faint">
                  {t('skills.empty')}
                </div>
              ) : (
                <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {filtered.map((item, index) => (
                    <SkillCard
                      key={item.id}
                      index={index}
                      item={
                        view === 'market'
                          ? {
                              ...item,
                              globalEnabled: items.some((local) => local.name === item.name)
                            }
                          : item
                      }
                      busy={busy}
                      onGlobal={() => void updateGlobal(item)}
                      onWorkspace={() => void updateWorkspace(item)}
                      onDetails={() => setSelected(item)}
                      onInstall={
                        view === 'market' && !items.some((local) => local.name === item.name)
                          ? () => {
                              void installMarketSkill(
                                item.id,
                                item.version,
                                workspaceId ?? undefined,
                                installScope
                              )
                                .then(refresh)
                                .catch((error: unknown) => setError(skillError(error)))
                            }
                          : undefined
                      }
                      t={t}
                    />
                  ))}
                </div>
              ))}
          </div>
        </div>
      </div>
      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.displayName ?? selected?.name ?? ''}
        description={selected?.description}
        footer={
          <>
            {selected !== null &&
              (view === 'market' && !selectedInstalled ? (
                <Button
                  variant="accent"
                  disabled={marketDetail === null}
                  onClick={() => {
                    void installMarketSkill(
                      selected.id,
                      marketDetail?.version,
                      workspaceId ?? undefined,
                      installScope
                    )
                      .then(() => {
                        setSelected(null)
                        refresh()
                      })
                      .catch((error: unknown) => setError(skillError(error)))
                  }}
                >
                  {t('skills.install')}
                </Button>
              ) : (
                <>
                  <Button variant="danger" onClick={() => setConfirmUninstall(true)}>
                    {t('skills.uninstall')}
                  </Button>
                  {workspaceId !== null && (
                    <Button
                      variant="accent"
                      disabled={!!selected.unavailableReason}
                      onClick={() => {
                        void useSkillInWorkspace(workspaceId, selected.name).then((opened) => {
                          if (!opened) return
                          setSelected(null)
                          onClose?.()
                        })
                      }}
                    >
                      {t('skills.use')}
                    </Button>
                  )}
                </>
              ))}
            <Button variant="ghost" onClick={() => setSelected(null)}>
              {t('common.done')}
            </Button>
          </>
        }
      >
        {selected !== null && (
          <div className="space-y-3 text-[12px] text-fg-muted">
            <div className="rounded-[10px] bg-tint p-3">
              <div className="flex items-center justify-between">
                <span>{t('skills.status')}</span>
                <span className="text-fg">
                  {marketDetail && !selectedInstalled
                    ? t('skills.notInstalled')
                    : selected.globalEnabled
                      ? t('skills.installed')
                      : t('skills.notInstalled')}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>{t('skills.source')}</span>
                <span className="text-fg">{marketDetail?.author ?? selected.sourceKind}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>{t('skills.scopeLabel')}</span>
                <span className="text-fg">{selected.scope ?? t('skills.global')}</span>
              </div>
              {(marketDetail?.version ?? selected.version) && (
                <div className="mt-2 flex items-center justify-between">
                  <span>{t('skills.version')}</span>
                  <span className="font-mono text-[11px] text-fg">
                    {marketDetail?.version ?? selected.version}
                  </span>
                </div>
              )}
              {selected.sourcePath && (
                <div
                  className="mt-2 truncate text-[11px] text-fg-faint"
                  title={selected.sourcePath}
                >
                  {selected.sourcePath}
                </div>
              )}
              {selected.usageCount !== undefined && (
                <div className="mt-2 flex items-center justify-between">
                  <span>{t('skills.usage')}</span>
                  <span className="text-fg">{selected.usageCount}</span>
                </div>
              )}
              {selected.lastUsedAt !== undefined && (
                <div className="mt-2 flex items-center justify-between">
                  <span>{t('skills.lastUsed')}</span>
                  <span className="text-fg">{new Date(selected.lastUsedAt).toLocaleString()}</span>
                </div>
              )}
              {marketDetail?.downloadCount !== undefined && (
                <div className="mt-2 flex items-center justify-between">
                  <span>{t('skills.downloads')}</span>
                  <span className="text-fg">{marketDetail.downloadCount}</span>
                </div>
              )}
            </div>
            {selected.unavailableReason ? (
              <p role="status" className="text-danger">
                {t('ssh.skillClientAssets')}
              </p>
            ) : (
              <div className="flex items-center gap-2 text-success">
                <ShieldCheck size={14} />
                {t('skills.healthOk')}
              </div>
            )}
            {selected.diagnostics && selected.diagnostics.length > 0 && (
              <div className="rounded-[8px] border border-danger/30 bg-danger/5 p-2 text-danger">
                {selected.diagnostics.join(' · ')}
              </div>
            )}
            <p>{t('skills.detailHint')}</p>
          </div>
        )}
      </Dialog>
      <Dialog
        open={confirmUninstall}
        onClose={() => setConfirmUninstall(false)}
        title={t('skills.confirmUninstall')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUninstall(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!selected) return
                void uninstallSkill(
                  selected.id,
                  workspaceId ?? undefined,
                  selected.scope === 'project' ? 'project' : 'global'
                )
                  .then(() => {
                    setConfirmUninstall(false)
                    setSelected(null)
                    refresh()
                  })
                  .catch((error: unknown) => setError(skillError(error)))
              }}
            >
              {t('skills.uninstall')}
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-fg-muted">{t('skills.confirmUninstallHint')}</p>
      </Dialog>
    </div>
  )
}

function MineDashboard({
  items,
  filtered,
  diagnostics,
  scopeFilter,
  statusFilter,
  category,
  categories,
  contextPercent,
  recentCount,
  issueCount,
  activeCount,
  untriggeredCount,
  onScopeChange,
  onStatusChange,
  onCategoryChange,
  onDetails,
  onGlobal,
  onWorkspace,
  busy,
  t
}: {
  items: SkillListItem[]
  filtered: SkillListItem[]
  diagnostics: Array<{ path: string; message: string }>
  scopeFilter: ScopeFilter
  statusFilter: StatusFilter
  category: string
  categories: string[]
  contextPercent: number
  recentCount: number
  issueCount: number
  activeCount: number
  untriggeredCount: number
  onScopeChange: (value: ScopeFilter) => void
  onStatusChange: (value: StatusFilter) => void
  onCategoryChange: (value: string) => void
  onDetails: (item: SkillListItem) => void
  onGlobal: (item: SkillListItem) => void
  onWorkspace: (item: SkillListItem) => void
  busy: string | null
  t: Translate
}): ReactNode {
  const scopeOptions = [
    { value: 'all', label: t('skills.scopeAll') },
    { value: 'global', label: t('skills.global') },
    { value: 'project', label: t('skills.project') }
  ] as const
  const statusOptions = [
    { value: 'all', label: t('skills.statusAll') },
    { value: 'active', label: t('skills.statusActive') },
    { value: 'enabled', label: t('skills.statusEnabled') },
    { value: 'inactive', label: t('skills.statusInactive') },
    { value: 'untriggered', label: t('skills.statusUntriggered') }
  ] as const
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <MineStat
          value={items.length}
          label={t('skills.totalSkills')}
          hint={t('skills.totalSkillsHint')}
        />
        <MineStat
          value={recentCount}
          label={t('skills.recentActive')}
          hint={t('skills.recentActiveHint')}
        />
        <MineStat
          value={untriggeredCount}
          label={t('skills.activeSkills')}
          hint={t('skills.activeSkillsHint')}
        />
        <MineStat
          value={issueCount}
          label={t('skills.issueSkills')}
          hint={t('skills.issueSkillsHint')}
          tone={issueCount > 0 ? 'danger' : 'default'}
        />
      </div>
      <div className="max-w-[330px] rounded-[14px] border border-hairline bg-surface p-3.5">
        <div className="flex items-center justify-between text-[12px] font-medium text-fg">
          <span>{t('skills.contextUsage')}</span>
          <span>{contextPercent}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-tint">
          <div
            className="h-full rounded-pill bg-accent transition-[width] duration-500"
            style={{ width: `${contextPercent}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-fg-faint">
          {t('skills.contextUsageHint', { active: activeCount, total: items.length })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={scopeFilter}
          onChange={onScopeChange}
          size="sm"
          label={t('skills.scopeFilter')}
          options={scopeOptions}
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => onStatusChange(value as StatusFilter)}
          ariaLabel={t('skills.statusFilter')}
          options={statusOptions}
          className="w-[132px]"
        />
        <Select
          value={category}
          onValueChange={onCategoryChange}
          ariaLabel={t('skills.categoryFilter')}
          options={[
            { value: '', label: t('skills.allCategories') },
            ...categories.map((value) => ({ value, label: value }))
          ]}
          className="w-[150px]"
        />
        {diagnostics.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-pill bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
            <CircleAlert size={12} />
            {t('skills.diagnosticsCount', { count: diagnostics.length })}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-[14px] border border-hairline bg-surface">
        <div className="hidden grid-cols-[minmax(250px,1.8fr)_130px_130px_90px_110px_82px] gap-3 border-b border-hairline px-3 py-2 text-[11px] text-fg-faint xl:grid">
          <span>{t('skills.tableSkill')}</span>
          <span>{t('skills.scopeLabel')}</span>
          <span>{t('skills.workspaceStatus')}</span>
          <span>{t('skills.triggerCount')}</span>
          <span>{t('skills.lastUsed')}</span>
          <span className="text-right">{t('skills.actions')}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-4 py-14 text-center text-[13px] text-fg-faint">
            {t('skills.empty')}
          </div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="grid gap-3 border-b border-hairline px-3 py-3 last:border-b-0 xl:grid-cols-[minmax(250px,1.8fr)_130px_130px_90px_110px_82px] xl:items-center"
            >
              <button type="button" className="min-w-0 text-left" onClick={() => onDetails(item)}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">
                    {item.displayName ?? item.name}
                  </span>
                  {(item.diagnostics?.length ?? 0) > 0 && (
                    <span className="rounded-pill bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                      {t('skills.needsAttention')}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-[11px] text-fg-muted">{item.description}</p>
              </button>
              <span className="inline-flex w-fit items-center gap-1 rounded-[6px] bg-tint px-2 py-1 text-[11px] text-fg-muted">
                <Folder size={11} />
                {item.scope === 'project' ? t('skills.project') : t('skills.global')}
              </span>
              <div className="flex items-center gap-2">
                <Toggle
                  checked={item.activeInWorkspace}
                  onChange={() => onWorkspace(item)}
                  disabled={busy !== null || !!item.unavailableReason}
                  label={t('skills.workspaceToggle')}
                />
                <span className="text-[11px] text-fg-muted">
                  {item.unavailableReason
                    ? t('ssh.skillUnavailable')
                    : item.activeInWorkspace
                      ? t('skills.active')
                      : t('skills.inactive')}
                </span>
              </div>
              <span className="text-[13px] font-medium tabular-nums text-fg">
                {item.usageCount ?? 0}
              </span>
              <span className="text-[11px] text-fg-faint">
                {item.lastUsedAt
                  ? new Date(item.lastUsedAt).toLocaleDateString()
                  : t('skills.neverUsed')}
              </span>
              <div className="flex items-center justify-end gap-1">
                <IconButton
                  label={t('skills.openDetails')}
                  size={26}
                  onClick={() => onDetails(item)}
                >
                  <Pencil size={12} />
                </IconButton>
                <Toggle
                  checked={item.globalEnabled}
                  onChange={() => onGlobal(item)}
                  disabled={busy !== null}
                  label={t('skills.globalToggle')}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function MineStat({
  value,
  label,
  hint,
  tone = 'default'
}: {
  value: number
  label: string
  hint: string
  tone?: 'default' | 'danger'
}): ReactNode {
  return (
    <div className="rounded-[14px] border border-hairline bg-surface p-3.5">
      <div
        className={cn(
          'text-[24px] font-semibold leading-none tabular-nums',
          tone === 'danger' ? 'text-danger' : 'text-fg'
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[12px] font-medium text-fg">{label}</div>
      <div className="mt-1 text-[11px] text-fg-faint">{hint}</div>
    </div>
  )
}

function SkillCard({
  item,
  busy,
  onGlobal,
  onWorkspace,
  onDetails,
  onInstall,
  index,
  t
}: {
  item: SkillListItem
  busy: string | null
  onGlobal: () => void
  onWorkspace: () => void
  onDetails: () => void
  onInstall?: () => void
  index: number
  t: Translate
}): ReactNode {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null)
  return (
    <article
      className="skills-card-enter rounded-[16px] border border-hairline bg-surface p-4 shadow-sm transition-[translate,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${Math.min(index, 7) * 35}ms` }}
    >
      <button type="button" className="block w-full text-left" onClick={onDetails}>
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-tint">
            {item.iconUrl && item.iconUrl !== failedIconUrl ? (
              <img
                src={item.iconUrl}
                alt=""
                className="size-7 rounded-[8px] object-cover"
                onError={() => setFailedIconUrl(item.iconUrl ?? null)}
              />
            ) : (
              <Package size={20} className="text-fg-muted" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[14px] font-medium text-fg">
                {item.displayName ?? item.name}
              </h2>
              {item.globalEnabled && (
                <span className="rounded-pill bg-success/10 px-2 py-0.5 text-[10px] text-success">
                  {t('skills.installed')}
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-fg-muted">
              {item.description}
            </p>
            <p className="mt-2 text-[11px] text-fg-faint">
              {item.name} · {item.category} · {item.author ?? item.sourceKind}
              {item.author ? ` · ${item.author}` : ''}
            </p>
          </div>
        </div>
      </button>
      <div className="mt-4 flex items-center justify-between border-t border-hairline pt-3">
        <div className="flex items-center gap-3 text-[11px] text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck size={13} />
            {item.scope ?? t('skills.global')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Check size={13} />
            {item.activeInWorkspace ? t('skills.active') : t('skills.inactive')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onInstall !== undefined ? (
            <Button size="sm" variant="accent" onClick={onInstall}>
              {t('skills.install')}
            </Button>
          ) : (
            <>
              <Toggle
                checked={item.globalEnabled}
                onChange={onGlobal}
                disabled={busy !== null}
                label={t('skills.globalToggle')}
              />
              <Toggle
                checked={item.activeInWorkspace}
                onChange={onWorkspace}
                disabled={busy !== null || !!item.unavailableReason}
                label={t('skills.workspaceToggle')}
              />
              <Settings2 size={14} className="text-fg-faint" />
            </>
          )}
        </div>
      </div>
    </article>
  )
}
