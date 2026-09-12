/**
 * 转录解析的夹具测试 —— 计划第 1 步那条「最便宜的判别测试」。
 *
 * ★ 夹具是**手写的匿名样本**,不是用户真实数据的拷贝。它锁定的是
 * 「我们承诺能解析哪些形状」,而不是「某一个 Claude Code 版本恰好写成什么样」。
 * 官方文档不保证磁盘 JSONL 的 schema,所以这里每加一条断言,就等于多一条
 * 明确的兼容承诺 —— 承诺不了的必须显式失败或降级,不能靠猜。
 */
import { describe, expect, it } from 'vitest'
import { parseTranscript } from '../transcript'

const OPTIONS = { fallbackSessionId: 'fallback', maxMessages: 1000 }

function lines(...records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record))
}

/** 最小往返:一轮文本 + 一对工具。第 1 步验收的就是这一条。 */
function roundTrip(): string[] {
  return lines(
    {
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      cwd: '/Users/anon/proj',
      sessionId: 's-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      message: { role: 'user', content: '看一下 README' }
    },
    {
      uuid: 'a1',
      parentUuid: 'u1',
      type: 'assistant',
      timestamp: '2025-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: '好的,我读一下。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/Users/anon/proj/README.md' } }
        ]
      }
    },
    {
      uuid: 'r1',
      parentUuid: 'a1',
      type: 'user',
      timestamp: '2025-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# 标题', is_error: false }]
      }
    },
    {
      uuid: 'a2',
      parentUuid: 'r1',
      type: 'assistant',
      timestamp: '2025-01-01T00:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '这是一个示例项目。' }] }
    }
  )
}

describe('parseTranscript 最小往返', () => {
  it('文本 + 成对工具能编码成当前消息形状', () => {
    const result = parseTranscript(roundTrip(), OPTIONS)

    expect(result.diagnostics).toEqual([])
    expect(result.cwd).toBe('/Users/anon/proj')
    expect(result.sessionId).toBe('s-1')
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    // ★ 工具结果落在一条 **user** 消息里 —— 与 `toolResultMessage` 的约定一致。
    const toolResult = result.messages[2]
    expect(toolResult?.role).toBe('user')
    expect(toolResult?.parts[0]).toMatchObject({ type: 'tool_result', callId: 'toolu_1', isError: false })

    const assistant = result.messages[1]
    expect(assistant?.parts[1]).toMatchObject({ type: 'tool_call', callId: 'toolu_1', name: 'Read' })
  })

  it('源 uuid 就是稳定键 —— 重复解析得到同一批 sourceId', () => {
    const a = parseTranscript(roundTrip(), OPTIONS)
    const b = parseTranscript(roundTrip(), OPTIONS)
    expect(a.messages.map((m) => m.sourceId)).toEqual(['u1', 'a1', 'r1', 'a2'])
    expect(b.messages.map((m) => m.sourceId)).toEqual(a.messages.map((m) => m.sourceId))
  })

  it('标题取源侧 summary,而不是自己编一个', () => {
    const withSummary = [...roundTrip(), JSON.stringify({ type: 'summary', summary: '读 README', leafUuid: 'a2' })]
    expect(parseTranscript(withSummary, OPTIONS).title).toBe('读 README')
  })

  it('没有 summary 时退回首条用户发言的首行,不编造', () => {
    expect(parseTranscript(roundTrip(), OPTIONS).title).toBe('看一下 README')
  })
})

describe('主分支恢复', () => {
  it('★ 分叉时只取活跃分支,不把两条分支拼在一起', () => {
    const branched = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', cwd: '/p', message: { role: 'user', content: '第一版问题' } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一版回答' }] } },
      // 用户编辑了提问 —— 从 u1 的父节点重新分叉
      { uuid: 'u2', parentUuid: null, type: 'user', message: { role: 'user', content: '第二版问题' } },
      { uuid: 'a2', parentUuid: 'u2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第二版回答' }] } }
    )
    const result = parseTranscript(branched, OPTIONS)
    const texts = result.messages.flatMap((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')))
    expect(texts).toEqual(['第二版问题', '第二版回答'])
    expect(texts).not.toContain('第一版回答')
  })

  it('重复 uuid 只认第一条,不把重发的助手块算成两条消息', () => {
    const duplicated = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: 'hi' } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } }
    )
    expect(parseTranscript(duplicated, OPTIONS).messages).toHaveLength(2)
  })

  it('父记录缺失时记 truncated-tail,而不是按文件顺序硬拼', () => {
    const orphan = lines(
      { uuid: 'a9', parentUuid: 'missing-uuid', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '接着上文' }] } }
    )
    const result = parseTranscript(orphan, OPTIONS)
    expect(result.diagnostics).toContainEqual({ code: 'transcript.truncated-tail' })
    expect(result.messages).toHaveLength(1)
  })

  it('parentUuid 成环不会把主进程转死', () => {
    const cyclic = lines(
      { uuid: 'x', parentUuid: 'y', type: 'user', message: { role: 'user', content: 'a' } },
      { uuid: 'y', parentUuid: 'x', type: 'user', message: { role: 'user', content: 'b' } }
    )
    const result = parseTranscript(cyclic, OPTIONS)
    expect(result.diagnostics).toContainEqual({ code: 'transcript.truncated-tail' })
  })
})

describe('真机形状:非消息节点、ai-title、压缩边界', () => {
  /*
    这一组全部来自对本机真实 `~/.claude` 的结构分析。每一条都对应一个
    「夹具全绿、真机全错」的 bug —— 手写夹具里没有 attachment 节点、没有
    ai-title、没有压缩边界,所以这三件事以前一次都没被看过。
  */

  it('★★ attachment / system 节点在父链上,必须能走过去', () => {
    // 真机上 attachment 记录带着自己的 uuid/parentUuid,是图上的真实节点。
    // 只把 user/assistant 放进 uuid 表的话,链会断在第一个附件处 ——
    // 表现是**每一条**会话都报「末尾不完整」,且只恢复出尾巴那一小段。
    const withAttachment = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: '第一句' } },
      { uuid: 'att1', parentUuid: 'u1', type: 'attachment', attachment: { type: 'files', itemCount: 2 } },
      { uuid: 'sys1', parentUuid: 'att1', type: 'system', content: 'hook 输出' },
      { uuid: 'a1', parentUuid: 'sys1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } }
    )
    const result = parseTranscript(withAttachment, OPTIONS)
    expect(result.diagnostics.some((d) => d.code === 'transcript.truncated-tail')).toBe(false)
    // 遍历走全图,产出只取消息 —— attachment / system 不该变成气泡
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('★ 标题取 ai-title 的最后一条,不是 summary', () => {
    const withTitles = [
      ...roundTrip(),
      JSON.stringify({ type: 'ai-title', sessionId: 's-1', aiTitle: '早期标题' }),
      JSON.stringify({ type: 'ai-title', sessionId: 's-1', aiTitle: '最终标题' })
    ]
    // 标题会随对话重新生成,一份转录里几十条 ai-title 是常态,最后那条最贴切
    expect(parseTranscript(withTitles, OPTIONS).title).toBe('最终标题')
  })

  it('★★ 压缩边界要跨过去,否则长会话只剩最后一段', () => {
    const compacted = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: '压缩前的提问' } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '压缩前的回答' }] } },
      // `/compact` 开了一棵新树:parentUuid 是 null,但 logicalParentUuid 指回去
      { uuid: 'b1', parentUuid: null, type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'a1', compactMetadata: {} },
      { uuid: 'u2', parentUuid: 'b1', type: 'user', message: { role: 'user', content: '压缩后的提问' } }
    )
    const texts = parseTranscript(compacted, OPTIONS).messages.flatMap((m) =>
      m.parts.map((p) => (p.type === 'text' ? p.text : ''))
    )
    expect(texts).toEqual(['压缩前的提问', '压缩前的回答', '压缩后的提问'])
  })

  it('★ 兜底标题跳过系统注入的包装,不拿 <command-name> 当会话名', () => {
    const injected = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
      { uuid: 'u2', parentUuid: 'u1', type: 'user', message: { role: 'user', content: '真正的问题在这里' } }
    )
    expect(parseTranscript(injected, OPTIONS).title).toBe('真正的问题在这里')
  })

  it('用户自己写的尖括号不算系统注入', () => {
    const real = lines({
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: '<div> 为什么不居中' }
    })
    expect(parseTranscript(real, OPTIONS).title).toBe('<div> 为什么不居中')
  })
})

describe('排除与降级', () => {
  it('sidechain(子代理)与 meta 记录不进主线', () => {
    const withSide = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: '主线' } },
      { uuid: 's1', parentUuid: 'u1', type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子代理内部' }] } },
      { uuid: 'm1', parentUuid: 'u1', type: 'user', isMeta: true, message: { role: 'user', content: '元数据' } },
      { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '主线回答' }] } }
    )
    const texts = parseTranscript(withSide, OPTIONS).messages.flatMap((m) =>
      m.parts.map((p) => (p.type === 'text' ? p.text : ''))
    )
    expect(texts).toEqual(['主线', '主线回答'])
  })

  it('★ 落单的 tool_use 降级成文字,不伪造一个执行结果', () => {
    const interrupted = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: '跑一下' } },
      {
        uuid: 'a1',
        parentUuid: 'u1',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] }
      }
    )
    const result = parseTranscript(interrupted, OPTIONS)
    const parts = result.messages[1]?.parts ?? []
    expect(parts.some((p) => p.type === 'tool_call')).toBe(false)
    expect(parts[0]).toMatchObject({ type: 'text' })
    expect(result.diagnostics).toContainEqual({ code: 'tool.unencodable', detail: '1' })
  })

  it('thinking 只留正文,厂商签名不透传', () => {
    const thinking = lines(
      { uuid: 'u1', parentUuid: null, type: 'user', message: { role: 'user', content: 'q' } },
      {
        uuid: 'a1',
        parentUuid: 'u1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '我先想想', signature: 'SIG-DO-NOT-FORWARD' }]
        }
      }
    )
    const part = parseTranscript(thinking, OPTIONS).messages[1]?.parts[0]
    expect(part).toEqual({ type: 'thinking', text: '我先想想' })
    expect(JSON.stringify(part)).not.toContain('SIG-DO-NOT-FORWARD')
  })

  it('内联 base64 图片挂成待落盘项,dataRef 留空等 service 回填', () => {
    const withImage = lines({
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
      }
    })
    const message = parseTranscript(withImage, OPTIONS).messages[0]
    expect(message?.parts[0]).toEqual({ type: 'image', mime: 'image/png', dataRef: '' })
    expect(message?.images).toEqual([{ partIndex: 0, mime: 'image/png', base64: 'AAAA' }])
  })

  it('外部 URL 图片不联网下载,只留可读说明', () => {
    const external = lines({
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }]
      }
    })
    const result = parseTranscript(external, OPTIONS)
    expect(result.diagnostics).toContainEqual({ code: 'attachment.external-url' })
    expect(result.messages[0]?.images).toEqual([])
  })
})

describe('坏输入', () => {
  it('末行写了一半 = 并发读,记 truncated-tail 而不是「已损坏」', () => {
    const partial = [...roundTrip(), '{"uuid":"a3","typ']
    const result = parseTranscript(partial, OPTIONS)
    expect(result.diagnostics).toContainEqual({ code: 'transcript.truncated-tail' })
    expect(result.diagnostics.some((d) => d.code === 'transcript.unparsable')).toBe(false)
    expect(result.messages).toHaveLength(4)
  })

  it('中间行坏掉才算 unparsable,且不影响其余消息', () => {
    const broken = [...roundTrip()]
    broken.splice(2, 0, '{ 这不是 json')
    const result = parseTranscript(broken, OPTIONS)
    expect(result.diagnostics).toContainEqual({ code: 'transcript.unparsable', detail: '1' })
    expect(result.messages).toHaveLength(4)
  })

  it('空文件与全是未知记录的文件都标 empty,不产出空会话', () => {
    expect(parseTranscript([], OPTIONS).diagnostics).toContainEqual({ code: 'transcript.empty' })
    expect(parseTranscript(lines({ type: 'system', content: 'x' }), OPTIONS).messages).toEqual([])
  })

  it('超过上限时截断并明确报出来,不冒充完整导入', () => {
    const many: unknown[] = []
    for (let i = 0; i < 30; i += 1) {
      many.push({
        uuid: `u${String(i)}`,
        ...(i === 0 ? { parentUuid: null } : { parentUuid: `u${String(i - 1)}` }),
        type: 'user',
        message: { role: 'user', content: `第 ${String(i)} 条` }
      })
    }
    const result = parseTranscript(lines(...many), { ...OPTIONS, maxMessages: 10 })
    expect(result.messages).toHaveLength(10)
    expect(result.diagnostics.some((d) => d.code === 'transcript.oversize')).toBe(true)
  })

  it('全文件没有 uuid 时回落到文件顺序,而不是只剩最后一条', () => {
    const noUuid = lines(
      { type: 'user', message: { role: 'user', content: '好的' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '嗯' }] } },
      { type: 'user', message: { role: 'user', content: '好的' } }
    )
    const result = parseTranscript(noUuid, OPTIONS)
    // 没有分叉信息可用时,文件顺序是唯一存在的顺序 —— 丢掉整段对话更糟。
    expect(result.messages).toHaveLength(3)
    // ★ 同一句话说两遍是两条真实发言,内容指纹带出现序号才不会把它们合并。
    expect(new Set(result.messages.map((m) => m.sourceId)).size).toBe(3)
  })

  it('非 ASCII 路径原样保留', () => {
    const cjk = lines({
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      cwd: '/Users/anon/我的项目',
      message: { role: 'user', content: 'hi' }
    })
    expect(parseTranscript(cjk, OPTIONS).cwd).toBe('/Users/anon/我的项目')
  })
})
