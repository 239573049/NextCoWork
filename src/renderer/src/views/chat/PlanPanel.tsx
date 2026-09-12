import { useEffect, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { listPlansV2, onAgentEvent } from '../../services/agent'
import { sessionStore } from '../../stores/session'

export function PlanPanel({ sessionId, onRetry }: { sessionId: string; onRetry?: (ref: { planId: string; version: number }) => void }): ReactNode {
  const { t } = useI18n()
  const useSession = sessionStore(sessionId)
  const plan = useSession((state) => state.currentPlan)
  const expanded = useSession((state) => state.planExpanded)
  const setExpanded = useSession((state) => state.setPlanExpanded)
  useEffect(() => {
    let disposed = false
    let queryVersion = 0
    const refresh = (): void => { const current = ++queryVersion; void listPlansV2(sessionId).then((items) => { if (!disposed && current === queryVersion) useSession.getState().setCurrentPlan(items[0] ?? null) }).catch(() => undefined) }
    const off = onAgentEvent((envelope) => { if (envelope.events.some((event) => event.type === 'run_end' || (('sessionId' in event) && event.sessionId === sessionId && (event.type.startsWith('plan_'))))) refresh() })
    refresh()
    return () => { disposed = true; off() }
  }, [sessionId, useSession])
  if (plan === null) return null
  const completed = plan.plan.filter((step) => step.status === 'completed').length
  const lifecycle = t(`agent.plan.lifecycle.${plan.lifecycle}`)
  return <section className="mb-2 rounded-card border border-border bg-surface-raised px-3 py-2" aria-live="polite">
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <div className="min-w-0"><div className="truncate font-medium">{plan.explanation ?? t('agent.interaction.plan')}</div><div className="text-[11px] text-fg-faint">{t('agent.plan.progress', { completed: String(completed), total: String(plan.plan.length) })} · {lifecycle} · {t('agent.interaction.planVersion', { version: String(plan.version) })}</div></div>
      <div className="flex shrink-0 items-center gap-2"><button type="button" className="text-[12px] text-accent" onClick={() => setExpanded(!expanded)}>{t(expanded ? 'agent.interaction.collapsePlan' : 'agent.interaction.expandPlan')}</button>{plan.lifecycle === 'failed' && onRetry !== undefined && <button type="button" className="text-[12px] text-accent" onClick={() => onRetry({ planId: plan.id, version: plan.version })}>{t('agent.plan.retry')}</button>}</div>
    </div>
    {expanded && <ol className="mt-2 ml-5 list-decimal space-y-1 text-[12px] text-fg-muted">{plan.plan.map((step) => <li key={step.id}><span className={step.status === 'completed' ? 'text-fg-faint line-through' : 'text-fg'}>{step.step}</span><span className="ml-2 text-[11px] text-fg-faint">{t(`agent.plan.step.${step.status}`)}</span></li>)}</ol>}
  </section>
}
