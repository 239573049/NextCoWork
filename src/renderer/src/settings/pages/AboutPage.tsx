import { useState, type ReactNode } from 'react'
import type { Bootstrap } from '../../../../shared/domain/bootstrap'
import { SettingGroup, SettingRow } from '../Row'
import { useI18n } from '../../i18n'
import { Button } from '../../components/ui/Button'
import { checkForUpdates, openExternal } from '../../services/app'
import type { UpdateCheckResult } from '../../../../shared/domain/update'

/**
 * 版本号取自 `Bootstrap.versions`,不是 preload 的 `versions()` ——
 * 后者只有 electron/chrome/node,没有应用自己的版本号。
 */
export function AboutPage({ versions }: { versions: Bootstrap['versions'] }): ReactNode {
  const { t } = useI18n()
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const check = async (): Promise<void> => {
    setChecking(true)
    try { setResult(await checkForUpdates()) } catch { setResult({ status: 'unavailable', currentVersion: versions.app, message: 'request-failed' }) } finally { setChecking(false) }
  }
  const rows: ReadonlyArray<[string, string]> = [
    [t('about.version'), versions.app],
    ['Electron', versions.electron],
    ['Chromium', versions.chrome],
    ['Node', versions.node]
  ]
  return (
    <SettingGroup>
      <SettingRow
        title="NextCoWork"
        description={t('about.description')}
      />
      <SettingRow title={t('about.updates.title')} description={t('about.updates.description')}>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={checking} onClick={() => void check()}>{checking ? t('about.updates.checking') : t('about.updates.check')}</Button>
          {result?.status === 'available' && <Button size="sm" variant="accent" onClick={() => void openExternal(result.update.downloadUrl)}>{t('about.updates.download', { version: result.update.version })}</Button>}
        </div>
        {result?.status === 'current' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.current')}</div>}
        {result?.status === 'unavailable' && <div className="mt-1 text-[12px] text-danger">{t('about.updates.failed')}</div>}
      </SettingRow>
      {rows.map(([k, v], i) => (
        <SettingRow key={k} title={k} last={i === rows.length - 1}>
          {/* 版本号是要被复制去贴到 issue 里的,全局 user-select:none 得在这里 opt-in */}
          <span className="selectable font-mono text-[12.5px] text-fg-muted">{v}</span>
        </SettingRow>
      ))}
    </SettingGroup>
  )
}
