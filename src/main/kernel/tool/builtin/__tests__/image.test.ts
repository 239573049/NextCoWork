/**
 * `generate_image` 的下发与回传。
 *
 * 两条主线:① 没配生图模型时**整体不下发**(`isEnabled`),下发了也调不动的
 * 承诺一个都不画;② 图必须真的回到 `output.images` —— 卡片、上下文回传
 * (`encode/*`)、`ToolDetail` 的预览读的都是这一个字段,丢了它就是
 * 「模型说画好了,界面什么都没有」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../../../../../shared/agent/message'
import type { ImageGenBridge } from '../../../image-gen'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { generateImageTool } from '../image'

function bridge(over: Partial<ImageGenBridge> = {}): ImageGenBridge {
  return {
    available: () => true,
    generate: vi.fn(async () => ({
      images: [{ mime: 'image/png' as const, dataRef: 'data:image/png;base64,AAAA' }],
      model: 'gpt-image-2',
      providerName: 'OpenAI'
    })),
    edit: vi.fn(async () => ({
      images: [{ mime: 'image/png' as const, dataRef: 'data:image/png;base64,BBBB' }],
      model: 'gpt-image-2',
      providerName: 'OpenAI'
    })),
    ...over
  }
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {},
    ...overrides
  }
}

describe('generate_image · 元数据', () => {
  it('只读、非破坏、必须联网 —— 联网位是 permission-gate 第 1 行与开关的入参', () => {
    expect(generateImageTool.readOnly).toBe(true)
    expect(generateImageTool.destructive).toBe(false)
    expect(generateImageTool.needsNetwork).toBe(true)
  })
})

describe('generate_image · 下发', () => {
  it('没装桥(纯内核环境)时不下发', () => {
    expect(generateImageTool.isEnabled?.(ctx())).toBe(false)
  })

  it('桥说没有生图模型时不下发,有候选才下发', () => {
    expect(generateImageTool.isEnabled?.(ctx({ imageGen: bridge({ available: () => false }) }))).toBe(false)
    expect(generateImageTool.isEnabled?.(ctx({ imageGen: bridge() }))).toBe(true)
  })
})

describe('generate_image · 执行', () => {
  it('图回到 output.images,文案带上实际用的模型与供应商', async () => {
    const fake = bridge()
    const result = await generateImageTool.execute({ prompt: 'a lighthouse at dawn' }, ctx({ imageGen: fake }))
    expect(result.isError).toBe(false)
    expect(result.output.images).toEqual([{ mime: 'image/png', dataRef: 'data:image/png;base64,AAAA' }])
    expect(result.output.content).toContain('gpt-image-2')
    expect(result.output.content).toContain('OpenAI')
    expect(fake.generate).toHaveBeenCalledWith('a lighthouse at dawn', expect.any(AbortSignal))
  })

  it('桥不在了(快照之后被摘)按工具失败上报,不能报成功', async () => {
    const result = await generateImageTool.execute({ prompt: 'x' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/not available/u)
  })

  it('桥抛出的失败(没 key / 上游 4xx)原样进 tool_failed,消息带原因', async () => {
    const fake = bridge({ generate: vi.fn(async () => { throw new Error('OpenAI: no API key') }) })
    const result = await generateImageTool.execute({ prompt: 'x' }, ctx({ imageGen: fake }))
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('OpenAI: no API key')
  })

  it('空 prompt 被 schema 拦下 —— 模型只能带完整入参调用', async () => {
    const result = await generateImageTool.execute({ prompt: '' }, ctx({ imageGen: bridge() }))
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/Invalid arguments/u)
  })
})

describe('generate_image · 改图', () => {
  /** 1×1 PNG */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )

  it('image:"latest" 取对话里**最近**的一张图交给桥,回执写 Edited', async () => {
    const fake = bridge()
    const messages: AgentMessage[] = [
      {
        id: 'm1', role: 'user', createdAt: 1, schemaVersion: 1,
        parts: [{ type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/sessions/s1/older.png' }]
      },
      {
        id: 'm2', role: 'assistant', createdAt: 2, schemaVersion: 1,
        parts: [{
          type: 'tool_result', callId: 'c0', isError: false,
          output: { content: 'ok', images: [{ mime: 'image/png', dataRef: 'data:image/png;base64,AAAA' }] }
        }]
      }
    ]
    const result = await generateImageTool.execute(
      { prompt: 'make it noir', image: 'latest' },
      ctx({ imageGen: fake, messages })
    )
    expect(result.isError).toBe(false)
    expect(result.output.content).toMatch(/^Edited/u)
    // 最近的那张是 m2 里工具产出的图,不是 m1 的附件 —— 模型没法点名,只能由我们认最近的
    expect(fake.edit).toHaveBeenCalledWith(
      'make it noir',
      { mime: 'image/png', dataRef: 'data:image/png;base64,AAAA' },
      expect.any(AbortSignal)
    )
  })

  it('image:"latest" 但对话里一张图都没有 —— 当场失败并说清,一个请求都不发', async () => {
    const fake = bridge()
    const messages: AgentMessage[] = [
      { id: 'm1', role: 'user', createdAt: 1, schemaVersion: 1, parts: [{ type: 'text', text: 'hi' }] }
    ]
    const result = await generateImageTool.execute(
      { prompt: 'x', image: 'latest' },
      ctx({ imageGen: fake, messages })
    )
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/no image in this conversation/u)
    expect(fake.edit).not.toHaveBeenCalled()
  })

  it('image 给工作区路径 —— 读字节、按魔数认 mime 再交给桥', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncw-generate-image-'))
    const file = join(dir, 'photo.png')
    writeFileSync(file, PNG)
    try {
      const fake = bridge()
      const result = await generateImageTool.execute(
        { prompt: 'crop it', image: file },
        ctx({ imageGen: fake, workspaceRoot: dir })
      )
      expect(result.isError).toBe(false)
      expect(fake.edit).toHaveBeenCalledWith(
        'crop it',
        expect.objectContaining({ mime: 'image/png' }),
        expect.any(AbortSignal)
      )
      const source = vi.mocked(fake.edit).mock.calls[0]?.[1] as { dataRef: string }
      expect(source.dataRef.startsWith('data:image/png;base64,')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('路径指向不存在的文件 —— 失败信息指向文件,不进桥', async () => {
    const fake = bridge()
    const result = await generateImageTool.execute(
      { prompt: 'x', image: '/definitely/not/here.png' },
      ctx({ imageGen: fake })
    )
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/does not exist/u)
    expect(fake.edit).not.toHaveBeenCalled()
  })
})

describe('generate_image · 改图(URL 源)', () => {
  /** 1×1 PNG(与上面那组同款;作用域各自独立,别跨 describe 引用) */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  /** 用假 fetch 换掉 host.fetch —— URL 下载走 `downloadImage(ctx.host.fetch, …)` */
  function ctxWithFetch(fetchMock: ReturnType<typeof vi.fn>, fake: ImageGenBridge): ToolContext {
    return ctx({ imageGen: fake, host: { ...nodeHost(), fetch: fetchMock as unknown as typeof globalThis.fetch } })
  }

  it('http(s) URL 下载成功 → 以 data URL 交给桥走改图', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(new Uint8Array(PNG), { status: 200 }))
    const fake = bridge()
    const result = await generateImageTool.execute(
      { prompt: 'make it noir', image: 'https://cdn.example.com/pic.png' },
      ctxWithFetch(fetchMock, fake)
    )
    expect(result.isError).toBe(false)
    expect(result.output.content).toMatch(/^Edited/u)
    const source = vi.mocked(fake.edit).mock.calls[0]?.[1] as { mime: string; dataRef: string }
    expect(source.mime).toBe('image/png')
    expect(source.dataRef.startsWith('data:image/png;base64,')).toBe(true)
  })

  /*
    ★ 需求:URL 死了必须失败,**绝不回落成文生图** —— 模型传了 URL 就是要改这一张,
    默默画一张新图是答非所问,而且模型会向用户宣布「改好了」。
    下面三例都守 `generate` 与 `edit` 一个都不许被调用。
  */
  it('URL 404 —— 报错带原因,不生成新图', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, { status: 404 }))
    const fake = bridge()
    const result = await generateImageTool.execute(
      { prompt: 'x', image: 'https://cdn.example.com/gone.png' },
      ctxWithFetch(fetchMock, fake)
    )
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/HTTP 404/u)
    expect(fake.generate).not.toHaveBeenCalled()
    expect(fake.edit).not.toHaveBeenCalled()
  })

  it('URL 指向本机 —— 拒下,不生成新图', async () => {
    const fetchMock = vi.fn()
    const fake = bridge()
    const result = await generateImageTool.execute(
      { prompt: 'x', image: 'http://127.0.0.1:8080/steal.png' },
      ctxWithFetch(fetchMock, fake)
    )
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/Refused to download the image/u)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.edit).not.toHaveBeenCalled()
  })

  it('URL 下载回来不是图片 —— 报错,不把 HTML 当 png 送进桥', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const fake = bridge()
    const result = await generateImageTool.execute(
      { prompt: 'x', image: 'https://cdn.example.com/not-an-image' },
      ctxWithFetch(fetchMock, fake)
    )
    expect(result.isError).toBe(true)
    expect(result.output.content).toMatch(/not a recognized image/u)
    expect(fake.edit).not.toHaveBeenCalled()
  })
})
