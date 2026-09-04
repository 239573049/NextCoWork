/**
 * 「添加 / 编辑 MCP 服务器」弹窗 —— 参考图那个表单。
 *
 * 这里只有**接线**:校验、拼配置、调频道。所有能单测的东西都在
 * `settings/mcp-form.ts`(vitest 是 node 环境、只收 `.ts`,`.tsx` 测不到),
 * 那边 46 个用例钉着参数切分、`key=value` 解析、id 生成与校验。
 *
 * ## 密钥这一栏有两条不直观的规矩,都写在界面上了
 *
 * 1. **编辑时取不回旧值。** 多行框里显示的是 `GITHUB_TOKEN=`,等号后面空着 ——
 *    「凭证只写不读」的直接结果(方案 §9),不是加载失败。
 * 2. **一旦这次填了任何一个值,整张表按这次填的覆盖。** `mcp:setSecrets`
 *    是整体写而不是累加(那边的注释写了理由:累加会让用户删掉的值继续生效)。
 *    于是「只补填其中一个键」会把另外几个已存的值清掉 —— 这件事不能靠用户猜,
 *    所以下面会把**将被清掉的键名逐个列出来**。
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { McpServerConfig, McpServerStatus, McpTransport } from '../../../../../shared/domain/mcp'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { Segmented } from '../../../components/ui/Segmented'
import { TextInput } from '../../../components/ui/TextInput'
import { cn } from '../../../lib/cn'
import { getMcpSecretsInfo, setMcpSecrets } from '../../../services/mcp'
import { useMcpStore } from '../../../stores/mcp'
import {
  draftOf,
  emptyDraft,
  hasErrors,
  parseSecretLines,
  secretValues,
  suggestId,
  toConfig,
  validateDraft,
  type McpDraft,
  type McpFormErrors
} from '../../mcp-form'

const TRANSPORTS: ReadonlyArray<{ value: McpTransport; label: string }> = [
  { value: 'stdio', label: '本地进程' },
  { value: 'streamable-http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' }
]

export function McpServerDialog({
  open,
  editing,
  existingIds,
  onClose
}: {
  open: boolean
  /** `null` = 新增 */
  editing: McpServerStatus | null
  /** 用于查重。编辑时会把自己排除掉 */
  existingIds: readonly string[]
  onClose: () => void
}): ReactNode {
  const upsert = useMcpStore((s) => s.upsert)
  const [draft, setDraft] = useState<McpDraft>(emptyDraft)
  const [errors, setErrors] = useState<McpFormErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 用户手动改过 id 之后就别再从名字推了 —— 推回去等于把他改的覆盖掉 */
  const [idTouched, setIdTouched] = useState(false)
  const [stored, setStored] = useState<{ names: string[]; encryptionAvailable: boolean }>({
    names: [],
    encryptionAvailable: true
  })

  // 每次打开都从头装一次:上一次的草稿留着会让「新增」带上一台服务器的残影
  useEffect(() => {
    if (!open) return
    setDraft(editing === null ? emptyDraft() : draftOf(editing.config))
    setErrors({})
    setFailure(null)
    setIdTouched(editing !== null)
    setStored({ names: [], encryptionAvailable: true })
    if (editing === null) return

    let alive = true
    void getMcpSecretsInfo(editing.config.id)
      .then((info) => {
        if (alive) setStored({ names: info.storedNames, encryptionAvailable: info.encryptionAvailable })
      })
      .catch((e: unknown) => console.error('[mcp] 读取密钥状态失败', e))
    return () => {
      alive = false
    }
  }, [open, editing])

  const set = <K extends keyof McpDraft>(k: K, v: McpDraft[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  const others = editing === null ? existingIds : existingIds.filter((i) => i !== editing.config.id)
  const typed = secretValues(parseSecretLines(draft.secretsText))
  const typedKeys = Object.keys(typed)
  // ★ 这次没填、但库里存着的键 —— 保存后会被这次的整体写覆盖掉
  const willClear = typedKeys.length === 0 ? [] : stored.names.filter((n) => !(n in typed))

  const save = (): void => {
    const e = validateDraft(draft, others)
    setErrors(e)
    if (hasErrors(e)) return

    setBusy(true)
    setFailure(null)
    const config: McpServerConfig = toConfig(draft, editing?.config.enabled ?? true)

    // 顺序有意义:先写配置(它声明了键名,主进程按那份声明过滤密钥),
    // 再写密钥(那一步会带着新值重连)。反过来的话密钥会被当成未声明而丢掉。
    void upsert(config)
      .then(() => (typedKeys.length === 0 ? undefined : setMcpSecrets(config.id, typed)))
      .then(() => {
        onClose()
      })
      .catch((err: unknown) => {
        setFailure(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(false))
  }

  const stdio = draft.transport === 'stdio'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing === null ? '添加 MCP 服务器' : `编辑 ${editing.config.name}`}
      description="MCP 服务器带来的工具会以 mcp__<ID>__<工具名> 的形式出现在模型可用的工具列表里。"
      width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" variant="accent" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : '保存并连接'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="传输方式" hint={stdio ? '在本机起一个子进程,用标准输入输出通信' : '连一台远程服务器'}>
          {/* ★ 用 Segmented 不用 Menu —— Menu 在滚动区里会被裁(ModelPage.tsx 记着这条) */}
          <Segmented
            label="传输方式"
            size="sm"
            value={draft.transport}
            options={TRANSPORTS}
            onChange={(t) => set('transport', t)}
          />
        </Field>

        <div className="flex gap-2.5">
          <Field label="名称" className="flex-1" error={errors.name}>
            <TextInput
              value={draft.name}
              ariaLabel="服务器名称"
              placeholder="GitHub"
              invalid={errors.name !== undefined}
              onChange={(name) => {
                setDraft((d) => ({ ...d, name, id: idTouched ? d.id : suggestId(name) }))
              }}
            />
          </Field>
          <Field
            label="ID"
            className="flex-1"
            error={errors.id}
            hint="会进工具名,只能用字母数字和 - _"
          >
            <TextInput
              value={draft.id}
              ariaLabel="服务器 ID"
              placeholder="github"
              disabled={editing !== null}
              invalid={errors.id !== undefined}
              onChange={(id) => {
                setIdTouched(true)
                set('id', id)
              }}
            />
          </Field>
        </div>

        <Field label="描述(可选)" hint="会拼进工具描述的前缀,给模型一点上下文">
          <TextInput
            value={draft.description}
            ariaLabel="描述"
            placeholder="仓库、Issue、PR 的读写"
            onChange={(v) => set('description', v)}
          />
        </Field>

        {stdio ? (
          <>
            <Field label="启动命令" error={errors.command}>
              <TextInput
                value={draft.command}
                ariaLabel="启动命令"
                placeholder="npx"
                invalid={errors.command !== undefined}
                onChange={(v) => set('command', v)}
              />
            </Field>
            <Field
              label="参数"
              hint="按空格切分,带空格的参数用引号括起来。反斜杠不是转义符 —— Windows 路径可以原样写"
            >
              <TextInput
                value={draft.argsText}
                ariaLabel="参数"
                placeholder="-y @modelcontextprotocol/server-everything"
                onChange={(v) => set('argsText', v)}
              />
            </Field>
            <Field label="工作目录(可选)" hint="留空 = 用当前工作区的根目录">
              <TextInput
                value={draft.cwd}
                ariaLabel="工作目录"
                placeholder="留空即可"
                onChange={(v) => set('cwd', v)}
              />
            </Field>
          </>
        ) : (
          <Field label="服务器地址" error={errors.url}>
            <TextInput
              value={draft.url}
              ariaLabel="服务器地址"
              placeholder="https://example.com/mcp"
              inputMode="url"
              invalid={errors.url !== undefined}
              onChange={(v) => set('url', v)}
            />
          </Field>
        )}

        <Field
          label={stdio ? '环境变量' : '请求头'}
          hint={`一行一条,写成 名字=值。值存进系统密钥环,不会写进配置文件${
            editing === null ? '' : ';编辑时取不回已存的值,所以等号后面是空的'
          }`}
        >
          <textarea
            value={draft.secretsText}
            aria-label={stdio ? '环境变量' : '请求头'}
            spellCheck={false}
            rows={3}
            placeholder={stdio ? 'GITHUB_TOKEN=ghp_xxx' : 'Authorization=Bearer xxx'}
            onChange={(e) => set('secretsText', e.target.value)}
            className={cn(
              'app-no-drag selectable w-full resize-none rounded-[8px] border border-hairline',
              'bg-surface-field px-2.5 py-2 font-mono text-[12px] leading-[1.7] text-fg outline-none',
              'placeholder:text-fg-faint focus:border-accent'
            )}
          />
          {stored.names.length > 0 && (
            <p className="mt-1.5 text-[11.5px] text-fg-faint">
              密钥环里已存:{stored.names.join('、')}
            </p>
          )}
          {!stored.encryptionAvailable && (
            <Notice>系统密钥环不可用,这里填的值无法安全存储,保存时会被拒绝。</Notice>
          )}
          {willClear.length > 0 && (
            /* ★ 整体写的直接后果,说清楚而不是让用户事后发现 */
            <Notice>
              保存后 {willClear.join('、')} 已存的值会被清掉 —— 这次填了值就按这次的整份覆盖。
              要保留的话请把它们也一并填上。
            </Notice>
          )}
        </Field>

        {failure !== null && (
          <p className="rounded-[8px] bg-danger/10 px-2.5 py-2 text-[12px] text-danger">{failure}</p>
        )}
      </div>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  error,
  className,
  children
}: {
  label: string
  hint?: string
  error?: string
  className?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className={cn('min-w-0', className)}>
      <label className="mb-1.5 block text-[12.5px] text-fg">{label}</label>
      {children}
      {error !== undefined ? (
        <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>
      ) : (
        hint !== undefined && <p className="mt-1.5 text-[11.5px] text-fg-faint">{hint}</p>
      )}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-danger">
      <AlertTriangle size={12} className="mt-[2px] shrink-0" />
      <span>{children}</span>
    </p>
  )
}
