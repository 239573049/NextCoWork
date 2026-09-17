/**
 * 插件管理页 —— 装 / 启 / 禁 / 卸,加上能力批准、诊断与活动日志。
 *
 * ★ 落在**扩展页**里当第五类资源,而不是另开一个顶层入口:扩展页装的正是
 * 「用户装上来的东西」,Skill / 命令 / 子代理 / 模式 / 钩子已经在那儿了。
 * 插件和它们的区别是带代码,但对用户来说它们回答的是同一个问题:
 * 「我这台机器上多装了什么」。
 *
 * ★ 这一页**不渲染任何插件提供的 HTML**。它显示的全是清单里的声明值
 * (名字、作者、版本、能力、贡献点)和宿主自己的记录(诊断、活动)——
 * 插件的 UI 只出现在受控 webview 里,那是另一期的事。
 */
import { AlertTriangle, Package, Puzzle, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { InstalledPlugin, PluginStatus } from '../../../../../shared/plugin/state'
import type { PluginPermission } from '../../../../../shared/plugin/permission'
import { Button } from '../../../components/ui/Button'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Segmented } from '../../../components/ui/Segmented'
import { Toggle } from '../../../components/ui/Toggle'
import { useI18n, type TranslationKey } from '../../../i18n'
import { cn } from '../../../lib/cn'
import { on } from '../../../services/ipc'
import { usePluginsStore } from '../../../stores/plugins'
import { PluginConfiguration } from './PluginConfiguration'
import { PluginMarket } from './PluginMarket'
import { pluginErrorKey } from './plugin-error'

const STATUS_KEY: Record<PluginStatus, TranslationKey> = {
  idle: 'plugins.status.idle',
  activating: 'plugins.status.activating',
  active: 'plugins.status.active',
  asleep: 'plugins.status.asleep',
  disabled: 'plugins.status.disabled',
  'pending-approval': 'plugins.status.pendingApproval',
  error: 'plugins.status.error'
}

/**
 * 状态的颜色。
 *
 * ★ 只有**三种**颜色,不是七种:运行中(绿)、需要你处理(琥珀)、其余(faint)。
 *   七种状态各给一个颜色的结果是没有一种颜色有意义 —— 用户没法从颜色读出
 *   「我现在要不要做点什么」,而那正是他扫这一列时唯一想知道的事。
 *
 * ★ 待批准用琥珀而不是红:它不是错误,是一件**等着你点头**的事。
 *   红色会让用户以为插件坏了,从而躲开一次本来正常的授权。
 */
const STATUS_TONE: Record<PluginStatus, string> = {
  idle: 'bg-fg-faint/50',
  activating: 'bg-accent animate-pulse',
  active: 'bg-accent',
  asleep: 'bg-fg-faint/50',
  disabled: 'bg-fg-faint/30',
  'pending-approval': 'bg-warning',
  error: 'bg-danger'
}

export function PluginsPanel(): ReactNode {
  const { t } = useI18n()
  const catalog = usePluginsStore((state) => state.catalog)
  const load = usePluginsStore((state) => state.load)
  const install = usePluginsStore((state) => state.installFromPicker)
  const loadMarket = usePluginsStore((state) => state.loadMarket)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'installed' | 'market'>('installed')

  useEffect(() => {
    // 市场列表**按需拉**:没打开那一栏的用户不该为它付一次网络往返。
    if (view === 'market') void loadMarket()
  }, [view, loadMarket])

  useEffect(() => {
    void load()
    // 主进程装/卸/激活之后推 `plugins:changed`,收到就整份重取。
    // ★ 退订必须发生 —— 不退订的话 HMR 会叠加监听器(方案 §3 规则 4)。
    return on('plugins:changed', () => { void load() })
  }, [load])

  const selected = catalog.plugins.find((plugin) => plugin.id === selectedId) ?? catalog.plugins[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5">
      <div className="mx-auto flex min-h-0 w-full max-w-[1080px] flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium text-fg">{t('plugins.title')}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-faint">{t('plugins.description')}</p>
          </div>
          <Segmented
            className="ml-3"
            size="sm"
            value={view}
            onChange={setView}
            label={t('plugins.title')}
            options={[
              { value: 'installed', label: t('plugins.tab.installed') },
              { value: 'market', label: t('plugins.tab.market') }
            ]}
          />
          <Button
            className="ml-auto"
            size="sm"
            icon={<Package size={13} />}
            onClick={() => {
              setError(null)
              void install().catch((cause: unknown) => {
                setError(t('plugins.installFailed', { error: t(pluginErrorKey(cause)) }))
              })
            }}
          >
            {t('plugins.install')}
          </Button>
        </div>

        {error !== null && (
          <div className="mt-4 shrink-0 rounded-[10px] border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        {view === 'market' ? (
          <PluginMarket />
        ) : catalog.plugins.length === 0 ? (
          <EmptyState
            className="my-auto"
            icon={<Puzzle size={26} />}
            title={t('plugins.empty')}
            hint={t('plugins.emptyHint')}
          />
        ) : (
          <div className="mt-4 flex min-h-0 flex-1 gap-4">
            <div className="w-[280px] shrink-0 space-y-1 overflow-y-auto pr-1">
              {catalog.plugins.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() => setSelectedId(plugin.id)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left transition-colors',
                    plugin.id === selected?.id ? 'bg-tint-strong text-fg' : 'text-fg-muted hover:bg-tint-hover hover:text-fg'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                    {/* 状态点在名字**前面**:扫一列的时候眼睛走的是左边那条竖线 */}
                    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_TONE[plugin.status])} />
                    <span className="min-w-0 truncate">{plugin.manifest.displayName}</span>
                    {plugin.status === 'error' && <AlertTriangle size={12} className="shrink-0 text-danger" />}
                  </span>
                  <span className="pl-3 text-[11px] text-fg-faint">{t(STATUS_KEY[plugin.status])}</span>
                </button>
              ))}
            </div>
            {selected !== undefined && <PluginDetail plugin={selected} />}
          </div>
        )}
      </div>
    </div>
  )
}

function PluginDetail({ plugin }: { plugin: InstalledPlugin }): ReactNode {
  const { t } = useI18n()
  const setEnabled = usePluginsStore((state) => state.setEnabled)
  const uninstall = usePluginsStore((state) => state.uninstall)
  const grant = usePluginsStore((state) => state.grant)
  const revoke = usePluginsStore((state) => state.revoke)
  const activity = usePluginsStore((state) => state.activity)
  const loadActivity = usePluginsStore((state) => state.loadActivity)
  const [tab, setTab] = useState<'overview' | 'activity'>('overview')

  useEffect(() => {
    if (tab === 'activity') void loadActivity(plugin.id)
  }, [tab, plugin.id, loadActivity])

  const declared = [...plugin.permissions.required, ...plugin.permissions.optional]
  const granted = new Set(plugin.permissions.granted)

  return (
    <div className="min-w-0 flex-1 overflow-y-auto rounded-[12px] border border-hairline p-4">
      <div className="flex items-start gap-3">
        {/* 图标块与 web 详情页同一个形状 —— 同一个插件在两处看起来要像同一个东西 */}
        <div className="grid size-11 shrink-0 place-items-center rounded-[12px] border border-hairline bg-tint text-fg-faint">
          <Puzzle size={20} />
        </div>
        <div className="min-w-0 flex-1">
          {/* ★ displayName / publisher / version 是**领域值,不翻译** —— 同主题名的处理 */}
          <h3 className="truncate text-[15px] font-medium text-fg">{plugin.manifest.displayName}</h3>
          <p className="mt-0.5 text-[12px] text-fg-faint">
            {t('plugins.publisher', { publisher: plugin.manifest.publisher })} ·{' '}
            {t('plugins.version', { version: plugin.manifest.version })}
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">{plugin.manifest.description}</p>
        </div>
        <Toggle
          checked={plugin.enabled}
          onChange={() => { void setEnabled(plugin.id, !plugin.enabled) }}
          label={plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
        />
      </div>

      {plugin.status === 'pending-approval' && (
        <div className="mt-3 rounded-[10px] border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
          {t('plugins.pendingApprovalHint')}
        </div>
      )}

      <Segmented
        className="mt-4"
        size="sm"
        value={tab}
        onChange={setTab}
        label={t('plugins.title')}
        options={[
          { value: 'overview', label: t('plugins.permissions') },
          { value: 'activity', label: t('plugins.activity') }
        ]}
      />

      {tab === 'overview' ? (
        <>
          <p className="mt-3 text-[11px] text-fg-faint">{t('plugins.permissionsHint')}</p>
          <div className="mt-2 space-y-1">
            {declared.map((permission) => (
              <PermissionRow
                key={permission}
                permission={permission}
                required={plugin.permissions.required.includes(permission)}
                granted={granted.has(permission)}
                onGrant={() => { void grant(plugin.id, [permission]) }}
                onRevoke={() => { void revoke(plugin.id, [permission]) }}
              />
            ))}
          </div>

          <PluginConfiguration plugin={plugin} />

          {plugin.diagnostics.length > 0 && (
            <>
              <h4 className="mt-4 text-[12px] font-medium text-fg">{t('plugins.diagnostics')}</h4>
              <ul className="mt-1 space-y-1">
                {plugin.diagnostics.map((diagnostic, index) => (
                  <li
                    key={`${diagnostic.path}:${String(index)}`}
                    className={cn('rounded-[8px] px-2 py-1.5 text-[11.5px]', diagnostic.level === 'error' ? 'bg-danger/5 text-danger' : 'bg-tint text-fg-muted')}
                  >
                    {/* 诊断内容来自清单与包内文件,是**领域值**,不进翻译表 */}
                    <span className="font-mono">{diagnostic.path}</span>: {diagnostic.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          <Button
            className="mt-4"
            size="sm"
            variant="danger"
            icon={<Trash2 size={13} />}
            onClick={() => { void uninstall(plugin.id) }}
          >
            {t('plugins.uninstall')}
          </Button>
        </>
      ) : activity.length === 0 ? (
        <p className="mt-4 text-[12px] text-fg-faint">{t('plugins.activityEmpty')}</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {activity.map((entry, index) => (
            <li key={`${String(entry.ts)}:${String(index)}`} className="flex items-baseline gap-2 rounded-[8px] px-2 py-1 text-[11.5px]">
              <span className={cn('shrink-0 font-mono', entry.verdict === 'ok' ? 'text-fg-faint' : 'text-danger')}>{entry.method}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted">{entry.summary}</span>
              <span className="shrink-0 tabular-nums text-fg-faint">{entry.durationMs}ms</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PermissionRow({
  permission,
  required,
  granted,
  onGrant,
  onRevoke
}: {
  permission: PluginPermission
  required: boolean
  granted: boolean
  onGrant: () => void
  onRevoke: () => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-2.5 rounded-[8px] bg-tint px-2.5 py-2">
      <ShieldCheck size={13} className={cn('mt-0.5 shrink-0', granted ? 'text-accent' : 'text-fg-faint')} />
      <div className="min-w-0 flex-1">
        {/*
          ★ **人话在上,id 在下。**

          原来这一行只有 `workspace.write` 这个 id —— 而用户就是在这里点
          「批准」的。一个 id 回答不了「批了会发生什么」,于是这个决定其实是
          闭着眼做的。网页详情页反倒有说明,那是本末倒置:**做决定的地方是这里**。

          认不出的能力退回显示 id 本身,不吞掉 —— 宁可显示一个陌生字符串,
          也不要让一项能力从这份清单里消失。
        */}
        <div className="text-[12px] leading-relaxed text-fg">
          {t(`plugins.perm.${permission}` as TranslationKey)}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <code className="font-mono text-[10.5px] text-fg-faint">{permission}</code>
          {required && (
            <span className="rounded-[4px] bg-tint-strong px-1 text-[10px] text-fg-faint">{t('plugins.required')}</span>
          )}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={granted ? onRevoke : onGrant}>
        {granted ? t('plugins.revoke') : t('plugins.grant')}
      </Button>
    </div>
  )
}
