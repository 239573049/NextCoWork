import { describe, expect, it } from 'vitest'
import { buildNcwUrl } from '../domain/attachment'
import { assistantMessage, toolResultMessage, userMessage, type AgentMessage } from '../agent/message'
import { ownedImageFileNames, rehomeImageRefs, turnEndIndex } from '../agent/session-clone'

/**
 * 分支/复制搬转录时的三件事。它们错了都不报错 —— 切点错位是分支里多/少一轮,
 * 漏搬一张图是新会话下一次发送才整轮失败 —— 所以逐条钉住。
 */

const ref = (ownerId: string, fileName: string): string =>
  buildNcwUrl({ scope: 'session', ownerId, fileName }) ?? ''

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })

function toolResultWithImages(id: string, dataRefs: string[]): AgentMessage {
  return toolResultMessage(id, [{
    type: 'tool_result',
    callId: `call-${id}`,
    isError: false,
    output: { content: 'ok', images: dataRefs.map((dataRef) => ({ mime: 'image/png' as const, dataRef })) }
  }], 1)
}

describe('turnEndIndex', () => {
  const transcript: AgentMessage[] = [
    userMessage('u1', [text('first')], 1),
    assistantMessage('a1', [{ type: 'tool_call', callId: 'c1', name: 'Read', input: {} }], 2),
    toolResultWithImages('r1', []),
    assistantMessage('a1b', [text('done')], 4),
    userMessage('u2', [text('second')], 5),
    assistantMessage('a2', [text('reply')], 6)
  ]

  it('carries the tool results that follow the prompt and stops before the next real prompt', () => {
    expect(turnEndIndex(transcript, 'u1')).toBe(4)
  })

  it('runs to the end of the transcript for the last turn', () => {
    expect(turnEndIndex(transcript, 'u2')).toBe(transcript.length)
  })

  it('returns null for an unknown id or a non-user message id', () => {
    expect(turnEndIndex(transcript, 'missing')).toBeNull()
    expect(turnEndIndex(transcript, 'a1')).toBeNull()
  })
})

describe('ownedImageFileNames', () => {
  it('collects user images and generated tool images once each, skipping other owners and inline data', () => {
    const messages = [
      userMessage('u1', [{ type: 'image', mime: 'image/png', dataRef: ref('src', 'a.png') }], 1),
      toolResultWithImages('r1', [ref('src', 'b.png'), 'data:image/png;base64,AAAA', ref('other', 'c.png')]),
      userMessage('u2', [{ type: 'image', mime: 'image/png', dataRef: ref('src', 'a.png') }], 3)
    ]
    expect(ownedImageFileNames(messages, 'src')).toEqual(['a.png', 'b.png'])
  })
})

describe('rehomeImageRefs', () => {
  const moved = (name: string): string | undefined => name === 'lost.png' ? undefined : ref('dst', name)

  it('rewrites both user images and tool output images owned by the source', () => {
    const user = userMessage('u1', [text('see'), { type: 'image', mime: 'image/png', dataRef: ref('src', 'a.png') }], 1)
    const tool = toolResultWithImages('r1', [ref('src', 'b.png'), ref('other', 'c.png')])
    const nextUser = rehomeImageRefs(user, 'src', moved)
    const nextTool = rehomeImageRefs(tool, 'src', moved)
    expect(nextUser.parts[1]).toMatchObject({ dataRef: ref('dst', 'a.png') })
    const images = nextTool.parts[0]?.type === 'tool_result' ? nextTool.parts[0].output.images : undefined
    expect(images?.map((image) => image.dataRef)).toEqual([ref('dst', 'b.png'), ref('other', 'c.png')])
  })

  it('keeps the original reference when the file could not be moved', () => {
    const user = userMessage('u1', [{ type: 'image', mime: 'image/png', dataRef: ref('src', 'lost.png') }], 1)
    expect(rehomeImageRefs(user, 'src', moved)).toBe(user)
  })

  it('returns the same message object when nothing needs rewriting', () => {
    const plain = assistantMessage('a1', [text('hi')], 1)
    expect(rehomeImageRefs(plain, 'src', moved)).toBe(plain)
  })
})
