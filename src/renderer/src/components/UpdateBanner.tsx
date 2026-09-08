import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateState } from '../../../shared/domain/update'
import { useI18n } from '../i18n'
import { on } from '../services/ipc'
import { updateDownload, updateGetState, updateInstall } from '../services/app'
import { Button } from './ui/Button'

export function UpdateBanner(): ReactNode {
  const { t } = useI18n()
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void updateGetState().then(setState).catch(() => undefined)
    return on('app:updateChanged', (next) => {
      setState(next)
      if (next.state === 'available' || next.state === 'downloaded') setDismissed(false)
    })
  }, [])

  if (dismissed || state === null || (state.state !== 'available' && state.state !== 'downloaded')) return null
  const update = state.update
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return (
    <div className="app-no-drag fixed left-2 right-2 top-10 z-40 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-[12px] text-fg shadow-lg">
      <span className="min-w-0 flex-1 truncate">
        {t('about.updates.banner', { version: update.version })}
        {update.mandatory ? ` · ${t('about.updates.mandatory')}` : ''}
      </span>
      {state.state === 'available' && <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(updateDownload)}>{t('about.updates.download', { version: update.version })}</Button>}
      {state.state === 'downloaded' && <Button size="sm" variant="accent" disabled={busy} onClick={() => void run(updateInstall)}>{t('about.updates.restartAndInstall')}</Button>}
      {!update.mandatory && <Button size="sm" disabled={busy} onClick={() => setDismissed(true)}>{t('about.updates.later')}</Button>}
    </div>
  )
}
