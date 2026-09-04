/**
 * 输入框 —— 连同它下面那排药丸。
 *
 * ★ **药丸不是设置项的快捷方式,它就是发送时读取的那个值**(方案 §4.5)。
 * 界面把权限档位放在输入框左下角而不是设置页里,说明档位是**每次发送时**
 * 读的当前值,run 一旦开始就冻结在 `RunRequest` 里不再变 —— 这正是设置页
 * 那句「更改会在下一次新回复生效」。
 *
 * 所以本地 state 是权威,发送时打快照;顺带写回工作区当新默认值。
 * 反过来(以工作区为权威、每次改都等一轮 IPC 回来)会让药丸点下去有延迟。
 *
 * ★ **生成中不禁用输入框**,占位符改成「当前回复完成后按队列继续执行」。
 * 队列语义在 session store 里(`queuedInputs`),这里只是不拦着用户打字。
 */
import {
  ArrowUp,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Globe,
  Infinity as InfinityIcon,
  Paperclip,
  Plus,
  Settings2,
  Slash,
  Square,
  Wrench
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PermissionMode } from '../../../../shared/agent/permission'
import { PERMISSION_MODES, PERMISSION_MODE_HINT, PERMISSION_MODE_LABEL } from '../../../../shared/agent/permission'
import type { SessionMode, ThinkingLevel } from '../../../../shared/agent/run-request'
import {
  SESSION_MODE_HINT,
  SESSION_MODE_LABEL,
  SESSION_MODES,
  THINKING_LEVEL_LABEL,
  THINKING_LEVELS
} from '../../../../shared/agent/run-request'
import type { Workspace, WorkspaceSettings } from '../../../../shared/domain/workspace'
import type { ModelAlias, UpstreamProvider } from '../../../../shared/domain/provider'
import { ProviderIcon } from '../../components/brand/ProviderIcon'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../components/ui/Menu'
import { cn } from '../../lib/cn'
import { updateWorkspace } from '../../services/app'
import { useModelsStore } from '../../stores/models'
import { AttachmentTray, type TrayItem } from './AttachmentTray'

export interface ComposerValue {
  permissionMode: PermissionMode
  model: string
  mode: SessionMode
  thinking: ThinkingLevel
  webSearch: boolean
}

export function Composer({
  workspace,
  fallbackModel,
  draft,
  onDraft,
  running,
  onSend,
  onStop,
  attachments = [],
  onAttachFiles,
  onPickAttachment,
  onRemoveAttachment,
  onRetryAttachment
}: {
  workspace: Workspace
  /** 应用级默认模型(设置页那个)。工作区还没选过时用它兜底 */
  fallbackModel: string
  draft: string
  onDraft: (v: string) => void
  running: boolean
  onSend: (text: string, value: ComposerValue) => void
  onStop: () => void
  /**
   * 草稿附件。★ **状态不在这里** —— 它与 draft 同级,住在 ChatView,
   * 因为发送时要把它转成 `ContentPart[]`,而那是 ChatView 的职责。
   * 这里只负责渲染与三个入口。
   */
  attachments?: TrayItem[]
  /** 拖拽 / 粘贴共用 */
  onAttachFiles?: (files: File[]) => void
  /** 点 `+` → 走主进程 dialog */
  onPickAttachment?: () => void
  onRemoveAttachment?: (key: string) => void
  onRetryAttachment?: (key: string) => void
}): ReactNode {
  const { models, providers, loaded, providerOf, load } = useModelsStore()
  const [value, setValue] = useState<ComposerValue>(() => fromSettings(workspace.settings))
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 切工作区 = 换一套默认值。
   *
   * ★ **刻意不用 `useEffect([workspace.settings])`。** 药丸每改一次就会
   * `updateWorkspace` 写回,主进程随即广播 `workspace:changed` —— 那条推送回来时
   * `settings` 是个新引用,effect 会拿它把用户刚点的值再「重置」一遍。
   * 看起来就是药丸点下去闪一下又弹回原样。
   *
   * 用 React 官方那个「渲染期按 key 调整 state」的写法:只认 workspace.id 变没变。
   */
  const [seenWorkspace, setSeenWorkspace] = useState(workspace.id)
  /** 拖拽悬停高亮。★ 纯视觉状态,不影响任何数据流 */
  const [dragging, setDragging] = useState(false)
  if (seenWorkspace !== workspace.id) {
    setSeenWorkspace(workspace.id)
    setValue(fromSettings(workspace.settings))
  }

  // 自动增高。max-height 在 className 里,超过就滚动
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  function patch(p: Partial<ComposerValue>): void {
    const next = { ...value, ...p }
    setValue(next)
    // 写回工作区当新默认值。失败只记日志 —— 药丸已经生效了,
    // 一个存不下来的默认值不值得打断用户正在写的这句话。
    void updateWorkspace({ id: workspace.id, settings: toSettings(next) }).catch((err: unknown) => {
      console.error('[composer] 工作区默认值写回失败:', err)
    })
  }

  /**
   * 生效模型 = 工作区选过的 → 应用默认 → 列表第一个。
   *
   * **兜底结果不写回工作区**:用户没选过,那 `defaultModel` 就该继续是空的。
   * 静默替他做主的话,以后他在设置页改了应用默认模型,这个工作区却不跟着变,
   * 而他并不知道自己什么时候「选」过。
   */
  const model =
    value.model !== '' ? value.model : fallbackModel !== '' ? fallbackModel : (models[0]?.alias ?? '')
  const provider = providerOf(model)
  const modelLabel = model !== '' ? model : loaded ? '未配置模型' : '加载中…'

  function submit(): void {
    const text = draft.trim()
    // ★ 只有附件、没有文字也该能发 —— 拖一张图进来直接问「这是什么」是常见用法。
    //   但上传还没完成时不发:那样 parts 里会缺一张图,而用户以为发出去了。
    const hasReady = attachments.some((a) => a.status === 'done')
    const pending = attachments.some((a) => a.status === 'uploading')
    if (pending) return
    if ((text === '' && !hasReady) || model === '') return
    // 发送时打快照:药丸此刻的值进 RunRequest,run 跑起来后再改药丸不影响它
    onSend(text, { ...value, model })
    onDraft('')
  }

  /**
   * 拖拽落入。★ **过滤掉目录** —— `DataTransfer` 里的目录项 `size` 为 0 且
   * 读不出内容,不拦的话会变成一堆失败的 chip。不递归展开:
   * 一个 `node_modules` 拖进来是几万个文件。
   */
  function handleDrop(e: React.DragEvent): void {
    if (onAttachFiles === undefined) return
    const files = [...e.dataTransfer.files].filter((f) => f.size > 0 || f.type !== '')
    if (files.length === 0) return
    e.preventDefault()
    setDragging(false)
    onAttachFiles(files)
  }

  /** 粘贴。★ 截图粘贴是最高频入口,而它只有 `files`,没有文件名 */
  function handlePaste(e: React.ClipboardEvent): void {
    if (onAttachFiles === undefined) return
    const files = [...e.clipboardData.files]
    if (files.length === 0) return
    // 不 preventDefault:剪贴板里可能同时有文字,那部分仍该正常粘进输入框
    onAttachFiles(files)
  }

  return (
    <div className="shrink-0 px-6 pb-5">
      {/*
        ★ `surface-input` 不是 `surface-raised`:深色下两者同值,浅色下输入框是**纯白**
        (#ffffff),而 raised 卡片是 #f2eee6。合并了浅色主题下输入框就沉进背景里。
      */}
      <div
        className={cn(
          'mx-auto w-full max-w-[760px] rounded-panel border bg-surface-input transition-colors',
          dragging ? 'border-accent' : 'border-border'
        )}
        onDragOver={(e) => {
          if (onAttachFiles === undefined) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => { setDragging(false) }}
        onDrop={handleDrop}
      >
        <AttachmentTray
          items={attachments}
          onRemove={(k) => onRemoveAttachment?.(k)}
          onRetry={(k) => onRetryAttachment?.(k)}
        />

        <textarea
          ref={ref}
          data-testid="composer-input"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Enter 发送,Shift+Enter 换行。输入法组词期间的 Enter 是「上屏」,
            // 不是「发送」—— 少了 isComposing 这个判断,中文用户每打一个词就发一次。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={running ? '当前回复完成后按队列继续执行' : '给 NextCoWork 派个活…'}
          className="scroll-thin selectable max-h-[280px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[13.5px] leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
        />

        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          {/* ── 权限档位:界面上就在这个位置 ── */}
          <Menu
            label="权限档位"
            width={260}
            trigger={
              <Pill accent={value.permissionMode === 'full'}>
                {PERMISSION_MODE_LABEL[value.permissionMode]}
              </Pill>
            }
          >
            {(close) => (
              <>
                <MenuLabel>AI 操作如何审批?更改会在下一次新回复生效</MenuLabel>
                {PERMISSION_MODES.map((m) => (
                  <MenuItem
                    key={m}
                    checked={m === value.permissionMode}
                    description={PERMISSION_MODE_HINT[m]}
                    onSelect={() => {
                      patch({ permissionMode: m })
                      close()
                    }}
                  >
                    {PERMISSION_MODE_LABEL[m]}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>

          {/* ── `/` 会话模式 ── */}
          <Menu
            label="会话模式"
            width={250}
            trigger={
              <Pill active={value.mode !== 'normal'}>
                <Slash size={12} />
                {value.mode !== 'normal' && <span>{SESSION_MODE_LABEL[value.mode]}</span>}
              </Pill>
            }
          >
            {(close) => (
              <>
                {SESSION_MODES.map((m) => (
                  <MenuItem
                    key={m}
                    checked={m === value.mode}
                    description={SESSION_MODE_HINT[m]}
                    icon={m === 'goal' ? <InfinityIcon size={14} /> : undefined}
                    onSelect={() => {
                      patch({ mode: m })
                      close()
                    }}
                  >
                    {SESSION_MODE_LABEL[m]}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>

          {/* ── `+` 附加能力 ── */}
          <Menu
            label="更多"
            width={240}
            trigger={
              <Pill>
                <Plus size={13} />
              </Pill>
            }
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Paperclip size={14} />}
                  description="也可以直接拖进来或粘贴截图"
                  onSelect={() => {
                    close()
                    onPickAttachment?.()
                  }}
                >
                  添加附件
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  checked={value.webSearch}
                  icon={<Globe size={14} />}
                  // 「完全访问」也不解除这个开关(方案 §4.5),菜单上要说出来
                  description="完全访问档位也受它约束"
                  onSelect={() => {
                    patch({ webSearch: !value.webSearch })
                    close()
                  }}
                >
                  联网搜索
                </MenuItem>
              </>
            )}
          </Menu>

          {value.webSearch && (
            <Pill readonly>
              <Globe size={12} />
            </Pill>
          )}
          {value.thinking !== 'auto' && (
            <Pill readonly>
              <Wrench size={12} />
              <span>{THINKING_LEVEL_LABEL[value.thinking]}</span>
            </Pill>
          )}

          <div className="flex-1" />

          {/*
            ── 模型选择器:靠右,紧挨发送按钮 ──
            截图 c6184031 里这一排是**两头分布**的:左边是「这一轮怎么执行」
            (权限档位 / `/` 模式 / `+` 附加能力),右边是「发给谁」加发送。
            模型属于后者 —— 它和发送按钮是一件事的两半,挤在左边那堆开关里
            会被当成又一个开关。
          */}
          <ModelPicker
            model={model}
            modelLabel={modelLabel}
            provider={provider}
            providers={providers}
            models={models}
            loaded={loaded}
            providerOf={providerOf}
            thinking={value.thinking}
            onModel={(nextModel) => patch({ model: nextModel })}
            onThinking={(thinking) => patch({ thinking })}
          />

          <button
            type="button"
            data-testid="composer-send"
            aria-label={running ? '停止' : '发送'}
            // 生成中按钮变「停止」,但输入框仍可打字 —— 排队走 Enter
            onClick={running ? onStop : submit}
            disabled={!running && (draft.trim() === '' || model === '')}
            title={running ? '停止生成' : model === '' ? '还没有可用的模型' : model}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-pill transition-colors',
              running
                ? 'bg-tint-strong text-fg hover:bg-tint-hover'
                : 'bg-accent text-accent-fg hover:opacity-90',
              'disabled:cursor-not-allowed disabled:bg-tint disabled:text-fg-faint'
            )}
          >
            {running ? <Square size={12} fill="currentColor" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function Pill({
  children,
  active = false,
  readonly = false,
  accent = false
}: {
  children: ReactNode
  active?: boolean
  /** 只读徽标:重复显示 `+` 菜单里已开的项,让它们在收起状态下也看得见 */
  readonly?: boolean
  /**
   * 参考实现里**整个浅色界面只有两处用色**,这排药丸占掉一处(另一处是发送按钮):
   * 「完全访问」是底 `accent/10` + 字/图标 accent,其余档位是中性的。
   * 所以这不是「一种药丸样式」,是「这一档要提醒你它放开了权限」——
   * 拿它去染别的药丸,界面里唯一的色相就失去意义了。
   *
   * ★ 底色写半透明而不是一个实色 token:量到的深 #2a3d33 / 浅 #e8ebe9
   *   反解出来正好都是 accent @10% 压在输入框底上(`theme.css` §5)。
   *   于是换颜色主题时药丸底自己跟着 accent 走,不用另外声明。
   */
  accent?: boolean
}): ReactNode {
  return (
    <span
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-[12.5px]',
        readonly
          ? 'bg-tint/60 text-fg-muted'
          : accent
            ? 'bg-accent/10 text-accent transition-colors'
            : 'transition-colors hover:bg-tint-hover ' +
                (active ? 'bg-tint text-fg' : 'text-fg-muted hover:text-fg')
      )}
    >
      {children}
    </span>
  )
}

/**
 * 模型选择采用两级结构：第一次打开先选供应商，进入供应商后再选模型。
 * 这样模型别名很多时不会把所有供应商混在一个长菜单里；底部固定保留本轮模型
 * 配置（当前是思考强度），切换模型时不需要再去“更多”菜单里找。
 */
function ModelPicker({
  model,
  modelLabel,
  provider,
  providers,
  models,
  loaded,
  providerOf,
  thinking,
  onModel,
  onThinking
}: {
  model: string
  modelLabel: string
  provider?: UpstreamProvider
  providers: UpstreamProvider[]
  models: ModelAlias[]
  loaded: boolean
  providerOf: (alias: string) => UpstreamProvider | undefined
  thinking: ThinkingLevel
  onModel: (model: string) => void
  onThinking: (thinking: ThinkingLevel) => void
}): ReactNode {
  const [providerId, setProviderId] = useState<string | null>(null)

  const providerModels = providerId === null ? [] : models.filter((m) => m.providerId === providerId)
  const availableProviders = providers.filter((p) => models.some((m) => m.providerId === p.id))

  return (
    <Menu
      label="模型"
      width={300}
      align="end"
      trigger={
        <Pill>
          <ProviderIcon name={[model, provider?.name, provider?.id]} size={13} />
          <span className="max-w-[150px] truncate">{modelLabel}</span>
          <ChevronRight size={12} className="ml-0.5 text-fg-faint" />
        </Pill>
      }
      onOpenChange={(open) => {
        if (!open) setProviderId(null)
      }}
    >
      {(close) => (
        <>
          {providerId === null ? (
            <>
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <Settings2 size={12} />
                  选择模型提供商
                </span>
              </MenuLabel>
              {!loaded ? (
                <MenuLabel>加载中…</MenuLabel>
              ) : availableProviders.length === 0 ? (
                <MenuLabel>还没有配置模型,去设置页添加</MenuLabel>
              ) : (
                availableProviders.map((p) => {
                  const count = models.filter((m) => m.providerId === p.id).length
                  return (
                    <MenuItem
                      key={p.id}
                      checked={p.id === provider?.id}
                      icon={<ProviderIcon name={[p.name, p.id]} size={15} />}
                      description={`${count} 个可用模型`}
                      onSelect={() => setProviderId(p.id)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <ChevronRight size={13} className="text-fg-faint" />
                      </span>
                    </MenuItem>
                  )
                })
              )}
              <MenuSeparator />
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <BrainCircuit size={12} />
                  模型配置
                </span>
              </MenuLabel>
              {THINKING_LEVELS.map((level) => (
                <MenuItem
                  key={level}
                  checked={level === thinking}
                  onSelect={() => {
                    onThinking(level)
                    close()
                  }}
                >
                  思考强度 · {THINKING_LEVEL_LABEL[level]}
                </MenuItem>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => setProviderId(null)}
                className="app-no-drag mb-1 flex w-full items-center gap-1.5 rounded-[7px] px-2.5 py-2 text-left text-[12px] text-fg-muted transition-colors hover:bg-tint-strong hover:text-fg"
              >
                <ChevronLeft size={14} />
                <span>全部提供商</span>
              </button>
              <MenuSeparator />
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <ProviderIcon name={[providers.find((p) => p.id === providerId)?.name, providerId]} size={13} />
                  {providers.find((p) => p.id === providerId)?.name ?? providerId}
                </span>
              </MenuLabel>
              {providerModels.map((m) => {
                const p = providerOf(m.alias)
                return (
                  <MenuItem
                    key={`${m.providerId}/${m.alias}`}
                    checked={m.alias === model}
                    icon={<ProviderIcon name={[m.alias, p?.name, p?.id]} size={14} />}
                    onSelect={() => {
                      onModel(m.alias)
                      close()
                    }}
                  >
                    {m.alias}
                  </MenuItem>
                )
              })}
              <MenuSeparator />
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <BrainCircuit size={12} />
                  模型配置
                </span>
              </MenuLabel>
              {THINKING_LEVELS.map((level) => (
                <MenuItem
                  key={level}
                  checked={level === thinking}
                  onSelect={() => {
                    onThinking(level)
                    close()
                  }}
                >
                  思考强度 · {THINKING_LEVEL_LABEL[level]}
                </MenuItem>
              ))}
            </>
          )}
        </>
      )}
    </Menu>
  )
}

// ── 药丸值 ↔ 工作区设置。两边字段名一致,但**不是同一个类型** ──
// WorkspaceSettings 还有 activeSkillIds,而药丸不碰它。直接 spread 会把它抹掉。

function fromSettings(s: WorkspaceSettings): ComposerValue {
  return {
    permissionMode: s.permissionMode,
    model: s.defaultModel,
    mode: s.defaultMode,
    thinking: s.defaultThinking,
    webSearch: s.webSearch
  }
}

function toSettings(v: ComposerValue): Partial<WorkspaceSettings> {
  return {
    permissionMode: v.permissionMode,
    defaultModel: v.model,
    defaultMode: v.mode,
    defaultThinking: v.thinking,
    webSearch: v.webSearch
  }
}
