/**
 * 「AI 生成子代理」的解析与消毒。
 *
 * ★ 被测的是**不可信输入**:模型返回的 JSON 和用户的需求描述一样,都可能是
 *   任何东西。这里的每一条都对应一种「能存下去、但存下去没用」的结果。
 */
import { describe, expect, it } from 'vitest'
import { parseAgentDraft } from '../agent-draft'
import { AGENT_TOOL_CHOICES } from '../../shared/domain/agent-def'
import { normalizeToolName } from '../kernel/agent/tool-alias'

const full = JSON.stringify({
  name: 'code-reviewer',
  description: '审查刚写完的代码,找 bug 和风格问题',
  prompt: '你是一个严格的代码审查者。',
  tools: ['Read', 'Grep'],
  color: 'blue'
})

describe('解析模型的回答', () => {
  it('认得出干净的 JSON', () => {
    expect(parseAgentDraft(full)).toEqual({
      name: 'code-reviewer',
      description: '审查刚写完的代码,找 bug 和风格问题',
      prompt: '你是一个严格的代码审查者。',
      tools: ['Read', 'Grep'],
      color: 'blue'
    })
  })

  it('容忍围栏和前后废话', () => {
    const noisy = `好的,这是你要的定义:\n\`\`\`json\n${full}\n\`\`\`\n还需要我改什么吗?`
    expect(parseAgentDraft(noisy)?.name).toBe('code-reviewer')
  })

  it('纯垃圾返回 null,不返回半成品', () => {
    expect(parseAgentDraft('抱歉,我没法完成这个请求。')).toBeNull()
    expect(parseAgentDraft('')).toBeNull()
    expect(parseAgentDraft('[1,2,3]')).toBeNull()
  })

  it('缺任何一个必填字段都算失败', () => {
    // ★ 不补默认值凑一份:凑出来的那份长得像成功,用户扫一眼就存了,
    //   然后得到一个永远不会被派到的子代理,且没有任何症状。
    expect(parseAgentDraft(JSON.stringify({ name: 'a', description: 'b' }))).toBeNull()
    expect(parseAgentDraft(JSON.stringify({ name: 'a', prompt: 'c' }))).toBeNull()
    expect(parseAgentDraft(JSON.stringify({ description: 'b', prompt: 'c' }))).toBeNull()
  })
})

describe('逐字段消毒', () => {
  it('名字归一成合法形状', () => {
    const draft = parseAgentDraft(JSON.stringify({ name: 'Code Reviewer!', description: 'b', prompt: 'c' }))
    expect(draft?.name).toBe('code-reviewer')
  })

  it('名字里的路径分隔符不会活下来', () => {
    const draft = parseAgentDraft(JSON.stringify({ name: '../../etc/passwd', description: 'b', prompt: 'c' }))
    expect(draft?.name).toBe('etc-passwd')
  })

  it('一个合法字符都没有的名字只能拒', () => {
    expect(parseAgentDraft(JSON.stringify({ name: '代码审查', description: 'b', prompt: 'c' }))).toBeNull()
  })

  it('描述压成一行并截断', () => {
    const draft = parseAgentDraft(JSON.stringify({ name: 'a', description: `x\ny${'z'.repeat(800)}`, prompt: 'c' }))
    expect(draft?.description).not.toContain('\n')
    expect(draft?.description.length).toBeLessThanOrEqual(512)
  })

  it('白名单外的工具被滤掉', () => {
    const draft = parseAgentDraft(JSON.stringify({
      name: 'a', description: 'b', prompt: 'c', tools: ['Read', 'Hammer', 'grep']
    }))
    expect(draft?.tools).toEqual(['Read', 'Grep'])
  })

  it('一个工具都认不出时省掉 tools,而不是写一张空表', () => {
    // ★ 空表正是 `agent/load.ts` 把整条作废的形状 —— 生成器不该产出一个注定作废的东西。
    const draft = parseAgentDraft(JSON.stringify({
      name: 'a', description: 'b', prompt: 'c', tools: ['Hammer', 'Anvil']
    }))
    expect(draft !== null && 'tools' in draft).toBe(false)
  })

  it('认不出的颜色当作没标,而不是作废整条', () => {
    const draft = parseAgentDraft(JSON.stringify({ name: 'a', description: 'b', prompt: 'c', color: 'chartreuse' }))
    expect(draft !== null && 'color' in draft).toBe(false)
  })
})

describe('工具白名单和加载器对齐', () => {
  it('表单里能勾的每一个,加载器都原样认得出', () => {
    /*
      ★★ 漂了的话,表单会勾出一个加载器不认识的名字,而 `resolveTools` 在
      「一个都认不出」时是把**整条子代理作废**的:用户存完之后会发现它不见了,
      界面上什么也没说。这条测试是那件事唯一的守卫。
    */
    for (const tool of AGENT_TOOL_CHOICES) {
      expect(normalizeToolName(tool)).toBe(tool)
    }
  })
})
