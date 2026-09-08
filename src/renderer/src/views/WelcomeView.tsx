import { ArrowRight, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Mark } from '../components/brand/Mark'
import { cn } from '../lib/cn'
import { startClientLogin, useOffline } from '../services/client-auth'
import { useI18n } from '../i18n'

export function WelcomeView({ onComplete }: { onComplete: () => void }): ReactNode {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const login = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await startClientLogin(); onComplete() } catch { setError(t('auth.loginFailed')) } finally { setBusy(false) }
  }
  const offline = async (): Promise<void> => { setBusy(true); setError(null); try { await useOffline(); onComplete() } catch { setError(t('auth.offlineFailed')) } finally { setBusy(false) } }
  return (
    <main className="relative flex h-full items-center justify-center overflow-hidden bg-[#171918] text-white">
      <div className="app-drag absolute inset-x-0 top-0 h-10" aria-hidden="true" />
      <div className="relative flex w-[360px] flex-col items-center px-6 text-center">
        <div className="mb-5 flex items-center gap-3 text-[32px] font-semibold tracking-[-0.04em]">
          <Mark size={38} className="text-white" />
          <span>NextCoWork</span>
        </div>
        <p className="mb-9 text-[14px] text-white/45">{t('auth.tagline')}</p>
        <button type="button" disabled={busy} onClick={() => void login()} className="group flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent text-[14px] font-medium text-accent-fg transition hover:brightness-110 disabled:opacity-60">
          {busy ? t('auth.openingBrowser') : t('auth.login')}
          {!busy && <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />}
        </button>
        <button type="button" disabled={busy} onClick={() => void offline()} className="mt-5 text-[13px] text-accent transition hover:text-white disabled:opacity-60">{t('auth.useOffline')}</button>
        <div className="mt-7 flex items-center gap-2 text-[11px] text-white/30"><ShieldCheck size={14} />{t('auth.localHint')}</div>
        {error && <p className="mt-4 text-[12px] text-danger">{error}</p>}
        <p className={cn('mt-3 text-[11px] text-white/25', error && 'mt-2')}>{t('auth.offlineHint')}</p>
      </div>
    </main>
  )
}
