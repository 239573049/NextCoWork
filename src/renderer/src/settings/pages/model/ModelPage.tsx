import { ChevronDown, ServerCog } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PROVIDER_PRESETS } from '../../../../../shared/domain/presets'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Menu, MenuItem, MenuLabel } from '../../../components/ui/Menu'
import { cn } from '../../../lib/cn'
import { useModelsStore } from '../../../stores/models'
import type { SettingsPageProps } from '../../props'
import { SettingGroup, TodoRow } from '../../Row'
import { EnabledModelList } from './EnabledModelList'
import { providerEntries } from './enabled-models'
import { PricingTable } from './PricingTable'
import { ProviderCatalog } from './ProviderCatalog'
import { ProviderPanel } from './ProviderPanel'
import { StubModalityPage } from './StubModalityPage'
import { parseModelTab } from './tabs'

/**
 * 「设置 › 模型」。
 *
 * ★ **顶部那条 Tab 不在这个文件里。** 它是 `nav.ts` 给这一页声明的六个 `subs`,
 * 由 `SettingsOverlay` 的页眉统一渲染成 `Segmented`。走既有机制而不是自己造一条
 * Tab 栏,买到两样东西:和「通用 / 连接」两页用的是同一个控件(不会在同一个浮层里
 * 长出第二套 Tab 视觉),以及**搜索能直接跳进子 Tab**(`SettingsRow.sub` 那条路已经通了)。
 *
 * ⚠️ 这条注释的前一版还写着「这一页本来就没有截图可量」——**那句已经不成立了**,
 * 参考图后来补上了。重看之后 Tab 的位置结论没变(仍留在页眉换一致性),
 * 但布局改成了照图的两列。真正从图里读出来、且推翻了原设计的是下面这条:
 *
 * ★★ **左列每一行是一个「供应商」,右侧那张卡片是它的配置** —— 不是一行一个模型。
 * 这和方案 §1.5 「右侧那张列表 = 从这个供应商启用的模型」正好咬合:
 * 行的副标题是该供应商下的主模型别名。判据写在 `enabled-models.ts` 文件头。
 *
 * ★ **本轮读得出、写不进去。** `provider:upsert` / `setCredential` / `test` 在
 * `main/ipc/index.ts` 里全是 `todo()`(步骤 4),所以右侧整张表单包在
 * `<fieldset disabled>` 里(理由见 `ProviderPanel.tsx` 文件头),
 * 而「添加供应商」打开的是一本**只读的预设册子**,不是一个建档流程。
 */
export function ModelPage({ settings, sub, patch }: SettingsPageProps): ReactNode {
  const tab = parseModelTab(sub)
  if (tab === 'usage') return <UsageTab />
  if (tab !== 'text') return <StubModalityPage modality={tab} />
  return <TextTab settings={settings} patch={patch} />
}

function TextTab({ settings, patch }: Omit<SettingsPageProps, 'sub'>): ReactNode {
  const providers = useModelsStore((s) => s.providers)
  const models = useModelsStore((s) => s.models)
  const loaded = useModelsStore((s) => s.loaded)
  const load = useModelsStore((s) => s.load)
  const providerOf = useModelsStore((s) => s.providerOf)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const entries = useMemo(
    () => providerEntries(providers, models, settings.defaultModel),
    [providers, models, settings.defaultModel]
  )

  // ★ 兜到第一条而不是保留一个空面板:选中的供应商被别处删掉之后,
  // `selectedId` 会指向一个不存在的 id —— 那时候右边该显示别的东西,不是一片空白
  const selected = entries.find((e) => e.provider.id === selectedId) ?? entries[0] ?? null

  const picker = (value: string, onPick: (alias: string) => void, label: string): ReactNode => (
    <Menu
      label={label}
      align="end"
      width={280}
      triggerClassName="min-w-0 max-w-[132px]"
      trigger={
        <span className="flex items-center gap-1 text-[12px]">
          <span
            className={cn('min-w-0 truncate', value === '' ? 'text-fg-faint' : 'text-fg-muted')}
          >
            {value === '' ? (loaded ? '跟随对话' : '加载中…') : value}
          </span>
          <ChevronDown size={12} className="shrink-0 text-icon" />
        </span>
      }
    >
      {(close) => (
        <>
          <MenuLabel>可用模型</MenuLabel>
          <MenuItem
            checked={value === ''}
            onSelect={() => {
              onPick('')
              close()
            }}
          >
            跟随对话
          </MenuItem>
          {models.map((m) => (
            <MenuItem
              key={`${m.providerId}:${m.alias}`}
              checked={value === m.alias}
              description={providerOf(m.alias)?.name}
              onSelect={() => {
                onPick(m.alias)
                close()
              }}
            >
              {m.alias}
            </MenuItem>
          ))}
          {loaded && models.length === 0 && <MenuLabel>还没有配置上游供应商(步骤 4)</MenuLabel>}
        </>
      )}
    </Menu>
  )

  return (
    <>
      {/*
        参考图右上角那句「如果配置遇到问题,可以查阅配置指南」。
        ★ 我们没有一份「配置指南」,**所以不编一个链接出来** —— 换成真有的东西:
        42 家预设每张卡片上都挂着各自实测过的官方文档地址。
      */}
      <div className="flex justify-end pb-2.5">
        <p className="text-[11.5px] text-fg-faint">
          配置不通?
          <button
            type="button"
            onClick={() => setCatalogOpen(true)}
            className="app-no-drag text-fg-muted underline underline-offset-2 transition-colors hover:text-fg"
          >
            供应商目录
          </button>
          里每家都带官方接入文档和实测过的地址。
        </p>
      </div>

      <div className="flex items-start gap-4">
        <EnabledModelList
          entries={entries}
          loaded={loaded}
          selectedId={selected?.provider.id ?? null}
          onSelect={setSelectedId}
          onAdd={() => setCatalogOpen(true)}
          footer={
            <>
              <RoleRow label="默认模型" hint="新对话的初值">
                {picker(
                  settings.defaultModel,
                  (defaultModel) => patch({ defaultModel }),
                  '默认模型'
                )}
              </RoleRow>
              <RoleRow label="默认子代理模型" hint="留空 = 跟随主对话">
                {picker(
                  settings.subagent.model,
                  (model) => patch({ subagent: { model } }),
                  '默认子代理模型'
                )}
              </RoleRow>
            </>
          }
        />

        {selected === null ? (
          <div className="min-w-0 flex-1 rounded-[12px] border border-border bg-canvas">
            <EmptyState
              icon={<ServerCog size={22} />}
              title={loaded ? '还没有可配置的供应商' : '正在读取'}
              hint={
                loaded
                  ? `内置 ${PROVIDER_PRESETS.length} 家预设的地址与协议都已实测,先打开目录看看有哪些。建档要等 provider:upsert(步骤 4)。`
                  : undefined
              }
              className="py-16"
            />
          </div>
        ) : (
          <ProviderPanel entry={selected} />
        )}
      </div>

      <ProviderCatalog open={catalogOpen} onClose={() => setCatalogOpen(false)} />
    </>
  )
}

/** 左列底下那种「角色 …… 选中的模型」单行。参考图的形状,填的是我们真有的两个角色 */
function RoleRow({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-[9px] px-1.5 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg">{label}</span>
        <span className="block truncate text-[11px] text-fg-faint">{hint}</span>
      </span>
      {children}
    </div>
  )
}

/**
 * 「使用统计」Tab。定价配置是它下面的一段(方案 §7 把定价配置放在用量看板的
 * 子 Tab 里),不是第七个模态 —— 所以它在这里,不在 `MODEL_TABS` 里。
 */
function UsageTab(): ReactNode {
  return (
    <>
      <SettingGroup title="用量与费用">
        <TodoRow
          title="总费用 / 总请求 / 成功率 / 平均延迟"
          description="费用按币种分别小计,不做汇率换算 —— 编一个汇率正是这一页在防的那类静默失真。"
          step="未接:usage:getSummary"
        />
        <TodoRow
          title="请求日志"
          description="一次 HTTP 尝试记一条,按 runId 分组。首字节之后禁止切换供应商,所以一轮对话可能对应好几条。"
          step="未接:usage:getRequestLogs"
        />
        <TodoRow
          title="模型 / 供应商 / 工具统计"
          description="三张分维度的表。每条查询都带时间窗和 LIMIT:node:sqlite 是同步 API,一个没有上界的聚合会卡住整个主进程。"
          step="未接:usage:getModelStats"
          last
        />
      </SettingGroup>

      <PricingTable />
    </>
  )
}
