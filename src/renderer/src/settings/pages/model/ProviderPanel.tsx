import { AlertTriangle, Brain, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { baseUrlWarnings, previewUrl } from '../../../../../shared/domain/baseurl'
import { splitProtocol } from '../../../../../shared/domain/provider'
import { Segmented } from '../../../components/ui/Segmented'
import { TextInput } from '../../../components/ui/TextInput'
import { Toggle } from '../../../components/ui/Toggle'
import { cn } from '../../../lib/cn'
import { avatarInitial, type ProviderEntry } from './enabled-models'

/**
 * 参考图右边那张卡片。
 *
 * ★★ **整张表单包在一个 `<fieldset disabled>` 里,这是本文件唯一的核心决定。**
 *
 * 控件全都按参考图画出来、填的也是**这个供应商的真实值**,但一个都点不动 ——
 * 因为 `provider:upsert` / `setCredential` / `test` 在 `main/ipc/index.ts` 里
 * 全是 `todo()`,写入面整条不存在(步骤 4)。
 *
 * 两条被否掉的替代做法,都比这个糟:
 * - **让表单可编辑,保存时报错** —— 用户填完一屏才发现存不下去,而且第一反应
 *   是「我填错了」。`ModelPage.tsx` 文件头那句就是在说这个。
 * - **只放一行 TodoRow** —— 那样连「这家现在配的是什么地址、走的哪个协议」
 *   都看不见,而这些是**已经在 store 里的真数据**,读它不需要任何新频道。
 *
 * `fieldset[disabled]` 是浏览器原生的:里面所有 `button` / `input` 一次性失效,
 * 不用给每个控件挨个传 `disabled`,也就不会漏掉一个。
 *
 * ★ 地址那一行额外回显 `previewUrl()` 算出的**最终请求地址**,并跑一遍
 * `baseUrlWarnings()`。这两样是纯函数、今天就能跑,而且正是参考图那句
 * 「离开输入框后会自动识别并整理」承诺的东西里唯一现在就兑现得了的部分。
 */
export function ProviderPanel({ entry }: { entry: ProviderEntry }): ReactNode {
  const { provider: p, aliases } = entry
  const { family, responses } = splitProtocol(p.protocol)
  const warnings = baseUrlWarnings(p.baseUrl, p.protocol)

  return (
    <div className="min-w-0 flex-1 rounded-[12px] border border-border bg-canvas">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-[7px]',
            'bg-surface-sunken text-[11px] text-fg-muted'
          )}
          aria-hidden
        >
          {avatarInitial(p.name)}
        </span>
        <span className="min-w-0 truncate text-[13px] text-fg">{p.name}</span>
      </div>

      <p className="border-b border-hairline bg-tint/40 px-4 py-2 text-[11.5px] leading-[1.6] text-fg-muted">
        下面填的是这家<span className="text-fg">当前</span>的配置,读得到但改不了 —— 写入要走
        <code className="mx-1 text-fg">provider:upsert</code>
        (步骤 4),那条频道现在还是个抛错的桩。
      </p>

      <fieldset disabled className="m-0 border-0 p-0">
        <div className="space-y-4 px-4 py-4">
          <Field label="供应商名称">
            <TextInput value={p.name} onChange={noop} ariaLabel="供应商名称" />
          </Field>

          <Field
            label="API 地址(自定义服务)"
            hint="从服务商接入文档复制 Base URL 或完整请求地址,离开输入框后会自动识别并整理。"
          >
            <TextInput value={p.baseUrl} onChange={noop} ariaLabel="API 地址" inputMode="url" />
            <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
              实际会请求 <code className="text-fg-muted">{previewUrl(p.baseUrl, p.protocol)}</code>
            </p>
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
                { value: 'openai', label: 'OpenAI 格式' },
                { value: 'anthropic', label: 'Anthropic 格式' }
              ]}
              onChange={noop}
            />
          </Field>

          {/* ★ 只在 OpenAI 族下出现 —— 三个协议值到「两控件」的投影,见 provider.ts */}
          {family === 'openai' && (
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-fg">使用 Responses API</p>
                <p className="mt-1 text-[11.5px] leading-[1.6] text-fg-muted">
                  强制走 /v1/responses,中转站的 prompt cache 命中率更高。 仅当供应商支持 Responses
                  端点时开启,否则会 404。
                </p>
              </div>
              <div className="shrink-0 pt-0.5">
                <Toggle checked={responses} onChange={noop} label="使用 Responses API" />
              </div>
            </div>
          )}

          <Field label="API 密钥">
            {/*
              ★ 这里**不是**一个填了值的输入框 —— 渲染层对密钥只写不读(方案 §9),
              明文永远不回传。所以画的是一个定长掩码,它表示「有一把 key」,
              **不表示 key 有多长**。真实的后四位要走 provider:listCredentials。
            */}
            <div
              className={cn(
                'flex h-8 items-center gap-2 rounded-[8px] border border-border',
                'bg-surface-field px-2.5'
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] tracking-[0.18em] text-fg-muted">
                {p.credentialRef === '' ? '' : '••••••••••••••••'}
              </span>
              <span className="shrink-0 text-[11px] text-fg-faint">
                {p.credentialRef === '' ? '未配置' : '已配置'}
              </span>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">
              明文只在主进程里存在,经 safeStorage 加密后落盘 —— 设置页永远拿不回来, 最多显示后四位。
            </p>
            <button
              type="button"
              className="app-no-drag mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-muted"
            >
              <Plus size={13} className="text-icon" />
              添加 API 密钥
            </button>
          </Field>

          <Field
            label="模型优先级(至少添加一个)"
            hint="这家自己的模型顺序。切到别的供应商是另一条轴 —— 那由左列同名别名的候选链决定。"
          >
            {aliases.length === 0 ? (
              <p className="rounded-[8px] border border-dashed border-border px-2.5 py-3 text-[12px] text-fg-faint">
                这家还没有配任何模型。
              </p>
            ) : (
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
          </Field>
        </div>
      </fieldset>
    </div>
  )
}

/** `fieldset[disabled]` 已经把控件全关掉了,回调只是为了满足受控组件的类型 */
const noop = (): void => {}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div>
      <p className="mb-1.5 text-[12.5px] text-fg-muted">{label}</p>
      {children}
      {hint !== undefined && (
        <p className="mt-1.5 text-[11.5px] leading-[1.6] text-fg-faint">{hint}</p>
      )}
    </div>
  )
}

function RowIcon({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <button type="button" aria-label={label} className="app-no-drag shrink-0 text-icon">
      {children}
    </button>
  )
}
