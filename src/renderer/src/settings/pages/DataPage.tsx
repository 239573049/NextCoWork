import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import type { BackupFrequency, StorageStats } from '../../../../shared/domain/settings'
import type { BackupStatus, CleanupAge, CleanupPreview, ImportPreview, RestorePreview } from '../../../../shared/domain/data'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Toggle } from '../../components/ui/Toggle'
import { cn } from '../../lib/cn'
import * as dataService from '../../services/data'
import { useRunIndex } from '../../stores/session'
import type { SettingsPageProps } from '../props'
import { formatBytes, formatCount } from '../format'

type ModalState =
  | { kind: 'export' }
  | { kind: 'import'; preview: ImportPreview }
  | { kind: 'restore'; preview: RestorePreview }
  | { kind: 'cleanup'; preview: CleanupPreview; age?: CleanupAge }

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: BackupFrequency; label: string }> = [
  { value: 'manual', label: '手动' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' }
]

const AGE_OPTIONS: ReadonlyArray<{ value: CleanupAge; label: string }> = [
  { value: 3, label: '3 个月前' },
  { value: 6, label: '6 个月前' },
  { value: 12, label: '1 年前' }
]

/** 设置 › 数据：所有结果都来自主进程数据服务，不在页面里模拟成功状态。 */
export function DataPage({ settings, patch }: SettingsPageProps): ReactNode {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [age, setAge] = useState<CleanupAge>(3)
  const [includeKeys, setIncludeKeys] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [exportPasswordAgain, setExportPasswordAgain] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const running = useRunIndex().length > 0

  const refresh = useCallback(async (initial = false): Promise<void> => {
    if (initial) setLoading(true)
    try {
      const [nextStats, nextBackup] = await Promise.all([dataService.getStats(), dataService.getBackupStatus()])
      setStats(nextStats)
      setBackup(nextBackup)
      if (nextBackup.lastError === null && busy === null) setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      if (initial) setLoading(false)
    }
  }, [busy])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  const closeModal = useCallback((): void => {
    setModal(null)
    setIncludeKeys(false)
    setExportPassword('')
    setExportPasswordAgain('')
    setImportPassword('')
  }, [])

  const run = useCallback(async <T,>(label: string, action: () => Promise<T>, success?: (value: T) => string | null, refreshAfter = true): Promise<T | null> => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      const value = await action()
      const message = success?.(value)
      if (message !== undefined && message !== null) setNotice(message)
      if (refreshAfter) await refresh()
      return value
    } catch (err) {
      setError(errorMessage(err))
      return null
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const chooseDirectory = async (): Promise<void> => {
    const selected = await run('choose-directory', () => dataService.chooseBackupDirectory())
    if (selected !== null && selected !== undefined) setNotice(`备份目录已设置：${selected}`)
  }

  const openImportPreview = async (): Promise<void> => {
    const preview = await run('import-preview', () => dataService.importPreview())
    if (preview !== null && preview !== undefined) setModal({ kind: 'import', preview })
  }

  const openRestorePreview = async (): Promise<void> => {
    if (running) return
    const result = await run('restore-preview', () => dataService.restoreBackup(false))
    if (result?.preview !== undefined) setModal({ kind: 'restore', preview: result.preview })
  }

  const openCleanupPreview = async (kind: CleanupPreview['kind'], selectedAge?: CleanupAge): Promise<void> => {
    if (running) return
    const preview = await run('cleanup-preview', () => dataService.cleanupPreview(kind, selectedAge))
    if (preview !== null) setModal({ kind: 'cleanup', preview, ...(selectedAge === undefined ? {} : { age: selectedAge }) })
  }

  const executeImport = async (): Promise<void> => {
    const preview = modal?.kind === 'import' ? modal.preview : null
    if (preview === null) return
    const result = await run('import-apply', () => dataService.importApply(preview.hasEncryptedCredentials ? importPassword : undefined), (value) => `已导入 ${formatCount(value.imported)} 项，覆盖 ${formatCount(value.overwritten)} 项`)
    if (result !== null) closeModal()
  }

  const executeRestore = async (): Promise<void> => {
    if (running || modal?.kind !== 'restore') return
    const result = await run('restore', () => dataService.restoreBackup(true), (value) => value?.restored ? '数据已从备份恢复' : null)
    if (result?.restored) closeModal()
  }

  const executeCleanup = async (): Promise<void> => {
    if (running || modal?.kind !== 'cleanup') return
    const target = modal
    // Different cleanup operations return different result shapes (for example,
    // clearLocalData reports whether the deletion completed).  The page only
    // needs to know whether the service call succeeded.
    let label: string
    let action: () => Promise<unknown>
    if (target.preview.kind === 'attachments') {
      label = 'cleanup-attachments'
      action = dataService.cleanupAttachments
    } else if (target.preview.kind === 'age') {
      label = 'cleanup-age'
      action = () => dataService.cleanupByAge(target.age ?? age)
    } else if (target.preview.kind === 'history') {
      label = 'clear-history'
      action = dataService.clearHistory
    } else {
      label = 'clear-local-data'
      action = () => dataService.clearLocalData(true)
    }
    // `clearLocalData` closes the database and requests app.quit(); querying
    // stats again after it succeeds would race the shutdown path and turn a
    // completed deletion into a spurious error state.
    const result = await run(label, action, undefined, target.preview.kind !== 'local-data')
    if (result !== null) closeModal()
  }

  const doExport = async (): Promise<void> => {
    if (includeKeys) {
      if (exportPassword.length < 8) {
        setError('加密导出密码至少需要 8 个字符')
        return
      }
      if (exportPassword !== exportPasswordAgain) {
        setError('两次输入的密码不一致')
        return
      }
    }
    const result = await run('export', () => dataService.exportData({
      includeEncryptedKeys: includeKeys,
      ...(includeKeys ? { password: exportPassword } : {})
    }), (value) => value === null ? null : `数据已导出：${value.path}`)
    if (result !== null) closeModal()
  }

  const frequency = settings.data?.backupFrequency ?? 'manual'
  const backupDirectory = settings.data?.backupDirectory ?? null
  const busyNow = busy !== null
  const riskDisabled = running || busyNow
  const statValues = useMemo(() => [
    ['数据库大小', formatBytes(stats?.dbBytes)],
    ['对话文件', formatBytes(stats?.conversationBytes)],
    ['对话数量', `${formatCount(stats?.conversationCount)} 个`],
    ['消息数量', `${formatCount(stats?.messageCount)} 条`]
  ] as const, [stats])

  return (
    <div className="pb-1">
      <DataSection title="云端同步" className="pt-2">
        <DataRow
          title="设置云同步"
          description="云同步暂未启用。本版本只管理这台设备上的数据，不会保存一个看起来已经生效的同步开关。"
          last
        >
          <Toggle checked={false} onChange={() => undefined} label="设置云同步" disabled />
        </DataRow>
      </DataSection>

      <DataSection title="数据迁移">
        <DataRow title="导出" description="默认不包含 API Key、代理密码和 MCP 密钥；可选择使用一次性密码加密导出">
          <div className="flex items-center gap-2">
            <SelectControl ariaLabel="导出范围" value="all" options={[{ value: 'all', label: '全部数据' }]} />
            <SelectControl ariaLabel="导出格式" value="json" options={[{ value: 'json', label: 'JSON' }]} />
            <Button size="sm" className="border border-accent bg-transparent text-accent hover:bg-accent/10" icon={<Download size={13} />} disabled={busyNow} onClick={() => setModal({ kind: 'export' })}>导出</Button>
          </div>
        </DataRow>
        <DataRow title="导入数据" description="先解析并预览 JSON，再逐项合并；导入失败会回滚全部变更" last>
          <Button size="sm" className="border border-accent bg-transparent text-accent hover:bg-accent/10" icon={<Upload size={13} />} disabled={busyNow} onClick={() => { void openImportPreview() }}>选择并导入</Button>
        </DataRow>
      </DataSection>

      <DataSection title="数据备份">
        <DataRow title="备份目录" description={backupDirectory ?? '未设置'}>
          <button type="button" disabled={busyNow} onClick={() => { void chooseDirectory() }} className="app-no-drag inline-flex items-center gap-1.5 text-[12px] text-fg hover:text-accent disabled:opacity-40">
            <FolderOpen size={14} /> {backupDirectory ? '更换目录' : '选择目录'}
          </button>
        </DataRow>
        <DataRow title="备份频率" description="自动备份在应用启动时按到期补做，不依赖页面计时器">
          <SelectControl
            ariaLabel="备份频率"
            value={frequency}
            options={FREQUENCY_OPTIONS}
            onChange={(value) => patch({ data: { backupFrequency: value as BackupFrequency } })}
            className="w-[98px]"
          />
        </DataRow>
        <DataRow title="上次备份" description={backup?.lastError ? `失败：${backup.lastError}` : formatDate(backup?.lastBackupAt)}>
          <Button size="sm" disabled={backupDirectory === null || busyNow} icon={<HardDrive size={13} />} onClick={() => { void run('backup', () => dataService.createBackup(true), () => '备份已完成') }}>立即备份</Button>
        </DataRow>
        <DataRow title="从备份文件恢复" description="直接选择 .ncwbackup 文件；恢复前会校验格式、版本和校验和" last>
          <Button size="sm" className="border border-accent bg-transparent text-accent hover:bg-accent/10" icon={<RefreshCw size={13} />} disabled={riskDisabled} onClick={() => { void openRestorePreview() }}>选择备份恢复</Button>
        </DataRow>
      </DataSection>

      <DataSection title="存储管理">
        <div className="grid grid-cols-4 gap-2 pb-2 pt-3">
          {statValues.map(([label, value]) => <Stat key={label} label={label} value={loading ? '…' : value} />)}
        </div>
        <DataRow title="数据目录" description={stats?.dataDirectory ?? '数据库、对话记录、配置等所有数据所在位置'}>
          <Button size="sm" icon={<FolderOpen size={13} />} disabled={busyNow} onClick={() => { void run('open-directory', () => dataService.openDataDirectory(), () => '已打开数据目录') }}>打开目录</Button>
        </DataRow>
        <DataRow title="优化存储" description="先 checkpoint WAL，再回收数据库空间，不会删除任何对话">
          <Button size="sm" icon={<HardDrive size={13} />} disabled={busyNow} onClick={() => { void run('vacuum', () => dataService.vacuum(), () => '存储已优化') }}>优化</Button>
        </DataRow>
        <DataRow title="清理附件目录" description="只删除没有被消息引用的孤儿附件；仍被引用的文件不会删除">
          <Button size="sm" icon={<Trash2 size={13} />} disabled={riskDisabled} onClick={() => { void openCleanupPreview('attachments') }}>清理</Button>
        </DataRow>
        <DataRow title="清理范围">
          <div className="flex items-center gap-2">
            <SelectControl ariaLabel="清理范围" value={String(age)} options={AGE_OPTIONS.map((x) => ({ value: String(x.value), label: x.label }))} className="w-[114px]" onChange={(value) => setAge(Number(value) as CleanupAge)} />
            <Button size="sm" icon={<Trash2 size={13} />} disabled={riskDisabled} onClick={() => { void openCleanupPreview('age', age) }}>清理</Button>
          </div>
        </DataRow>
        <DataRow title="清空对话历史" description="只删除会话、消息、运行记录、搜索索引和已无引用的附件" descriptionTone="danger" last>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={riskDisabled} onClick={() => { void openCleanupPreview('history') }}>清空对话</Button>
        </DataRow>
      </DataSection>

      <DataSection title="清空本机数据" className="mb-1">
        <DataRow title="删除并退出" description="永久删除 NextCoWork 自己管理的设置、会话、日志、Skill、插件和缓存；Claude CLI 共享目录与外部备份目录会保留" last>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={riskDisabled} onClick={() => { void openCleanupPreview('local-data') }}>删除并退出</Button>
        </DataRow>
      </DataSection>

      {busyNow && <p className="flex items-center gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted" role="status"><Loader2 size={12} className="animate-spin" />正在处理…</p>}
      {running && <p className="flex items-center gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted" role="status"><AlertTriangle size={12} />有运行中的 Agent，恢复和清理操作暂时不可用</p>}
      {error !== null && <p className="flex items-start gap-1.5 px-1 pb-2 text-[11.5px] text-danger" role="alert"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}</p>}
      {notice !== null && <p className="flex items-start gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted" role="status"><Check size={13} className="mt-0.5 shrink-0 text-accent" />{notice}</p>}

      <ExportDialog open={modal?.kind === 'export'} includeKeys={includeKeys} password={exportPassword} passwordAgain={exportPasswordAgain} busy={busyNow} onIncludeKeys={setIncludeKeys} onPassword={setExportPassword} onPasswordAgain={setExportPasswordAgain} onClose={closeModal} onExport={() => { void doExport() }} />
      <ImportDialog open={modal?.kind === 'import'} preview={modal?.kind === 'import' ? modal.preview : null} password={importPassword} busy={busyNow} onPassword={setImportPassword} onClose={closeModal} onApply={() => { void executeImport() }} />
      <RestoreDialog open={modal?.kind === 'restore'} preview={modal?.kind === 'restore' ? modal.preview : null} busy={busyNow} onClose={closeModal} onApply={() => { void executeRestore() }} />
      <CleanupDialog open={modal?.kind === 'cleanup'} preview={modal?.kind === 'cleanup' ? modal.preview : null} busy={busyNow} onClose={closeModal} onApply={() => { void executeCleanup() }} />
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

function formatDate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '从未备份'
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function DataSection({ title, children, className }: { title: string; children: ReactNode; className?: string }): ReactNode {
  return <section className={cn('mb-3.5 overflow-hidden rounded-[18px] border border-border bg-surface-field px-4', className)}><h3 className="pt-4 pb-0.5 text-[13px] text-fg">{title}</h3>{children}</section>
}

function DataRow({ title, description, children, descriptionTone, last = false }: { title: string; description?: ReactNode; children?: ReactNode; descriptionTone?: 'danger'; last?: boolean }): ReactNode {
  return <div className={cn('flex min-h-[62px] items-center gap-5 py-3', !last && 'border-b border-hairline')}><div className="min-w-0 flex-1"><p className="text-[13px] text-fg">{title}</p>{description !== undefined && <p className={cn('mt-1 text-[11.5px] leading-[1.45] text-fg-muted', descriptionTone === 'danger' && 'text-danger')}>{description}</p>}</div>{children !== undefined && <div className="flex shrink-0 justify-end">{children}</div>}</div>
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="flex h-[60px] flex-col items-center justify-center rounded-[11px] bg-tint"><span className="text-[10.5px] text-fg-muted">{label}</span><strong className="mt-1 text-[14px] font-normal text-fg">{value}</strong></div>
}

function SelectControl({ value, options, onChange, ariaLabel, className }: { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange?: (value: string) => void; ariaLabel: string; className?: string }): ReactNode {
  return <label className={cn('app-no-drag relative block w-[108px]', className)}><select aria-label={ariaLabel} value={value} onChange={(event) => onChange?.(event.target.value)} className="selectable h-7 w-full appearance-none rounded-pill border border-border bg-surface-field py-0 pr-7 pl-3 text-[12px] text-fg outline-none hover:bg-tint focus:border-accent">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown aria-hidden size={13} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-faint" /></label>
}

function ExportDialog({ open, includeKeys, password, passwordAgain, busy, onIncludeKeys, onPassword, onPasswordAgain, onClose, onExport }: { open: boolean; includeKeys: boolean; password: string; passwordAgain: string; busy: boolean; onIncludeKeys: (value: boolean) => void; onPassword: (value: string) => void; onPasswordAgain: (value: string) => void; onClose: () => void; onExport: () => void }): ReactNode {
  return <Dialog open={open} onClose={onClose} title="导出数据" description="主进程会打开原生保存对话框，并以临时文件原子写入" width={500} footer={<><Button size="sm" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="accent" disabled={busy} onClick={onExport} icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}>导出 JSON</Button></>}>
    <div className="space-y-4">
      <div className="rounded-[10px] bg-tint px-3 py-2.5 text-[12px] leading-[1.6] text-fg-muted">导出包含设置、工作区元数据、会话、消息、模型供应商、别名、MCP、搜索服务和 Skill 开关。不会复制工作区源码、附件、插件文件或日志。</div>
      <div className="flex items-center justify-between gap-4 rounded-[10px] border border-border px-3 py-2.5"><div><p className="text-[12.5px] text-fg">包含加密密钥</p><p className="mt-0.5 text-[11px] text-fg-faint">使用 scrypt + AES-256-GCM 加密，普通 JSON 永不出现明文密钥</p></div><Toggle checked={includeKeys} onChange={onIncludeKeys} label="包含加密密钥" /></div>
      {includeKeys && <div className="space-y-2"><PasswordField label="导出密码" value={password} onChange={onPassword} placeholder="至少 8 个字符" /><PasswordField label="再次输入密码" value={passwordAgain} onChange={onPasswordAgain} placeholder="确认导出密码" /><p className="text-[11px] text-fg-faint">密码不会保存到应用，也不会随文件单独存储。请妥善保管，忘记后无法恢复密钥区。</p></div>}
    </div>
  </Dialog>
}

function ImportDialog({ open, preview, password, busy, onPassword, onClose, onApply }: { open: boolean; preview: ImportPreview | null; password: string; busy: boolean; onPassword: (value: string) => void; onClose: () => void; onApply: () => void }): ReactNode {
  if (preview === null) return null
  return <Dialog open={open} onClose={onClose} title="导入预览" description={preview.path} width={520} footer={<><Button size="sm" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="accent" disabled={busy || (preview.hasEncryptedCredentials && password.length < 8)} onClick={onApply} icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}>确认导入</Button></>}>
    <PreviewCounts rows={[['工作区', preview.workspaceCount], ['会话', preview.sessionCount], ['消息', preview.messageCount], ['供应商', preview.providerCount], ['模型别名', preview.aliasCount], ['MCP 服务器', preview.mcpServerCount]]} />
    <p className="mt-3 text-[11.5px] leading-[1.6] text-fg-muted">新增 {preview.newCount} 项 · 更新 {preview.overwriteCount} 项 · 跳过 {preview.skippedCount} 项。相同 ID 只有导入记录更新时才会覆盖本地记录。</p>
    {preview.hasEncryptedCredentials && <div className="mt-3 rounded-[10px] border border-border px-3 py-2.5"><p className="text-[12.5px] text-fg">此文件包含加密密钥</p><p className="mt-1 text-[11px] text-fg-faint">请输入导出时设置的密码；密码错误不会修改任何现有数据。</p><input type="password" value={password} onChange={(event) => onPassword(event.target.value)} placeholder="导入密码" aria-label="导入密码" className="selectable mt-2 h-8 w-full rounded-[8px] border border-border bg-surface-field px-2.5 text-[13px] text-fg outline-none focus:border-accent" /></div>}
  </Dialog>
}

function RestoreDialog({ open, preview, busy, onClose, onApply }: { open: boolean; preview: RestorePreview | null; busy: boolean; onClose: () => void; onApply: () => void }): ReactNode {
  if (preview === null) return null
  return <Dialog open={open} onClose={onClose} title="恢复备份" description={preview.path} width={500} footer={<><Button size="sm" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="accent" disabled={busy} onClick={onApply} icon={busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}>确认恢复</Button></>}>
    <div className="rounded-[10px] border border-border px-3 py-2.5 text-[12px] leading-[1.6] text-fg-muted"><p>备份创建于 {formatDate(preview.manifest.createdAt)}</p><p>将恢复 {formatCount(preview.sessionCount)} 个会话、{formatCount(preview.messageCount)} 条消息和设置。</p><p>恢复会替换当前本地数据库；执行前会创建临时安全快照。</p></div>
  </Dialog>
}

function CleanupDialog({ open, preview, busy, onClose, onApply }: { open: boolean; preview: CleanupPreview | null; busy: boolean; onClose: () => void; onApply: () => void }): ReactNode {
  if (preview === null) return null
  const dangerous = preview.kind === 'history' || preview.kind === 'local-data'
  const title = preview.kind === 'attachments' ? '清理附件目录' : preview.kind === 'age' ? '按时间清理' : preview.kind === 'history' ? '清空对话历史' : '删除并退出'
  return <Dialog open={open} onClose={onClose} title={title} description="请确认以下将要删除的数据" width={500} footer={<><Button size="sm" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="danger" disabled={busy} onClick={onApply} icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}>{preview.kind === 'local-data' ? '永久删除并退出' : '确认清理'}</Button></>}>
    {dangerous && <div className="mb-3 flex items-start gap-2 rounded-[10px] bg-danger/10 px-3 py-2.5 text-[12px] leading-[1.6] text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" />此操作不可撤销。{preview.kind === 'local-data' ? 'Claude CLI 共享目录和外部备份目录会保留。' : '应用设置、模型和身份信息会保留。'}</div>}
    <PreviewCounts rows={[['会话', preview.sessionCount], ['消息', preview.messageCount], ['附件', preview.attachmentCount]]} />
    <p className="mt-3 text-[12px] text-fg-muted">预计释放空间：<span className="text-fg">{formatBytes(preview.bytes)}</span></p>
    {preview.undeletable.length > 0 && <p className="mt-2 text-[11.5px] leading-[1.6] text-danger">有 {preview.undeletable.length} 个文件无法删除，执行后会保留并再次提示。</p>}
  </Dialog>
}

function PreviewCounts({ rows }: { rows: ReadonlyArray<readonly [string, number]> }): ReactNode {
  return <div className="grid grid-cols-3 gap-2">{rows.map(([label, value]) => <div key={label} className="rounded-[9px] bg-tint px-2 py-2 text-center"><div className="text-[11px] text-fg-faint">{label}</div><strong className="mt-0.5 block text-[14px] font-normal text-fg">{formatCount(value)}</strong></div>)}</div>
}

function PasswordField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }): ReactNode {
  return <label className="block"><span className="mb-1 block text-[12px] text-fg-muted">{label}</span><input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} className="selectable h-8 w-full rounded-[8px] border border-border bg-surface-field px-2.5 text-[13px] text-fg outline-none focus:border-accent" /></label>
}
