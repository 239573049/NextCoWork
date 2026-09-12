import type { InteractionResponse, PendingInteraction } from '../../shared/agent/interaction'
import { ulid } from '../../shared/util/id'
import type { RunHandle } from './run-registry'

type Draft<T> = T extends PendingInteraction ? Omit<T, 'id' | 'runId' | 'createdAt'> : never
export type InteractionDraft = Draft<PendingInteraction>
export type InteractFn = (draft: InteractionDraft) => Promise<InteractionResponse>

interface Entry {
  interaction: PendingInteraction
  handle: RunHandle
  answer(response: InteractionResponse): void
  abort(): void
}

function validResponse(pending: PendingInteraction, response: InteractionResponse): boolean {
  if (response === null || typeof response !== 'object' || response.kind !== pending.kind) return false
  switch (response.kind) {
    case 'tool_permission': {
      const decision = response.decision
      if (decision === null || typeof decision !== 'object') return false
      return decision.kind === 'allow_once'
        || (decision.kind === 'allow_edited' && Object.hasOwn(decision, 'input'))
        || (decision.kind === 'deny' && (decision.reason === undefined || typeof decision.reason === 'string'))
        // ★ 只收 workspace:它落在 `.next-cowork/settings.local.json` 里,有真实的规则库兜着。
        // `session` 作用域还没有对应的存放处,收下它等于收下一个不会生效的承诺。
        // 规则文本不从这里进 —— 主进程用待决项里那条 `suggestedRule` 自己算。
        || (decision.kind === 'allow_always' && decision.scope === 'workspace')
    }
    case 'ask_user': {
      if (pending.kind !== 'ask_user') return false
      if (response.answers === null) return true
      // 长度必须严格等于题数:少一项说明渲染层和待决表已经不是同一份题面
      // (窗口重载时抢答),这时按下标对齐会把答案安到别的题上。
      if (!Array.isArray(response.answers) || response.answers.length !== pending.questions.length) return false
      return response.answers.every((answer, index) => {
        const question = pending.questions[index]!
        if (!Array.isArray(answer) || answer.length === 0) return false
        if (!question.multiSelect && answer.length > 1) return false
        if (new Set(answer).size !== answer.length) return false
        return answer.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 32768
          && (question.allowFreeform || question.options.some((option) => option.label === value)))
      })
    }
    case 'plan_approval':
      if ('approved' in response) return pending.kind === 'plan_approval' && pending.planId === undefined && typeof response.approved === 'boolean' && (response.feedback === undefined || typeof response.feedback === 'string')
      if (pending.kind !== 'plan_approval') return false
      return typeof response.action === 'string'
        && ['approve_current', 'approve_new_session', 'request_revision', 'reject'].includes(response.action)
        && typeof response.planId === 'string'
        && typeof response.version === 'number'
        && pending.planId === response.planId
        && pending.planVersion === response.version
        && (response.feedback === undefined || typeof response.feedback === 'string')
        && (response.action !== 'request_revision' || (response.feedback !== undefined && response.feedback.trim() !== ''))
  }
}

/** Authoritative pending state stays in the main process while renderer windows reload. */
export class InteractionGate {
  private readonly pending = new Map<string, Entry>()

  request(handle: RunHandle, draft: InteractionDraft, now: number): Promise<InteractionResponse> {
    handle.signal.throwIfAborted()
    if (handle.status !== 'running') return Promise.reject(new Error('Run is no longer active'))
    const interaction = { ...structuredClone(draft), id: ulid(now), runId: handle.runId, createdAt: now } as PendingInteraction
    return new Promise((resolve, reject) => {
      let off: () => void = () => {}
      const clean = (): void => {
        this.pending.delete(interaction.id)
        handle.signal.removeEventListener('abort', abort)
        off()
      }
      const abort = (): void => {
        if (!this.pending.has(interaction.id)) return
        clean()
        if (handle.status === 'running') handle.emit({ type: 'interaction_resolved', id: interaction.id, outcome: { status: 'aborted' } })
        else {
          const index = handle.pendingInteractions.findIndex((p) => p.id === interaction.id)
          if (index >= 0) handle.pendingInteractions.splice(index, 1)
        }
        reject(new DOMException('aborted', 'AbortError'))
      }
      this.pending.set(interaction.id, {
        interaction, handle, abort,
        answer: (response) => {
          clean()
          handle.emit({ type: 'interaction_resolved', id: interaction.id, outcome: { status: 'answered', response } })
          resolve(response)
        }
      })
      handle.signal.addEventListener('abort', abort, { once: true })
      off = handle.on((event) => { if (event.type === 'run_end') abort() })
      handle.emit({ type: 'interaction_request', interaction })
    })
  }

  get(id: string): PendingInteraction | undefined {
    const pending = this.pending.get(id)?.interaction
    return pending === undefined ? undefined : structuredClone(pending)
  }

  list(): PendingInteraction[] {
    return [...this.pending.values()].map((entry) => structuredClone(entry.interaction))
  }

  respond(response: InteractionResponse): void {
    const entry = this.pending.get(response?.id)
    if (entry === undefined || entry.handle.signal.aborted || entry.handle.status !== 'running') {
      throw new Error('Interaction is no longer pending')
    }
    if (!validResponse(entry.interaction, response)) throw new Error('Invalid interaction response')
    entry.answer(structuredClone(response))
  }

  clear(): void {
    for (const entry of [...this.pending.values()]) entry.abort()
  }
}

export const interactions = new InteractionGate()
