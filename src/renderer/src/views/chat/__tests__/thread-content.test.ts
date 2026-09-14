import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { assistantMessage, toolResultMessage, userMessage } from '../../../../../shared/agent/message'
import { emptyTranscript, toolsFromMessages, type TranscriptState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { Thread } from '../Thread'
import type { ContextCheckpoint } from '../../../../../shared/agent/context-management'
import {
  assistantSegments,
  assistantText,
  isAssistantTextBlock,
  lastTurnIndex,
  promptOf,
  threadRows,
  unanchoredCheckpoints,
  type ThreadRow
} from '../thread-content'

describe('thread content grouping', () => {
  it('joins consecutive assistant tool messages across hidden tool receipts', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'tool_call', callId: 'bash', name: 'Bash', input: {} }], 4),
      toolResultMessage('r2', [{ type: 'tool_result', callId: 'bash', output: { content: 'ok' }, isError: false }], 5),
      assistantMessage('a3', [{ type: 'text', text: 'Done' }], 6)
    ]
    const rows = threadRows(messages, [], false)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant'])
    expect(rows[1]?.kind === 'assistant' ? rows[1].blocks.length : 0).toBe(3)
  })

  it('tags a merged assistant turn with the run that produced it', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)
    ]
    // The whole turn belongs to one run, so either committed message can carry it.
    const rows = threadRows(messages, [], false, { a1: 'run-1', a2: 'run-1' })
    expect(rows[1]?.kind === 'assistant' ? rows[1].runId : undefined).toBe('run-1')
  })

  it('carries a run recorded only on the tail of a partially migrated turn', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'tool_call', callId: 'read', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)
    ]
    expect(threadRows(messages, [], false, { a2: 'run-1' })[1])
      .toMatchObject({ kind: 'assistant', runId: 'run-1' })
  })

  it('leaves a turn from before the migration without a run', () => {
    const messages = [
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 2)
    ]
    // Undefined means "unknown", which renders no usage at all — a placeholder
    // run id would instead render a confident, wrong zero.
    const rows = threadRows(messages, [], false)
    expect(rows[1]?.kind === 'assistant' ? rows[1].runId : 'set').toBeUndefined()
  })

  it('keeps the live reply keys aligned with the eventual committed parts', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const live = threadRows([user], [{ index: 0, kind: 'text', text: 'Working' }], true)
    const committed = threadRows([user, assistantMessage('a', [{ type: 'text', text: 'Working' }], 2)], [], false)
    const liveBlock = live[1]?.kind === 'assistant' ? live[1].blocks[0] : undefined
    const committedBlock = committed[1]?.kind === 'assistant' ? committed[1].blocks[0] : undefined
    expect(liveBlock?.key).toBe(committedBlock?.key)
  })

  it('marks thinking as finished once a later text block starts streaming', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const rows = threadRows([user], [
      { index: 0, kind: 'thinking', text: 'Reasoning' },
      { index: 1, kind: 'text', text: 'Inspecting repository...' }
    ], true)
    const row = rows[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return

    expect(row.blocks[0]?.streaming).toBe(false)
    expect(row.blocks[1]?.streaming).toBe(true)
    expect(assistantSegments(row.blocks, 'tool')[0]).toMatchObject({
      kind: 'process',
      items: [{ kind: 'thinking', streaming: false }]
    })
  })

  it('keeps a user-to-answer time range for historical duration fallback', () => {
    const rows = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1_000),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 4_500)
    ], [], false)
    const answer = rows[1]
    expect(answer?.kind).toBe('assistant')
    if (answer?.kind !== 'assistant') return
    expect(answer.startedAt).toBe(1_000)
    expect(answer.endedAt).toBe(4_500)
  })

  it('does not render tool receipts as user content and preserves prose order', () => {
    const user = userMessage('u', [{ type: 'text', text: 'Inspect' }], 1)
    const blocks = threadRows([user, assistantMessage('a', [
      { type: 'tool_call', callId: 'read', name: 'Read', input: {} },
      { type: 'text', text: 'Done' }
    ], 2)], [], false)[1]
    expect(blocks?.kind).toBe('assistant')
    if (blocks?.kind !== 'assistant') return
    const segments = assistantSegments(blocks.blocks, 'tool')
    expect(segments.map((segment) => segment.kind)).toEqual(['process', 'block'])
  })

  it('recognizes the final non-empty assistant text block', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'text', text: 'Done' }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(isAssistantTextBlock(row.blocks[0]!)).toBe(true)
  })

  it('does not treat a thinking block as the final answer', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [{ type: 'thinking', text: 'Working' }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(isAssistantTextBlock(row.blocks[0]!)).toBe(false)
  })
})

describe('assistant turn plain text', () => {
  it('copies prose only, leaving thinking and tool calls out', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a', [
        { type: 'thinking', text: 'Let me look around first' },
        { type: 'text', text: 'Checked the config.' },
        { type: 'tool_call', callId: 'read', name: 'Read', input: {} }
      ], 2),
      toolResultMessage('r', [{ type: 'tool_result', callId: 'read', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'It is fine.' }], 4)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('Checked the config.\n\nIt is fine.')
  })

  it('reads a still-streaming reply', () => {
    const row = threadRows([userMessage('u', [{ type: 'text', text: 'Hi' }], 1)],
      [{ index: 0, kind: 'text', text: 'Half a sen' }], true)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('Half a sen')
  })

  it('is empty for a turn that only ran tools', () => {
    const row = threadRows([
      userMessage('u', [{ type: 'text', text: 'Run it' }], 1),
      assistantMessage('a', [{ type: 'tool_call', callId: 'bash', name: 'Bash', input: {} }], 2)
    ], [], false)[1]
    expect(row?.kind).toBe('assistant')
    if (row?.kind !== 'assistant') return
    expect(assistantText(row.blocks)).toBe('')
  })
})

describe('completed turn rendering', () => {
  it('retains the process subtree and user expansion when another turn starts or is removed', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const container = document.getElementById('root')!
    const root = createRoot(container)
    const messages = [
      userMessage('first-user', [{ type: 'text', text: 'Inspect' }], 1),
      ...Array.from({ length: 250 }, (_, index) => [
        assistantMessage(`step-${index}`, [
          { type: 'text', text: `Intermediate ${index}` },
          { type: 'tool_call', callId: `call-${index}`, name: 'Read', input: {} }
        ], index * 2 + 2),
        toolResultMessage(`result-${index}`, [{ type: 'tool_result', callId: `call-${index}`, output: { content: 'ok' }, isError: false }], index * 2 + 3)
      ]).flat(),
      assistantMessage('answer', [{ type: 'text', text: 'Final answer' }], 1000)
    ]
    const transcript = { ...emptyTranscript(), messages, tools: toolsFromMessages(messages), status: 'done' as const }
    const render = async (current: TranscriptState, runId: string | null = null): Promise<void> => {
      await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'en-US', children:
        createElement(Thread, { transcript: current, runId, lastSeq: 0, queued: 0, model: undefined, providerName: undefined }) })))
    }
    try {
      await render(transcript)
      const process = container.querySelector('[data-testid="run-process-block"]')!
      const answer = [...container.querySelectorAll('p')].find((element) => element.textContent === 'Final answer')
      expect(process.getAttribute('data-open')).toBe('false')
      expect(container.textContent).not.toContain('Intermediate')
      const next = { ...transcript, messages: [...messages, userMessage('next-user', [{ type: 'text', text: 'Continue' }], 1001)], status: 'running' as const }
      await render(next, 'next-run')
      expect(container.querySelector('[data-testid="run-process-block"]')).toBe(process)
      expect(container.textContent).not.toContain('Intermediate')
      expect([...container.querySelectorAll('p')].find((element) => element.textContent === 'Final answer')).toBe(answer)
      await act(async () => (process.querySelector('button') as HTMLButtonElement).click())
      const intermediate = [...container.querySelectorAll('p')].find((element) => element.textContent === 'Intermediate 0')
      expect(intermediate).toBeDefined()
      await render({ ...next, status: 'error' })
      await render(transcript)
      expect(container.querySelector('[data-testid="run-process-block"]')).toBe(process)
      expect(process.getAttribute('data-open')).toBe('true')
      expect([...container.querySelectorAll('p')].find((element) => element.textContent === 'Intermediate 0')).toBe(intermediate)
      for (const status of ['error', 'aborted'] as const) {
        const failedMessages = [
          userMessage(`${status}-user`, [{ type: 'text', text: 'Inspect' }], 1),
          ...messages.slice(1, 3),
          messages.at(-1)!
        ]
        await render({ ...transcript, messages: failedMessages, status })
        expect(container.querySelector('[data-testid="run-process-block"]')).toBeNull()
        await render({ ...transcript, messages: [
          ...failedMessages, userMessage(`${status}-retry`, [{ type: 'text', text: 'Retry' }], 1001)
        ], status: 'running' }, `${status}-retry-run`)
        expect(container.querySelector('[data-testid="run-process-block"]')).toBeNull()
        expect(container.textContent).toContain('Intermediate 0')
      }
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 压缩分隔线的插入规则。
 *
 * ★ 这一组里有两条「破了也不报错」的:`promptOf` 拿到分隔线会让最新一轮的
 * 「重新生成 / 删除这一轮」**无声消失**;`lastTurnIndex` 退回按数组末尾比,
 * 手动压缩后状态行整块不渲染。两者都不抛异常,只能靠断言钉住。
 */
describe('compaction dividers', () => {
  const cp = (over: Partial<ContextCheckpoint> = {}): ContextCheckpoint => ({
    id: 'c1',
    sessionId: 's',
    windowIndex: 1,
    note: '折叠了 14 条消息',
    source: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    ...over
  })

  const user = userMessage('u1', [{ type: 'text', text: 'Inspect' }], 1)
  const answer = assistantMessage('a1', [{ type: 'text', text: 'Done' }], 2)

  /** ★ 本组最值钱的一条:自动压缩最常见的锚点就是刚发出的那条提问 */
  it('★ 锚在提问上时线落在提问与回答之间,且提问仍查得到', () => {
    const rows = threadRows([user, answer], [], false, {}, [cp({ coveredThroughMessageId: 'u1' })])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'divider', 'assistant'])
    // 隔着一条分隔线,`rows[index - 1]` 拿到的是线 —— 必须向上跳过去
    expect(promptOf(rows, 2)?.id).toBe('u1')
  })

  /** ★ 手动压缩锚在整段最后一条上,那时分隔线就是数组末尾 */
  it('★ 线落在末尾时,末轮仍是那个助手回合', () => {
    const rows = threadRows([user, answer], [], false, {}, [cp({ coveredThroughMessageId: 'a1' })])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'divider'])
    expect(lastTurnIndex(rows)).toBe(1)
  })

  /**
   * ★ 锚点常常是一条**界面上不存在**的工具回执。跟着可见性过滤一起跳过去的话,
   * 「工具回合之间压缩」那条线一条都画不出来,而且不报错。
   *
   * ★ **线切在锚点上,哪怕这把刀落在一轮内部。** 这里曾经是「一轮绝不切开、
   * 线推迟到轮末」—— 而工具循环里根本没有轮末:一整个会话可以是 1 条提问 +
   * 50 条工具回执,线于是一路挂到整段最底部,压在状态行下面不动窝。
   */
  it('★ 锚在工具回执上时线落在回执处,把那一轮切成两行', () => {
    const messages = [
      user,
      assistantMessage('a1', [{ type: 'tool_call', callId: 'r', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'r', output: { content: 'ok' }, isError: false }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)
    ]
    const rows = threadRows(messages, [], false, {}, [cp({ coveredThroughMessageId: 'r1' })])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'divider', 'assistant'])
    // 线**上方**只留压缩覆盖到的那部分,下方是压缩之后才发生的事
    expect(rows[1]?.kind === 'assistant' ? rows[1].blocks.length : 0).toBe(1)
    expect(rows[3]?.kind === 'assistant' ? rows[3].blocks.length : 0).toBe(1)
    // 切开之后「重新生成 / 删除这一轮」仍要找得回那条提问
    expect(promptOf(rows, 3)?.id).toBe('u1')
  })

  /**
   * ★ **切开不等于重挂 —— 这是选「切开」而不是「推迟」的前提。**
   *
   * 行 key 取的是创建那一瞬的 `preceding`,而工具回执不可见、不推进 `preceding`:
   * 所以线下方那一行从流式创建到提交拿的是同一个值,key 一个字节不变。
   * 变了就是整棵子树重挂:markdown 重渲、工具组展开状态丢失、滚动跳一下。
   */
  it('★ 锚在工具回执上时,线下方那一行的 key 在提交前后不变', () => {
    const head = [
      user,
      assistantMessage('a1', [{ type: 'tool_call', callId: 'r', name: 'Read', input: {} }], 2),
      toolResultMessage('r1', [{ type: 'tool_result', callId: 'r', output: { content: 'ok' }, isError: false }], 3)
    ]
    const anchor = [cp({ coveredThroughMessageId: 'r1' })]
    const live = threadRows(head, [{ index: 0, kind: 'text', text: 'Done' }], true, {}, anchor)
    const committed = threadRows(
      [...head, assistantMessage('a2', [{ type: 'text', text: 'Done' }], 4)], [], false, {}, anchor
    )
    expect(live.map((row) => row.kind)).toEqual(['user', 'assistant', 'divider', 'assistant'])
    expect(live.at(-1)?.key).toBe(committed.at(-1)?.key)
    // 块 key 也要对得上,否则重挂的是块而不是行 —— 症状一样
    const blockKeys = (row: ThreadRow | undefined): string[] =>
      row?.kind === 'assistant' ? row.blocks.map((b) => b.key) : []
    expect(blockKeys(live.at(-1))).toEqual(blockKeys(committed.at(-1)))
  })

  /**
   * ★ 锚在整段最后一条消息上时(手动压缩),线就是数组末尾 ——
   * 不能在它**下面**再补一个空回合出来。
   */
  it('★ 线落在末尾时不补空回合', () => {
    const rows = threadRows([user, answer], [], false, {}, [cp({ coveredThroughMessageId: 'a1' })])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'divider'])
  })

  /**
   * ★ 行 key 在提交前后必须一致 —— 变了就是整棵子树重挂:markdown 重渲、
   * 工具组的展开状态丢失、滚动跳一下。所以线宁可晚半轮。
   */
  it('★ 一轮内部的锚点不改变行 key', () => {
    const live = threadRows([user], [{ index: 0, kind: 'text', text: 'Working' }], true, {}, [
      cp({ coveredThroughMessageId: 'u1' })
    ])
    const committed = threadRows([user, assistantMessage('a', [{ type: 'text', text: 'Working' }], 2)], [], false, {}, [
      cp({ coveredThroughMessageId: 'u1' })
    ])
    expect(live.map((row) => row.kind)).toEqual(['user', 'divider', 'assistant'])
    expect(live.at(-1)?.key).toBe(committed.at(-1)?.key)
  })

  it('锚不住的检查点不产出分隔线,而是交给顶部面板兜底', () => {
    const old = cp({ id: 'c0' })
    const gone = cp({ id: 'c2', coveredThroughMessageId: 'deleted' })
    const rows = threadRows([user, answer], [], false, {}, [old, gone])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant'])
    expect(unanchoredCheckpoints([user, answer], [old, gone]).map((c) => c.id)).toEqual(['c0', 'c2'])
  })

  it('锚在同一条消息上的两个检查点各画一条,按窗口号排', () => {
    const rows = threadRows([user, answer], [], false, {}, [
      cp({ id: 'c2', windowIndex: 2, coveredThroughMessageId: 'u1' }),
      cp({ id: 'c1', windowIndex: 1, coveredThroughMessageId: 'u1' })
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'divider', 'divider', 'assistant'])
    expect(rows.slice(1, 3).map((row) => row.key)).toEqual(['compaction:c1', 'compaction:c2'])
  })

  it('foldedCount 从上一条分隔线起算,不是从头数', () => {
    const messages = [
      userMessage('u1', [{ type: 'text', text: 'a' }], 1),
      assistantMessage('a1', [{ type: 'text', text: 'b' }], 2),
      userMessage('u2', [{ type: 'text', text: 'c' }], 3),
      assistantMessage('a2', [{ type: 'text', text: 'd' }], 4)
    ]
    const rows = threadRows(messages, [], false, {}, [
      cp({ id: 'c1', windowIndex: 1, coveredThroughMessageId: 'a1' }),
      cp({ id: 'c2', windowIndex: 2, coveredThroughMessageId: 'a2' })
    ])
    const folded = rows.flatMap((row) => (row.kind === 'divider' ? [row.foldedCount] : []))
    expect(folded).toEqual([2, 2])
  })

  /** `checkpoints` 为空时产出必须与加这个功能之前逐字节相同 */
  it('没有检查点时不产出任何分隔线', () => {
    expect(threadRows([user, answer], [], false, {}, []).map((row) => row.kind)).toEqual(['user', 'assistant'])
  })
})

/**
 * 两条 DOM 级回归 —— 单测层面的 rows 抓不到「按钮无声消失」。
 * 分隔线插进消息流之后,`promptOf` 和 `isLast` 的两处静默回归都表现为
 * **某块 UI 不再渲染**,而 rows 本身看起来完全正常。
 */
describe('compaction dividers · DOM', () => {
  async function renderThread(checkpoints: ContextCheckpoint[]): Promise<{
    container: HTMLElement
    cleanup: () => Promise<void>
  }> {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const container = document.getElementById('root')!
    const root = createRoot(container)
    const messages = [
      userMessage('u1', [{ type: 'text', text: 'Inspect' }], 1),
      assistantMessage('a1', [{ type: 'text', text: 'Done' }], 2)
    ]
    const transcript = {
      ...emptyTranscript(),
      messages,
      tools: toolsFromMessages(messages),
      status: 'done' as const,
      contextCheckpoints: checkpoints
    }
    await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'en-US', children:
      createElement(Thread, { transcript, runId: null, lastSeq: 0, queued: 0, model: undefined, providerName: undefined }) })))
    return {
      container,
      cleanup: async () => {
        await act(async () => root.unmount())
        dom.window.close()
        vi.unstubAllGlobals()
      }
    }
  }

  const checkpoint = (anchor: string): ContextCheckpoint => ({
    id: 'c1', sessionId: 's', windowIndex: 1, note: '折叠了 14 条消息',
    source: 'mechanical', coveredThroughMessageId: anchor, createdAt: 0, updatedAt: 0, revision: 1
  })

  it('★ 线插在提问与回答之间时,「重新生成」仍在', async () => {
    const { container, cleanup } = await renderThread([checkpoint('u1')])
    try {
      expect(container.querySelector('[data-testid="compaction-divider"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="turn-regenerate"]')).not.toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('★ 线落在整段末尾时,状态行那一块仍在', async () => {
    const { container, cleanup } = await renderThread([checkpoint('a1')])
    try {
      expect(container.querySelector('[data-testid="compaction-divider"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="assistant-feedback"]')).not.toBeNull()
    } finally {
      await cleanup()
    }
  })
})
