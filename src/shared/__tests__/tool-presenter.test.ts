import { describe, expect, it } from 'vitest'
import type { ToolOutput } from '../agent/message'
import {
  base,
  clip,
  humanize,
  isRegisteredTool,
  parseMcpId,
  pick,
  presenterOf,
  registeredToolIds
} from '../domain/tool-presenter'

/**
 * presenter 的 bug 有两种表现,都不会崩:
 * 1. 标题显示成 "undefined" / 空白 —— 流式中途 input 还是半截 JSON 字符串;
 * 2. 新工具静默落进兜底 —— 长得和 MCP 工具一样,而没人会去查一个不报错的地方。
 * 这一组把两种都钉住。
 */

const out = (content: string, extra?: Partial<ToolOutput>): ToolOutput => ({ content, ...extra })

describe('取值原语', () => {
  it('pick 对非对象输入安全', () => {
    expect(pick('{"file_path":"a', 'file_path')).toBe('')
    expect(pick(null, 'x')).toBe('')
    expect(pick(undefined, 'x')).toBe('')
    expect(pick(42, 'x')).toBe('')
    expect(pick({ x: 1 }, 'x')).toBe('') // 数字不是字符串 → 空
    expect(pick({ x: 'v' }, 'x')).toBe('v')
  })

  it('base 同时处理正斜杠与反斜杠', () => {
    expect(base('/a/b/c.ts')).toBe('c.ts')
    expect(base('C:\\a\\b\\c.ts')).toBe('c.ts')
    expect(base('c.ts')).toBe('c.ts')
    expect(base('/a/b/')).toBe('b')
    expect(base('')).toBe('')
  })

  it('clip 折叠空白并截断', () => {
    expect(clip('a\nb   c', 40)).toBe('a b c')
    expect(clip('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`)
  })

  it('humanize 把下划线换成空格', () => {
    expect(humanize('create_pull_request')).toBe('create pull request')
  })
})

describe('parseMcpId', () => {
  it('拆出 server 与 tool', () => {
    expect(parseMcpId('mcp__github__create_pr')).toEqual({ server: 'github', tool: 'create_pr' })
  })

  it('server 名里带连字符也能拆', () => {
    expect(parseMcpId('mcp__github-enterprise__create_pr')).toEqual({
      server: 'github-enterprise',
      tool: 'create_pr'
    })
  })

  it('非 MCP 名返回 null', () => {
    expect(parseMcpId('Read')).toBeNull()
    expect(parseMcpId('mcp__onlyserver')).toBeNull()
    expect(parseMcpId('')).toBeNull()
  })

  it('★ 超长名被 ToolNamer 截断加哈希后,哈希后缀要剥掉', () => {
    // 64 字符上限下的真实形状:尾部 _ + 8 位 FNV
    const long = `mcp__github-enterprise-internal__${'create_pull_request_review'.repeat(2)}_3a7f21b9`
    const r = parseMcpId(long)
    expect(r?.server).toBe('github-enterprise-internal')
    expect(r?.tool.endsWith('_3a7f21b9')).toBe(false)
  })

  it('★ 短名里像哈希的尾巴不能被误剥', () => {
    // 真名就叫 sync_1a2b3c4d 的工具存在,且它没被截断过
    expect(parseMcpId('mcp__db__sync_1a2b3c4d')?.tool).toBe('sync_1a2b3c4d')
  })
})

describe('presenterOf · 内置工具', () => {
  it('Read 标题取文件名,不显示全路径', () => {
    const p = presenterOf('Read')
    expect(p.shape).toBe('read')
    expect(p.title({ file_path: '/w/src/main/index.ts' })).toBe('读取 index.ts')
    expect(p.summary?.({}, out('a\nb\nc'))).toBe('3 行')
  })

  it('★ 流式中途 input 是半截 JSON 字符串时,标题退化成「读取…」而不是崩溃', () => {
    expect(presenterOf('Read').title('{"file_p')).toBe('读取…')
    expect(presenterOf('Bash').title('{"comm')).toBe('执行…')
    expect(presenterOf('Edit').title(undefined)).toBe('编辑…')
  })

  it('Bash 优先用模型写的 description,没有才退回命令原文', () => {
    const p = presenterOf('Bash')
    expect(p.title({ command: 'ls -la', description: '列出文件' })).toBe('列出文件')
    expect(p.title({ command: 'ls -la' })).toBe('执行 ls -la')
  })

  it('★ Bash 失败时摘要是退出码 —— 不展开就能分辨 127 和 1', () => {
    const p = presenterOf('Bash')
    expect(p.summary?.({}, out('Command exited with code 127.\nnot found'))).toBe('退出码 127')
    expect(p.summary?.({}, out('(command succeeded with no output)'))).toBe('无输出')
  })

  it('Write 区分新建与覆写', () => {
    const p = presenterOf('Write')
    expect(p.shape).toBe('mutate')
    expect(p.summary?.({}, out('Created a.ts (12 lines, 340 bytes)'))).toBe('新建 12 行')
    expect(p.summary?.({}, out('Overwrote a.ts (5 lines, 90 bytes)'))).toBe('5 行')
  })

  it('★ 输出文案对不上正则时返回 undefined,而不是猜一个数', () => {
    // 摘要错了比没有更糟:用户会拿它当真
    expect(presenterOf('Edit').summary?.({}, out('something unexpected'))).toBeUndefined()
  })

  it('Edit 摘要是替换处数', () => {
    expect(presenterOf('Edit').summary?.({}, out('Edited a.ts: replaced 3 occurrence(s).'))).toBe(
      '替换 3 处'
    )
  })

  it('Grep / Glob 归到同一形态,摘要量词不同', () => {
    expect(presenterOf('Grep').shape).toBe('search')
    expect(presenterOf('Glob').shape).toBe('search')
    expect(presenterOf('Grep').summary?.({}, out('a\nb'))).toBe('2 处')
    expect(presenterOf('Glob').summary?.({}, out('a\nb'))).toBe('2 个文件')
  })

  it('★ TodoWrite 摘要从入参算,不依赖输出文案', () => {
    const p = presenterOf('TodoWrite')
    const todos = [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }]
    expect(p.summary?.({ todos }, undefined)).toBe('1/3')
  })

  it('WebFetch 摘要用字节数', () => {
    expect(presenterOf('WebFetch').summary?.({}, out('x'.repeat(2048)))).toBe('2.0KB')
    expect(presenterOf('WebFetch').title({ url: 'https://example.com/a/b' })).toBe(
      '抓取 example.com'
    )
  })

  it('URL 解析不了时不抛异常', () => {
    expect(presenterOf('WebFetch').title({ url: 'htt' })).toBe('抓取 htt')
  })

  it('运行中(output 为 undefined)所有摘要都返回 undefined', () => {
    for (const id of registeredToolIds()) {
      const p = presenterOf(id)
      // 只有 TodoWrite / Task 从入参算,给空入参它们也该返回 undefined
      expect(p.summary?.({}, undefined)).toBeUndefined()
    }
  })
})

describe('presenterOf · 兜底路径', () => {
  it('MCP 工具走 external,标题带 server 前缀', () => {
    const p = presenterOf('mcp__github__create_pull_request')
    expect(p.shape).toBe('external')
    expect(p.title({})).toBe('github · create pull request')
  })

  it('完全未知但可读的名字,显示名字本身 —— 比「工具调用」有用', () => {
    expect(presenterOf('some_new_tool').title({})).toBe('some new tool')
  })

  it('空名字才落到最终兜底', () => {
    expect(presenterOf('').title({})).toBe('工具调用')
  })

  it('★ 任何名字都能拿到 presenter,永不返回 undefined', () => {
    for (const n of ['', 'Read', 'mcp__a__b', '???', '__'.repeat(50)]) {
      expect(presenterOf(n).title({})).toBeTypeOf('string')
      expect(presenterOf(n).title({})).not.toBe('')
    }
  })
})

describe('注册表完整性', () => {
  /**
   * ★ 这条用例保护的是「新增内置工具忘了登记展示规则」。
   *
   * 注册表用数据分发而不是 switch,正是为了让这种遗漏能在测试期被发现 ——
   * switch 的 default 会让它静默通过,表现为新工具长得和 MCP 工具一模一样。
   *
   * 清单与 `src/main/kernel/tool/builtin/index.ts` 对齐。那边加了工具,
   * 这里会失败,提示同步 REGISTRY。
   */
  const BUILTIN_IDS = [
    'echo',
    'Read',
    'Write',
    'Edit',
    'LS',
    'Glob',
    'Grep',
    'Bash',
    'TodoWrite',
    'WebFetch',
    'Skill',
    'web_search',
    'Task'
  ]

  it('每个内置工具都在注册表里', () => {
    const missing = BUILTIN_IDS.filter((id) => !isRegisteredTool(id))
    expect(missing).toEqual([])
  })

  it('注册表里没有多余的键', () => {
    const extra = registeredToolIds().filter((id) => !BUILTIN_IDS.includes(id))
    expect(extra).toEqual([])
  })

  it('每个注册项的标题在空入参下都可读', () => {
    for (const id of registeredToolIds()) {
      const title = presenterOf(id).title({})
      expect(title, `${id} 的标题为空`).not.toBe('')
      expect(title).not.toContain('undefined')
    }
  })
})
