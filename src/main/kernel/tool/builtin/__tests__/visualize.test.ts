/**
 * 可视化那一对工具的单测。
 *
 * ★ 这里最重要的一条是**反向断言**:`content` 里不含 `widget_code`。
 * 模型刚写完那段代码,把它原样回灌等于为同一份内容付两遍窗口钱,而模型
 * 看到自己刚写的东西在结果里还会想再改一遍。这条同时钉住"卡片只走 UI 轨"
 * 那条不变式 —— 代码从 `card` 出去,不从 `content` 出去。
 */
import { describe, expect, it } from 'vitest'
import { nodeHost } from '../../../host'
import type { ToolContext } from '../../registry'
import { visualizeReadMeTool, visualizeShowWidgetTool } from '../visualize'

function ctx(): ToolContext {
  return {
    workspaceRoot: '/tmp/does-not-matter',
    signal: new AbortController().signal,
    permissionMode: 'auto',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    host: nodeHost(),
    emit: () => {}
  }
}

const CODE = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>'

async function showWidget(input: Record<string, unknown>) {
  return visualizeShowWidgetTool.execute(
    { title: 'compound_interest', widget_code: CODE, loading_messages: ['画个圆'], ...input },
    ctx()
  )
}

describe('visualize_show_widget', () => {
  it('产出一张 widget 卡片,代码只走卡片', async () => {
    const result = await showWidget({})
    expect(result.isError).toBe(false)
    expect(result.output.card).toEqual({ kind: 'widget', title: 'compound_interest', code: CODE })
    expect(result.output.content).not.toContain('<svg')
    expect(result.output.content).not.toContain('circle')
  })

  /**
   * ★ 必须告诉模型"别再复述一遍":它训练里"解释清楚"的默认动作就是把刚画出来的
   * 东西用文字再讲一遍,而那会让用户在同一屏上看到同一份信息两遍。
   */
  it('结果里明确要求不要把已渲染的内容用文字重复', async () => {
    const result = await showWidget({})
    expect(result.output.content).toMatch(/do not duplicate/i)
  })

  it('title 必须是可自解释的 snake_case 标识', async () => {
    const bad = await showWidget({ title: 'Q4 Revenue Chart' })
    expect(bad.isError).toBe(true)
    expect(bad.output.content).toContain('snake_case')
  })

  it('loading_messages 要 1–4 条,空数组与五条都被拒', async () => {
    expect((await showWidget({ loading_messages: [] })).isError).toBe(true)
    expect((await showWidget({ loading_messages: ['a', 'b', 'c', 'd', 'e'] })).isError).toBe(true)
  })

  it('widget_code 为空被拒 —— 一张什么都没有的卡片不如一次失败', async () => {
    const result = await showWidget({ widget_code: '' })
    expect(result.isError).toBe(true)
  })

  it('widget_code 超过 128K 被拒,且失败信息说明是长度问题', async () => {
    const result = await showWidget({ widget_code: 'x'.repeat(128 * 1024 + 1) })
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('widget_code')
  })

  /** 见 `visualize.ts` 文件头第 2 条:它自己不出网,但它产出的东西会。 */
  it('★ 申报 needsNetwork —— widget 里的 CDN 脚本是一条出网路径', () => {
    expect(visualizeShowWidgetTool.needsNetwork).toBe(true)
    expect(visualizeShowWidgetTool.readOnly).toBe(true)
    expect(visualizeShowWidgetTool.destructive).toBe(false)
  })
})

describe('visualize_read_me', () => {
  it('返回规范正文', async () => {
    const result = await visualizeReadMeTool.execute({ modules: ['interactive'] }, ctx())
    expect(result.isError).toBe(false)
    expect(result.output.content).toContain('# Imagine')
  })

  it('不存在的模块名被 schema 拦下(枚举来自 AVAILABLE_MODULES)', async () => {
    const result = await visualizeReadMeTool.execute({ modules: ['nope'] }, ctx())
    expect(result.isError).toBe(true)
  })

  /**
   * ★ 超限时**明确失败**而不是让它被截断 —— 失败信息里带着两个模块各自的体积,
   * 模型下一轮就会只挑一个。见 `visualize.ts` 里那段长注释。
   */
  it('组合会越过输出截断线时明确失败,并提示改成单模块', async () => {
    const result = await visualizeReadMeTool.execute({ modules: ['diagram', 'chart'] }, ctx())
    expect(result.isError).toBe(true)
    expect(result.output.content).toContain('single module')
    expect(result.output.content).toContain('diagram')
  })

  it('不联网 —— 规范是本地的那七万字', () => {
    expect(visualizeReadMeTool.needsNetwork).toBe(false)
  })
})
