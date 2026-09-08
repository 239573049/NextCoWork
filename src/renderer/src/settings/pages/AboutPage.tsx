import { useEffect, useState, type ReactNode } from 'react'
import type { Bootstrap } from '../../../../shared/domain/bootstrap'
import { SettingGroup, SettingRow } from '../Row'
import { useI18n } from '../../i18n'
import { Button } from '../../components/ui/Button'
import { updateCheck, updateDownload, updateGetState, updateInstall } from '../../services/app'
import type { UpdateState } from '../../../../shared/domain/update'
import { on } from '../../services/ipc'

/**
 * 版本号取自 `Bootstrap.versions`,不是 preload 的 `versions()` ——
 * 后者只有 electron/chrome/node,没有应用自己的版本号。
 */
export function AboutPage({ versions }: { versions: Bootstrap['versions'] }): ReactNode {
  const { t } = useI18n()
  const [result, setResult] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    void updateGetState().then(setResult).catch(() => undefined)
    return on('app:updateChanged', setResult)
  }, [])
  const check = async (): Promise<void> => {
    setChecking(true)
    try { setResult(await updateCheck()) } catch { setResult({ state: 'error', currentVersion: versions.app, code: 'network' }) } finally { setChecking(false) }
  }
  const download = async (): Promise<void> => { setWorking(true); try { setResult(await updateDownload()) } finally { setWorking(false) } }
  const install = async (): Promise<void> => { setWorking(true); try { await updateInstall() } finally { setWorking(false) } }
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
          <Button size="sm" disabled={checking || working} onClick={() => void check()}>{checking ? t('about.updates.checking') : t('about.updates.check')}</Button>
          {result?.state === 'available' && <Button size="sm" variant="accent" disabled={working} onClick={() => void download()}>{t('about.updates.download', { version: result.update.version })}</Button>}
          {result?.state === 'downloaded' && <Button size="sm" variant="accent" disabled={working} onClick={() => void install()}>{t('about.updates.restartAndInstall')}</Button>}
        </div>
        {result?.state === 'up-to-date' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.upToDate')}</div>}
        {result?.state === 'downloading' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.downloading', { percent: Math.round(result.progress?.percent ?? 0) })}</div>}
        {result?.state === 'downloaded' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.downloaded')}</div>}
        {result?.state === 'installing' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.installing')}</div>}
        {result?.state === 'disabled' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.devDisabled')}</div>}
        {result?.state === 'idle' && <div className="mt-1 text-[12px] text-fg-muted">{t('about.updates.ready')}</div>}
        {result?.state === 'error' && <div className="mt-1 text-[12px] text-danger">{t(`about.updates.error.${result.code}` as 'about.updates.error.network')}</div>}
        {result?.state === 'available' && result.update.releaseNotes && <div className="mt-2 whitespace-pre-wrap text-[12px] text-fg-muted">{result.update.releaseNotes}</div>}
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
