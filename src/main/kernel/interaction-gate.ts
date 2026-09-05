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
      // Persistent permission grants are deliberately not accepted without a rule store.
    }
    case 'ask_user':
      return response.answer === null || (typeof response.answer === 'string' && response.answer.length <= 32768
        && pending.kind === 'ask_user' && (pending.allowFreeform || pending.choices?.includes(response.answer) === true))
    case 'plan_approval':
      return typeof response.approved === 'boolean' && (response.feedback === undefined || typeof response.feedback === 'string')
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
