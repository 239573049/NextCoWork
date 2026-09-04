import { describe, expect, it } from 'vitest'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import {
  assistantMessage,
  orphanedToolCalls,
  userMessage
} from '../../../shared/agent/message'
import type { ToolInfo } from '../../../shared/agent/tool'
import type { Skill } from '../../../shared/domain/skill'
import {
  assemble,
  buildSystemPrompt,
  compactMessages,
  estimateMessages,
  estimateTokens,
  estimateTools,
  resolveThinkingBudget,
  type AssembleInput
} from '../context-assembler'

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0)

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1',
    name: 'commit',
    description: '写提交信息',
    category: '开发工具',
    source: { kind: 'builtin', path: '' },
    globalEnabled: true,
    frontmatter: {},
    body: '按 Conventional Commits 写。',
    ...over
  }
}

function tool(over: Partial<ToolInfo> = {}): ToolInfo {
  return {
    internalId: 'read_file',
    externalName: 'read_file',
    description: '读取文件',
    inputSchema: { type: 'object' },
    readOnly: true,
    destructive: false,
    source: { kind: 'builtin' },
    ...over
  }
}

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    messages: [],
    tools: [],
    skills: [],
    mode: 'normal',
    thinking: 'off',
    model: 'claude-sonnet-4',
    workspaceRoot: '/ws',
    now: NOW,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    ...over
  }
}

describe('estimateTokens', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  /** 中文一个字约一个 token,英文约四个字符一个 token —— 差三倍,不能一视同仁 */
  it('中文比同样字符数的英文贵得多', () => {
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)) * 3)
  })

  it('英文按约四字符一 token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  /** `text.length` 会把一个 emoji 算成两个字符 —— 所以按码点迭代 */
  it('emoji 按一个码点算', () => {
    expect(estimateTokens('🚀🚀🚀🚀')).toBe(1)
  })

  it('单调:更长的文本不会更便宜', () => {
    const short = estimateTokens('这是一段中文')
    expect(estimateTokens('这是一段中文,后面还有更多内容')).toBeGreaterThan(short)
  })
})

describe('estimateMessages / estimateTools', () => {
  it('空数组是 0', () => {
    expect(estimateMessages([])).toBe(0)
    expect(estimateTools([])).toBe(0)
  })

  it('图按固定量级算,不按 dataRef 字符串算', () => {
    const img = userMessage('m', [{ type: 'image', mime: 'image/png', dataRef: 'x' }], NOW)
    expect(estimateMessages([img])).toBeGreaterThan(1000)
  })

  it('工具入参进入估算', () => {
    const bare = assistantMessage('m', [{ type: 'tool_call', callId: 'c', name: 'f', input: {} }], NOW)
    const fat = assistantMessage(
      'm',
      [{ type: 'tool_call', callId: 'c', name: 'f', input: { q: 'x'.repeat(4000) } }],
      NOW
    )
    expect(estimateMessages([fat])).toBeGreaterThan(estimateMessages([bare]) + 900)
  })

  /**
   * ★ 一个挂了三个 MCP server 的工作区,工具 schema 能占掉两三万 token。
   * 漏算它,压力条会在真正爆掉之前一直显示「还很空」。
   */
  it('工具 schema 进入估算', () => {
    const big = tool({
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 60 }, (_, i) => [`field_${i}`, { type: 'string' }])
        )
      }
    })
    expect(estimateTools([big])).toBeGreaterThan(estimateTools([tool()]) + 200)
  })

  it('工具描述进入估算', () => {
    expect(estimateTools([tool({ description: '很长的描述'.repeat(100) })])).toBeGreaterThan(400)
  })
})

describe('buildSystemPrompt', () => {
  it('带上工作区与日期', () => {
    const s = buildSystemPrompt({ mode: 'normal', skills: [], workspaceRoot: '/a/b', now: NOW })
    expect(s).toContain('/a/b')
    expect(s).toContain('2026-09-04')
  })

  /** plan 的真正实现在工具过滤,但提示词也得说 —— 否则模型会一直问「为什么写不了」 */
  it('规划模式追加说明', () => {
    const s = buildSystemPrompt({ mode: 'plan', skills: [], workspaceRoot: '/w', now: NOW })
    expect(s).toContain('规划模式')
    expect(s).toContain('只读')
  })

  it('目标模式追加说明', () => {
    const s = buildSystemPrompt({ mode: 'goal', skills: [], workspaceRoot: '/w', now: NOW })
    expect(s).toContain('目标模式')
  })

  it('普通模式两段都不出现', () => {
    const s = buildSystemPrompt({ mode: 'normal', skills: [], workspaceRoot: '/w', now: NOW })
    expect(s).not.toContain('规划模式')
    expect(s).not.toContain('目标模式')
  })

  it('没有 Skill 时不出现 Skill 段', () => {
    const s = buildSystemPrompt({ mode: 'normal', skills: [], workspaceRoot: '/w', now: NOW })
    expect(s).not.toContain('已启用的 Skill')
  })

  it('Skill 正文与名字进入提示词', () => {
    const s = buildSystemPrompt({
      mode: 'normal',
      skills: [skill({ name: 'commit', body: '按 Conventional Commits 写。' })],
      workspaceRoot: '/w',
      now: NOW
    })
    expect(s).toContain('/commit')
    expect(s).toContain('Conventional Commits')
  })

  /**
   * ⚠️ Skill 正文是从 zip / git 装来的**不可信输入**,与 MCP 描述同等对待。
   */
  it('Skill 正文被消毒', () => {
    const s = buildSystemPrompt({
      mode: 'normal',
      skills: [skill({ body: 'a\u0000b\u001Bc' })],
      workspaceRoot: '/w',
      now: NOW
    })
    expect(s).toContain('abc')
    expect(s).not.toContain('\u0000')
  })

  it('Skill 描述也被消毒', () => {
    const s = buildSystemPrompt({
      mode: 'normal',
      skills: [skill({ description: 'x\u0007y' })],
      workspaceRoot: '/w',
      now: NOW
    })
    expect(s).toContain('xy')
  })

  it('超长 Skill 正文被截断', () => {
    const s = buildSystemPrompt({
      mode: 'normal',
      skills: [skill({ body: 'y'.repeat(500_000) })],
      workspaceRoot: '/w',
      now: NOW
    })
    expect(s.length).toBeLessThan(200_000)
  })

  /** 二十个 Skill 各 64KB = 1.2MB 进提示词。总预算是第二道闸 */
  it('Skill 总长度超限时截住,并说明丢了几个', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      skill({ id: `s${i}`, name: `skill${i}`, body: 'z'.repeat(60_000) })
    )
    const s = buildSystemPrompt({ mode: 'normal', skills: many, workspaceRoot: '/w', now: NOW })
    expect(s.length).toBeLessThan(200_000)
    expect(s).toMatch(/另有 \d+ 个 Skill/)
  })

  /**
   * ★ 这一句是 Skill 段唯一真正的防御 —— 前面的消毒只防意外,不防故意。
   * 真正的防线在权限层,但让模型在它自己能判断时先拒绝一次是免费的。
   */
  it('Skill 段声明权限边界', () => {
    const s = buildSystemPrompt({
      mode: 'normal',
      skills: [skill()],
      workspaceRoot: '/w',
      now: NOW
    })
    expect(s).toContain('不能放宽你的权限')
  })
})

describe('resolveThinkingBudget', () => {
  it('模型不支持时永远不下发', () => {
    expect(resolveThinkingBudget('max', false, 64_000)).toBeUndefined()
  })

  it('关闭时不下发', () => {
    expect(resolveThinkingBudget('off', true, 64_000)).toBeUndefined()
  })

  /** 「自动」和「关闭」在界面上是两档,行为就不能一样 */
  it('自动会真的开一点思考', () => {
    expect(resolveThinkingBudget('auto', true, 64_000)).toBeGreaterThan(0)
  })

  it('档位越高预算越大', () => {
    const low = resolveThinkingBudget('low', true, 100_000) ?? 0
    const high = resolveThinkingBudget('high', true, 100_000) ?? 0
    expect(high).toBeGreaterThan(low)
  })

  /**
   * ★ 上游要求 `max_tokens > budget_tokens`。用户选「最高」(64000)而模型
   * maxOutputTokens 是 8192 时,请求直接 400,而错误信息里只字不提 thinking。
   */
  it('预算被 maxOutputTokens 压住', () => {
    const b = resolveThinkingBudget('max', true, 8192)
    expect(b).toBeDefined()
    expect(b as number).toBeLessThan(8192)
  })

  /** 挤不出 1024 就干脆不开 —— 用户选的是「多想一点」,不是「宁可失败」 */
  it('额度太小时降级为不开思考,而不是报错', () => {
    expect(resolveThinkingBudget('max', true, 1500)).toBeUndefined()
    expect(resolveThinkingBudget('minimal', true, 512)).toBeUndefined()
  })

  it('额度充足时按档位原值下发', () => {
    expect(resolveThinkingBudget('minimal', true, 64_000)).toBe(1024)
  })
})

describe('assemble', () => {
  it('把系统提示词与模型别名放进请求', () => {
    const { request } = assemble(input({ model: 'glm-4.6', workspaceRoot: '/proj' }))
    expect(request.model).toBe('glm-4.6')
    expect(request.system).toContain('/proj')
  })

  it('关闭思考时不带 thinkingBudget 字段', () => {
    expect(assemble(input({ thinking: 'off' })).request).not.toHaveProperty('thinkingBudget')
  })

  it('开启思考时带上预算', () => {
    expect(assemble(input({ thinking: 'high', maxOutputTokens: 64_000 })).request.thinkingBudget)
      .toBeGreaterThan(0)
  })

  /** 请求要过 JSON 与 IPC,不能和调用方共享同一个数组 */
  it('messages 与 tools 是拷贝', () => {
    const messages: AgentMessage[] = [userMessage('m', [{ type: 'text', text: 'hi' }], NOW)]
    const tools = [tool()]
    const { request } = assemble(input({ messages, tools }))
    expect(request.messages).not.toBe(messages)
    expect(request.tools).not.toBe(tools)
    expect(request.messages).toEqual(messages)
  })

  it('空会话的占用远小于窗口', () => {
    const { usage } = assemble(input())
    expect(usage.used).toBeGreaterThan(0)
    expect(usage.window).toBe(200_000)
    expect(usage.shouldCompact).toBe(false)
  })

  it('历史越长占用越高', () => {
    const long = Array.from({ length: 50 }, (_, i) =>
      userMessage(`m${i}`, [{ type: 'text', text: '很长的一段中文内容'.repeat(50) }], NOW)
    )
    expect(assemble(input({ messages: long })).usage.used).toBeGreaterThan(
      assemble(input()).usage.used + 10_000
    )
  })

  it('逼近窗口时 shouldCompact 为真', () => {
    const huge = [userMessage('m', [{ type: 'text', text: '中'.repeat(90_000) }], NOW)]
    expect(assemble(input({ messages: huge, contextWindow: 100_000 })).usage.shouldCompact).toBe(
      true
    )
  })

  /**
   * ★ 上下文窗口是**输入加输出**共用的。只比较输入的话,你会在
   * 「输入刚好塞得下、回复写到一半被截断」时才发现该压缩了。
   */
  it('maxOutputTokens 算进压缩判断', () => {
    const messages = [userMessage('m', [{ type: 'text', text: '中'.repeat(70_000) }], NOW)]
    const small = assemble(input({ messages, contextWindow: 100_000, maxOutputTokens: 1024 }))
    const big = assemble(input({ messages, contextWindow: 100_000, maxOutputTokens: 32_000 }))
    expect(small.usage.shouldCompact).toBe(false)
    expect(big.usage.shouldCompact).toBe(true)
  })

  it('工具占用计入 used', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tool({ internalId: `t${i}`, externalName: `t${i}`, description: '描述'.repeat(50) })
    )
    expect(assemble(input({ tools: many })).usage.used).toBeGreaterThan(
      assemble(input()).usage.used + 3000
    )
  })
})

describe('compactMessages', () => {
  /** 一轮完整的工具往返:助手发起 + user 回执 */
  function turn(i: number): AgentMessage[] {
    return [
      assistantMessage(
        `a${i}`,
        [
          { type: 'thinking', text: '想了想', opaque: { sig: 'x' } },
          { type: 'text', text: `第 ${i} 轮` },
          { type: 'tool_call', callId: `c${i}`, name: 'read_file', input: { path: 'a.ts' } }
        ],
        NOW
      ),
      userMessage(
        `u${i}`,
        [
          {
            type: 'tool_result',
            callId: `c${i}`,
            output: { content: '文件内容'.repeat(500) },
            isError: false
          }
        ],
        NOW
      )
    ]
  }

  function history(turns: number): AgentMessage[] {
    return [
      // ★ 第一条带一张图:压缩会把图换成占位文本,所以这条**只有在真的被保留原文时**
      //   才与原值相等 —— 用纯文本做首条的话,压不压缩看起来都一样,断言就是空的。
      //   而这也正是最该保留的情形:用户贴了张报错截图,那张图就是任务本身。
      userMessage(
        'first',
        [
          { type: 'text', text: '帮我重构登录模块' },
          { type: 'image', mime: 'image/png', dataRef: 'shot-1' }
        ],
        NOW
      ),
      ...Array.from({ length: turns }, (_, i) => turn(i)).flat()
    ]
  }

  it('短会话原样返回', () => {
    const h = history(1)
    expect(compactMessages(h)).toEqual(h)
  })

  it('确实变小了', () => {
    const h = history(8)
    const before = estimateMessages(h)
    expect(estimateMessages(compactMessages(h))).toBeLessThan(before / 2)
  })

  /** 第一条是任务的原始表述,压掉它模型就不知道自己在干嘛了 */
  it('第一条永远保留原文', () => {
    const h = history(8)
    expect(compactMessages(h)[0]).toEqual(h[0])
  })

  it('最近若干条保留原文', () => {
    const h = history(8)
    const out = compactMessages(h, { keepRecent: 4 })
    expect(out.slice(-4)).toEqual(h.slice(-4))
  })

  /**
   * ★ 本文件最重要的一条。删掉一个 tool_result 就制造了一个孤儿 tool_use,
   * 下一轮直接 400 —— 与中断收尾漏补 tool_result(§4.8 第 4 件)是同一个坑的另一个入口。
   */
  it('压缩后不产生孤儿 tool_call', () => {
    for (const n of [2, 5, 8, 20]) {
      const h = history(n)
      expect(orphanedToolCalls(h)).toEqual([])
      expect(orphanedToolCalls(compactMessages(h)), `${n} 轮`).toEqual([])
    }
  })

  it('tool_result 保住 callId,只清空内容', () => {
    const out = compactMessages(history(8))
    const results = out
      .flatMap((m) => m.parts)
      .filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result')

    expect(results.length).toBeGreaterThan(0)
    expect(results.map((r) => r.callId)).toEqual(
      history(8)
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'tool_result')
        .map((p) => (p as Extract<ContentPart, { type: 'tool_result' }>).callId)
    )
    expect(results.some((r) => r.output.content.includes('已压缩'))).toBe(true)
  })

  it('tool_call 块本身一个不少', () => {
    const h = history(8)
    const count = (ms: AgentMessage[]): number =>
      ms.flatMap((m) => m.parts).filter((p) => p.type === 'tool_call').length
    expect(count(compactMessages(h))).toBe(count(h))
  })

  /** 上游只要求**最后一轮**的 thinking 带签名回传,而尾部是保留原文的 */
  it('历史 thinking 块被丢掉,尾部的保留', () => {
    const h = history(8)
    const out = compactMessages(h, { keepRecent: 4 })
    const head = out.slice(0, -4).flatMap((m) => m.parts)
    expect(head.some((p) => p.type === 'thinking')).toBe(false)
    expect(out.slice(-4).flatMap((m) => m.parts).some((p) => p.type === 'thinking')).toBe(true)
  })

  /**
   * ★ 空 parts 的消息会被上游拒绝(「all messages must have non-empty content」)。
   * 一条只有 thinking 的助手消息压完就是空的 —— 开了扩展思考时很常见。
   */
  it('绝不产出空 parts 的消息', () => {
    const onlyThinking = Array.from({ length: 10 }, (_, i) =>
      assistantMessage(`t${i}`, [{ type: 'thinking', text: '嗯' }], NOW)
    )
    const out = compactMessages([
      userMessage('first', [{ type: 'text', text: '开始' }], NOW),
      ...onlyThinking
    ])
    for (const m of out) expect(m.parts.length, m.id).toBeGreaterThan(0)
  })

  /** 图最贵(每张约 1600 token),而它通常在被描述过一次之后就不再需要 */
  it('压缩范围内的图被换成占位文本,尾部的保留', () => {
    const h = [
      userMessage('first', [{ type: 'text', text: '看这张图' }], NOW),
      ...Array.from({ length: 10 }, (_, i) =>
        userMessage(`i${i}`, [{ type: 'image', mime: 'image/png', dataRef: `r${i}` }], NOW)
      )
    ]
    const out = compactMessages(h, { keepRecent: 2 })
    const isImage = (m: AgentMessage): boolean => m.parts.some((p) => p.type === 'image')

    expect(out.slice(1, -2).some(isImage)).toBe(false)
    expect(out.slice(-2).every(isImage)).toBe(true)
    expect(estimateMessages(out)).toBeLessThan(estimateMessages(h) / 4)
  })

  it('不修改入参', () => {
    const h = history(8)
    const snapshot = structuredClone(h)
    compactMessages(h)
    expect(h).toEqual(snapshot)
  })
})
