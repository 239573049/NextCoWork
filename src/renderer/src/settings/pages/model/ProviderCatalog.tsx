import { Check, ExternalLink, Loader2, Plus, Search, Shuffle } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { PROVIDER_PRESETS, type ProviderPreset } from '../../../../../shared/domain/presets'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Segmented } from '../../../components/ui/Segmented'
import { TextInput } from '../../../components/ui/TextInput'
import { cn } from '../../../lib/cn'
import { openExternal } from '../../../services/app'
import { upsertProvider } from '../../../services/provider'
import { useModelsStore } from '../../../stores/models'
import { ProviderAvatar } from './ProviderAvatar'
import { isPresetAdded, providerFromPreset } from './provider-edit'
import {
  CATALOG_TABS,
  divergentCount,
  endpointRows,
  hasDivergentBaseUrls,
  LIST_ACCESS_LABEL,
  matchPresets,
  presetsForTab,
  tabCount,
  VERIFICATION_LABEL,
  type CatalogTab
} from './provider-catalog'

/**
 * 「添加供应商」的预设目录 —— 参考图那个五分类卡片网格。
 *
 * ★★ **前一版的文件头写着「这个弹窗是只读的,它是一本册子,不是一个添加流程」——
 * 那句已经不成立了。** 当时 `provider:upsert` 还是 `todo()`,一张点下去没反应的卡片
 * 会让用户以为是自己没点中,所以刻意不做成按钮。频道现在通了,每张卡片右下角
 * 因此有了「添加」。
 *
 * ★ 但**只有那颗按钮是按钮,卡片本身仍然不是** —— 卡片上还有「接入文档」这个
 * 会打开浏览器的动作,整卡可点的话,想看文档的人会先建出一个供应商。
 *
 * ★ 已经建过的显示「已添加」并置灰,不是重复建一条:`upsertProvider` 按 id 覆盖,
 * 再点一次会把用户改过的地址和名字冲回预设的初值 —— 而 key 还留着,于是变成
 * 「密钥没动、地址被换走」,这种配置错到报错为止都看不出来。
 *
 * 卡片里每个字都是实测来的:
 * `presets.ts` 那些条目的判据是 `curl` 探针 + **同前缀假路径对照**
 * (DeepSeek / 火山 / 星火 / 智谱这几家对任意路径都返回 401,不做对照全是假阳性)。
 * 用户手上有一个域名想知道是哪家、或者配到一半 401 想查是不是走错了鉴权域,
 * 这本册子直接答得上来 —— 这些正是调研报告里最贵的那部分,不该停在 md 文件里。
 *
 * ★ 每张卡片显示的是 `previewUrl()` 算出的**最终请求地址**而不是 baseUrl:
 * OpenAI 族的版本段在 base 里、Anthropic 族不带,只看 base 会以为数据录错了。
 */
export function ProviderCatalog({
  open,
  onClose,
  onAdded
}: {
  open: boolean
  onClose: () => void
  /** 建好之后把左列选到它。不给的话用户建完还得自己去找刚加的那一条 */
  onAdded?: (providerId: string) => void
}): ReactNode {
  const [tab, setTab] = useState<CatalogTab>('recommended')
  const [query, setQuery] = useState('')
  const providers = useModelsStore((s) => s.providers)

  // 搜索时跨全表找 —— 用户打「openrouter」不该还要先猜它在哪个分类
  const list = useMemo(
    () => (query.trim() === '' ? presetsForTab(tab) : matchPresets(PROVIDER_PRESETS, query)),
    [tab, query]
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="添加供应商"
      description={`内置 ${PROVIDER_PRESETS.length} 家预设,地址与协议经探针实测。添加后在右侧填密钥即可用`}
      width={760}
    >
      <div className="flex items-center gap-3 pb-3">
        <Segmented
          size="sm"
          label="供应商分类"
          value={tab}
          onChange={(v) => {
            setTab(v)
            setQuery('')
          }}
          options={CATALOG_TABS.map((t) => ({
            value: t.id,
            label: `${t.label} ${String(tabCount(t.id))}`
          }))}
        />
        <div className="min-w-0 flex-1">
          <TextInput
            size="sm"
            value={query}
            onChange={setQuery}
            placeholder="搜名字、地址或模型"
            ariaLabel="搜索供应商预设"
            icon={<Search size={13} className="text-icon" />}
          />
        </div>
      </div>

      {query.trim() !== '' && (
        <p className="pb-2 text-[11.5px] text-fg-faint">
          搜索跨全部 {PROVIDER_PRESETS.length} 家,不限当前分类 —— 命中 {list.length} 家。
        </p>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={<Search size={20} />}
          title="没有匹配的供应商"
          hint="试试域名的一段,比如 openrouter.ai 或 127.0.0.1。"
          className="py-10"
        />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {list.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              added={isPresetAdded(p, providers)}
              onAdded={onAdded}
            />
          ))}
        </div>
      )}

      <p className="mt-4 border-t border-hairline pt-3 text-[11.5px] leading-[1.6] text-fg-faint">
        {PROVIDER_PRESETS.length} 家里有 {divergentCount()} 家
        <span className="text-fg-muted">换协议就换地址</span>
        (OpenRouter 的 OpenAI 端是 /api/v1、Anthropic 端是 /api)。所以地址是挂在协议上的, 翻「API
        格式」开关时会跟着换 —— 不然表单看着完全正常,请求 404。
      </p>
    </Dialog>
  )
}

function PresetCard({
  preset: p,
  added,
  onAdded
}: {
  preset: ProviderPreset
  added: boolean
  onAdded?: (providerId: string) => void
}): ReactNode {
  const rows = endpointRows(p)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = (): void => {
    const draft = providerFromPreset(p)
    // endpoints 非空是预设表的结构约束(presets.test.ts 守着),这里兜底不报错
    if (draft === null) return
    setBusy(true)
    setError(null)
    void upsertProvider(draft)
      .then(() => onAdded?.(draft.id))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="min-w-0 rounded-[10px] border border-border bg-canvas px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderAvatar name={p.name} id={p.id} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg" title={p.name}>
          {p.name}
        </span>
        {p.subscription === true && <Tag>订阅制</Tag>}
        {/* ★ 未核实的带角标 —— 让「未核实」进界面而不是停在报告里:
            配失败时用户知道该去查文档,而不是怀疑自己填错了 */}
        {p.verification === 'unverified' ? (
          <Tag danger>未核实</Tag>
        ) : (
          <Tag>{VERIFICATION_LABEL[p.verification]}</Tag>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.protocol} className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-fg-muted">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-fg-faint">
                {LIST_ACCESS_LABEL[r.list]}
              </span>
            </div>
            <code
              className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-faint"
              title={r.requestUrl}
            >
              {r.requestUrl}
            </code>
          </li>
        ))}
      </ul>

      {hasDivergentBaseUrls(p) && (
        <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-fg-faint">
          <Shuffle size={10} className="shrink-0" />
          换协议会换地址
        </p>
      )}

      {p.notes !== undefined && (
        <p className="mt-1.5 text-[11px] leading-[1.55] text-fg-muted">{p.notes}</p>
      )}

      {p.suggestedModels.length > 0 && (
        <p
          className="mt-1.5 truncate font-mono text-[10.5px] text-fg-faint"
          title={p.suggestedModels.join('\n')}
        >
          {p.suggestedModels.join(' · ')}
        </p>
      )}

      {/* ★ 原样显示主进程回的那句话。这里最可能出现的是 baseUrl 被拒
          (`normalizeBaseUrl` 只放行 http/https),概括成「添加失败」就没了线索 */}
      {error !== null && <p className="mt-1.5 text-[10.5px] text-danger">{error}</p>}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void openExternal(p.docsUrl)}
          title={p.docsUrl}
          className={cn(
            'app-no-drag flex shrink-0 items-center gap-1 text-[11px]',
            'text-fg-muted transition-colors hover:text-fg'
          )}
        >
          <ExternalLink size={10} />
          接入文档
        </button>
        <span className="min-w-0 flex-1" />
        {added ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-accent">
            <Check size={11} />
            已添加
          </span>
        ) : (
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            icon={busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            onClick={add}
          >
            添加
          </Button>
        )}
      </div>
    </div>
  )
}

function Tag({ children, danger = false }: { children: ReactNode; danger?: boolean }): ReactNode {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px]',
        danger ? 'bg-danger/10 text-danger' : 'bg-tint text-fg-faint'
      )}
    >
      {children}
    </span>
  )
}
