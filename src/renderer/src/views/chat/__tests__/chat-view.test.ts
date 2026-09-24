import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../../shared/agent/message'
import { emptyTranscript } from '../../../../../shared/agent/transcript'
import { makeQueuedInput } from '../../../../../shared/domain/queued-input'
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

/**
 * 清单的「还在跑吗」是 ChatView 推出来、交给 TaskChecklist 展示的。
 * 这里钉住三档在真实转录数据下的切换：唯一判据是**当前 run 自己写成功过清单**。
 */
describe('chat task checklist execution', () => {
  it('keeps historical and unconfirmed lists as snapshots and stops only the current confirmed list', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: {
      getPathForFile: () => '',
      on: () => () => {},
      invoke: async (channel: string) => ({ ok: true, data: channel === 'agent:listInteractions' ? []
        : channel === 'goal:get' ? undefined
          // 本用例的转录带着 runId，回合底部的改动审查卡会去拉改动集 —— 这里没有改动集
          : channel === 'review:getChangeSet' ? null
            : { messages: [], session: { id: 'checklist-run', workspaceId: 'workspace', model: '', mode: 'code' } } })
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
    const session = sessionStore('checklist-run')
    const workspace: Workspace = { id: 'workspace', name: 'Workspace', rootPath: '/workspace',
      createdAt: 1, lastOpenedAt: 1, settings: { ...DEFAULT_WORKSPACE_SETTINGS } }
    const legacyCall = assistantMessage('legacy-call', [
      { type: 'tool_call', callId: 'legacy-1', name: 'TodoWrite',
        input: { todos: [{ content: 'Legacy step', activeForm: 'Doing a legacy step', status: 'in_progress' }] } }
    ], 2)
    const legacyResult = toolResultMessage('legacy-result', [
      { type: 'tool_result', callId: 'legacy-1', output: { content: 'ok' }, isError: false }
    ], 3)
    const messages = [userMessage('user', [{ type: 'text', text: 'Do the work' }], 1), legacyCall, legacyResult]
    session.setState({
      transcript: { ...emptyTranscript(), status: 'done', messages, messageRuns: { 'legacy-call': 'run-1', 'legacy-result': 'run-1' } },
      activeRunId: null
    })
    // 输入框上方那条排在转录之后；工具卡片展开时同屏会有第二条，所以只取最后一条。
    const lastChecklist = (): Element | null => {
      const lists = container.querySelectorAll('[data-testid="task-checklist"]')
      return lists[lists.length - 1] ?? null
    }
    const executionState = (): string | null => lastChecklist()?.getAttribute('data-execution-state') ?? null
    const spinners = (): number => lastChecklist()?.querySelectorAll('.lucide-loader-circle').length ?? -1
    try {
      await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'en-US', children:
        createElement(ChatView, { sessionId: 'checklist-run', tabId: 'fixture-tab', workspace, fallbackModel: { model: '' } }) })))
      /*
        需求:输入框上方那条清单挂载时就是**一颗小球**(见 `TaskChecklist.minimizeToBall`),
        而这个用例要断言的正是清单内容 —— 先点开它,一次点击到完全展开。
      */
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-checklist-ball"]')?.click())
      // 需求：重载的历史没有本窗口的 run_end 事实，只能显示快照，不能报本轮未完成。
      expect(executionState()).toBe('snapshot')
      expect(spinners()).toBe(0)
      expect(lastChecklist()?.textContent).not.toContain('Doing a legacy step')
      expect(lastChecklist()?.textContent).not.toContain('Run ended with')

      await act(async () => session.setState({
        activeRunId: 'run-2',
        transcript: { ...session.getState().transcript, status: 'running', runStartedAt: 3 }
      }))
      expect(executionState()).toBe('snapshot')

      const currentCall = assistantMessage('current-call', [
        { type: 'tool_call', callId: 'current-1', name: 'TodoWrite', input: { todos: [
          { content: 'Wire checklist', activeForm: 'Wiring the checklist', status: 'in_progress' },
          { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
          { content: 'Write report', activeForm: 'Writing the report', status: 'completed' }
        ] } }
      ], 4)
      const currentResult = toolResultMessage('current-result', [
        { type: 'tool_result', callId: 'current-1', output: { content: 'ok' }, isError: false }
      ], 5)
      // 需求：长工具同批等待时可能只有 call；没有成功回执，不得提前采纳这份清单。
      await act(async () => session.getState().applyEvents([{ type: 'message_commit', message: currentCall }]))
      expect(executionState()).toBe('snapshot')
      expect(spinners()).toBe(0)
      expect(lastChecklist()?.textContent).toContain('Legacy step')

      // 走真实事件入口，确认 tool_result 同样归入当前 run，配对成功后才变成实时进度。
      await act(async () => session.getState().applyEvents([{ type: 'message_commit', message: currentResult }]))
      expect(executionState()).toBe('running')
      expect(spinners()).toBe(1)
      expect(lastChecklist()?.textContent).toContain('Wiring the checklist')

      // run_end 清空 activeRunId，而清单还剩两项没做完。
      await act(async () => session.getState().applyEvents([{ type: 'run_end', status: 'done', at: 6 }]))
      expect(executionState()).toBe('stopped')
      expect(spinners()).toBe(0)
      expect(lastChecklist()?.textContent).not.toContain('Wiring the checklist')
      expect(lastChecklist()?.textContent).toContain('Run ended with 2 unfinished task(s)')

      // 需求：无关的新问题结束后，旧清单仍是快照，不能把旧阻塞算到新一轮头上。
      await act(async () => session.setState({ activeRunId: 'run-3', transcript: {
        ...session.getState().transcript, status: 'running', runStartedAt: 7, runEndedAt: undefined
      } }))
      await act(async () => session.getState().applyEvents([
        { type: 'message_commit', message: userMessage('unrelated-user', [{ type: 'text', text: 'Another question' }], 7) },
        { type: 'message_commit', message: assistantMessage('unrelated-answer', [{ type: 'text', text: 'Another answer' }], 8) },
        { type: 'run_end', status: 'done', at: 9 }
      ]))
      expect(executionState()).toBe('snapshot')
      expect(lastChecklist()?.textContent).not.toContain('Run ended with')
      expect(lastChecklist()?.textContent).toContain('Task checklist · 1/3 completed')

      /*
        需求:清单收起来时是**一颗小球**,而它不许自己再占一行 —— 和发送队列共用
        `composer-notices` 那一行(见 ChatView 里那段注释)。队列在跑完一轮后会被立刻
        消费掉,所以这一步放在最后:这里只是把一条队列条目摆上去。
      */
      await act(async () => session.setState({
        queuedInputs: [makeQueuedInput('queued-1', 'Queued follow-up', {
          workspaceId: workspace.id,
          depth: 0,
          mode: 'code',
          thinking: 'auto',
          webSearch: false,
          permissionMode: 'auto',
          model: '',
          skillIds: []
        }, 1)]
      }))
      await act(async () => (lastChecklist()?.querySelector('[aria-controls]') as HTMLButtonElement).click())
      const notices = container.querySelector('[data-testid="composer-notices"]')
      expect(notices?.querySelector('[data-testid="pending-queue"]')).not.toBeNull()
      expect(notices?.querySelector('[data-testid="task-checklist-ball"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      releaseSession('checklist-run')
      useModelsStore.setState(models, true)
      vi.restoreAllMocks()
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})