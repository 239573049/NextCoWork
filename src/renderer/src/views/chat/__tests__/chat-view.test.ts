import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { assistantMessage, userMessage } from '../../../../../shared/agent/message'
import { emptyTranscript } from '../../../../../shared/agent/transcript'
import { DEFAULT_WORKSPACE_SETTINGS, type Workspace } from '../../../../../shared/domain/workspace'
import { I18nProvider } from '../../../i18n'
import { pickAttachments, uploadFile } from '../../../services/attachment'
import { AttachmentTray } from '../AttachmentTray'
import { useModelsStore } from '../../../stores/models'
import { releaseSession, sessionStore } from '../../../stores/session'
import { ChatView } from '../ChatView'
import type { Composer } from '../Composer'
import * as content from '../thread-content'

vi.mock('../../../services/app', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/app')>(),
  getInnerTabs: vi.fn(async () => ({ tabs: [], activeTabId: null })),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn(),
  getSessionInput: vi.fn(async () => null),
  persistSessionInput: vi.fn(),
  updateWorkspace: vi.fn()
}))
vi.mock('../../../services/attachment', () => ({
  listSessionAttachments: vi.fn(async () => []),
  pickAttachments: vi.fn(async () => [{ kind: 'path', path: '/workspace/fixture.txt', name: 'fixture.txt' }]),
  removeAttachment: vi.fn(),
  uploadFile: vi.fn()
}))
vi.mock('../Composer', () => ({
  Composer: (props: ComponentProps<typeof Composer>) => createElement('div', null,
    createElement('input', { 'data-testid': 'draft', readOnly: true, value: props.draft }),
    createElement('button', { 'data-testid': 'attach', onClick: props.onPickAttachment }),
    createElement('button', { 'data-testid': 'attach-unknown-mime', onClick: () => props.onAttachFiles?.([
      new File(['pixels'], 'photo.png', { type: 'application/octet-stream' })
    ]) }),
    createElement('button', { 'data-testid': 'attach-without-path', onClick: () => props.onAttachFiles?.([
      new File(['text'], 'document.txt', { type: 'text/plain' })
    ]) }),
    createElement('output', null, props.attachments?.length ?? 0),
    createElement('span', { 'data-testid': 'attachment-errors' }, props.attachments?.map((item) => item.error ?? '').join('|')),
    createElement(AttachmentTray, { items: props.attachments ?? [], onRemove: props.onRemoveAttachment ?? (() => {}), onRetry: props.onRetryAttachment ?? (() => {}) }))
}))

describe('chat history subscription boundary', () => {
  it('skips history work for draft, attachment and same-length queue edits', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: {
      getPathForFile: () => '',
      on: () => () => {},
      invoke: async (channel: string) => ({ ok: true, data: channel === 'agent:listInteractions' ? []
        : channel === 'goal:get' ? undefined
          : { messages: [], session: { id: 'history-boundary', workspaceId: 'workspace', model: '', mode: 'code' } } })
    } })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const container = document.getElementById('root')!
    const root = createRoot(container)
    const models = useModelsStore.getState()
    useModelsStore.setState({ loaded: true })
    const session = sessionStore('history-boundary')
    const messages = [
      userMessage('user', [{ type: 'text', text: 'Question' }], 1),
      assistantMessage('answer', [{ type: 'text', text: 'Answer' }], 2)
    ]
    session.setState({ transcript: { ...emptyTranscript(), status: 'done', messages } })
    const workspace: Workspace = { id: 'workspace', name: 'Workspace', rootPath: '/workspace',
      createdAt: 1, lastOpenedAt: 1, settings: { ...DEFAULT_WORKSPACE_SETTINGS } }
    const rows = vi.spyOn(content, 'threadRows')
    try {
      await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'en-US', children:
        createElement(ChatView, { sessionId: 'history-boundary', tabId: 'fixture-tab', workspace, fallbackModel: { model: '' } }) })))
      expect(rows).toHaveBeenCalled()
      rows.mockClear()
      for (let index = 0; index < 5; index++) {
        await act(async () => session.getState().setDraft(`Draft ${index}`))
      }
      expect((container.querySelector('[data-testid="draft"]') as HTMLInputElement).value).toBe('Draft 4')
      await act(async () => (container.querySelector('[data-testid="attach"]') as HTMLButtonElement).click())
      expect(container.querySelector('output')?.textContent).toBe('1')
      vi.mocked(pickAttachments).mockResolvedValueOnce([
        { kind: 'error', name: 'drawing.svg', error: { code: 'unknown', retryable: false, message: 'internal fallback',
          messageKey: 'attachment.error.unsupportedImage', messageParams: { mime: 'image/svg+xml' } } },
        { kind: 'path', name: 'other.txt', path: '/workspace/other.txt' }
      ])
      await act(async () => (container.querySelector('[data-testid="attach"]') as HTMLButtonElement).click())
      expect(container.querySelector('output')?.textContent).toBe('3')
      expect(container.querySelector('[data-testid="attachment-errors"]')?.textContent).toContain('Image format "image/svg+xml" is not supported')
      expect(container.textContent).not.toContain('internal fallback')
      const failedChip = container.querySelector('[data-testid="attachment-chip"][data-status="error"]')!
      expect(failedChip.querySelectorAll('button')).toHaveLength(1)
      expect(failedChip.querySelector('[data-testid="attachment-remove"]')).not.toBeNull()
      vi.mocked(uploadFile).mockResolvedValueOnce({ id: 'photo', scope: 'session', ownerId: 'history-boundary',
        displayName: 'photo.png', mime: 'image/png', size: 6, checksum: 'fixture', createdAt: 1,
        url: 'ncw://attachments/sessions/history-boundary/photo.png' })
      await act(async () => (container.querySelector('[data-testid="attach-unknown-mime"]') as HTMLButtonElement).click())
      expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'photo.png', type: 'application/octet-stream' }), 'session', 'history-boundary')
      expect(container.querySelector('output')?.textContent).toBe('4')
      expect(container.querySelector('img[src="ncw://attachments/sessions/history-boundary/photo.png"]')).not.toBeNull()
      await act(async () => (container.querySelector('[data-testid="attach-without-path"]') as HTMLButtonElement).click())
      const failedChips = container.querySelectorAll('[data-testid="attachment-chip"][data-status="error"]')
      expect(failedChips).toHaveLength(2)
      for (const chip of failedChips) expect(chip.querySelectorAll('button')).toHaveLength(1)
      await act(async () => session.setState({ queuedInputs: [...session.getState().queuedInputs] }))
      expect(rows).not.toHaveBeenCalled()
      await act(async () => session.setState({ transcript: {
        ...session.getState().transcript,
        messages: [...messages, userMessage('next', [{ type: 'text', text: 'Continue' }], 3)]
      } }))
      expect(rows).toHaveBeenCalled()
      expect(container.textContent).toContain('Continue')
    } finally {
      await act(async () => root.unmount())
      releaseSession('history-boundary')
      useModelsStore.setState(models, true)
      vi.restoreAllMocks()
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})