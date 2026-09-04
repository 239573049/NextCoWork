import { describe, expect, it, vi } from 'vitest'
import { EXTERNAL_NAME_MAX, toolOk, type ToolResult } from '../../../../shared/agent/tool'
import { nodeHost } from '../../host'
import { ToolRegistry, type ToolContext, type ToolRegistration } from '../registry'

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: '/ws',
    signal: new AbortController().signal,
    permissionMode: 'ask',
    depth: 0,
    callId: 'call_1',
    runId: 'run_1',
    // nodeHost() 结构上满足 ToolHost —— 不用手搓假对象
    host: nodeHost(),
    emit: () => {},
    ...over
  }
}

function reg(over: Partial<ToolRegistration> & { internalId: string }): ToolRegistration {
  return {
    description: 'd',
    inputSchema: { type: 'object' },
    readOnly: true,
    destructive: false,
    needsNetwork: false,
    source: { kind: 'builtin' },
    execute: async () => toolOk('ok'),
    ...over
  }
}

describe('ToolRegistry · 注册与命名', () => {
  it('注册时补上 externalName', () => {
    const r = new ToolRegistry()
    expect(r.register(reg({ internalId: 'read_file' })).externalName).toBe('read_file')
  })

  it('超长 internalId 得到合法的 externalName', () => {
    const r = new ToolRegistry()
    const t = r.register(
      reg({ internalId: 'mcp__github-enterprise-internal__create_pull_request_review_comment' })
    )
    expect(t.externalName.length).toBeLessThanOrEqual(EXTERNAL_NAME_MAX)
    expect(t.externalName).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  /**
   * ⚠️ 描述是不可信输入,且**直接进系统提示词** —— 注册这一步是唯一的收口点。
   * 漏在这里,后面每一个消费描述的地方都要各自防一遍。
   */
  it('注册时消毒描述', () => {
    const r = new ToolRegistry()
    const t = r.register(reg({ internalId: 'x', description: 'a\u0000b\u001Bc' }))
    expect(t.description).toBe('abc')
  })

  it('超长描述在注册时被截断', () => {
    const r = new ToolRegistry()
    const t = r.register(reg({ internalId: 'x', description: 'y'.repeat(99_999) }))
    expect(t.description.length).toBeLessThan(99_999)
  })

  /** MCP server 重连会原样再注册一遍 —— 那是正常路径,不是错误 */
  it('重复的 internalId 是替换,且名字不变', async () => {
    const r = new ToolRegistry()
    const first = r.register(reg({ internalId: 'read file', description: '旧' }))
    const second = r.register(reg({ internalId: 'read file', description: '新' }))
    expect(r.size).toBe(1)
    expect(second.externalName).toBe(first.externalName)
    expect(r.resolveByExternalName(first.externalName)?.description).toBe('新')
  })
})

describe('ToolRegistry · 下线', () => {
  it('只下线指定来源', () => {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'builtin_a' }))
    r.register(reg({ internalId: 'mcp_a', source: { kind: 'mcp', serverId: 's1' } }))
    r.register(reg({ internalId: 'mcp_b', source: { kind: 'mcp', serverId: 's2' } }))

    expect(r.unregisterBySource({ kind: 'mcp', serverId: 's1' })).toBe(1)
    expect(r.snapshot().map((t) => t.internalId)).toEqual(['builtin_a', 'mcp_b'])
  })

  it('下线不存在的来源是安全的', () => {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'a' }))
    expect(r.unregisterBySource({ kind: 'skill', skillId: 'nope' })).toBe(0)
    expect(r.size).toBe(1)
  })

  /**
   * ★ 方案 §4.4 点名的坑:某个工具**正在执行**时它的来源被下线,不能打断它。
   *
   * 这里天然满足的前提是执行方**持有 Tool 对象的引用**,而不是在完成时回注册表
   * 重新查找。这条测试就是钉住这个前提 —— 哪天有人把 execute 改成
   * `registry.resolve(name).execute(...)` 的两段式,它会立刻红。
   */
  it('执行途中来源被下线不影响这次执行', async () => {
    const r = new ToolRegistry()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))

    const tool = r.register(
      reg({
        internalId: 'mcp_slow',
        source: { kind: 'mcp', serverId: 's1' },
        execute: async (): Promise<ToolResult> => {
          await gate
          return toolOk('完成了')
        }
      })
    )

    const running = tool.execute({}, ctx())
    r.unregisterBySource({ kind: 'mcp', serverId: 's1' })
    expect(r.size).toBe(0) // 已经从注册表消失
    release()
    expect((await running).output.content).toBe('完成了') // 但这次执行照常收尾
  })

  /**
   * server 中途断开后,模型下一轮仍可能回传那个名字(它是上一轮下发的)。
   * 必须是 undefined 让调用方产出**工具错误**,而不是崩溃。
   */
  it('下线后按名字解析不到', () => {
    const r = new ToolRegistry()
    const t = r.register(reg({ internalId: 'gone', source: { kind: 'mcp', serverId: 's1' } }))
    r.unregisterBySource({ kind: 'mcp', serverId: 's1' })
    expect(r.resolveByExternalName(t.externalName)).toBeUndefined()
  })
})

describe('ToolRegistry · snapshot', () => {
  function seeded(): ToolRegistry {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'read', readOnly: true }))
    r.register(reg({ internalId: 'write', readOnly: false }))
    r.register(reg({ internalId: 'rm', readOnly: false, destructive: true }))
    return r
  }

  /** ★ plan 模式的**真正实现**:过滤掉写工具,而不是在提示词里祈祷(方案 §4.8) */
  it('readOnlyOnly 过滤掉所有写工具', () => {
    expect(seeded().snapshot({ readOnlyOnly: true }).map((t) => t.internalId)).toEqual(['read'])
  })

  /**
   * Composer 上那颗「联网搜索」药丸的落点。三条用例分别钉三件不同的事:
   *
   * ① 关掉时联网工具**不下发** —— 不然模型会先白跑一轮再被权限闸拒掉;
   * ② 打开时它回来,且不影响别的工具;
   * ③ **不传这个字段时不过滤**。`snapshot()` 有一堆调用点(Skill、子代理、诊断),
   *    默认过滤掉联网工具的话,某个调用点忘了传就会表现成「搜索工具时有时没有」——
   *    而真正承重的那道闸在 `permission-gate.ts`,它不看这个字段。
   */
  function withNet(): ToolRegistry {
    const r = seeded()
    r.register(reg({ internalId: 'WebFetch', readOnly: true, needsNetwork: true }))
    return r
  }

  it('network:false 时联网工具不下发', () => {
    const ids = withNet()
      .snapshot({ network: false })
      .map((t) => t.internalId)
    expect(ids).not.toContain('WebFetch')
    expect(ids).toContain('read')
  })

  it('network:true 时联网工具照常下发', () => {
    expect(
      withNet()
        .snapshot({ network: true })
        .map((t) => t.internalId)
    ).toContain('WebFetch')
  })

  it('不传 network 时不过滤', () => {
    expect(
      withNet()
        .snapshot()
        .map((t) => t.internalId)
    ).toContain('WebFetch')
  })

  /** 两个过滤器是**与**的关系:plan 模式下一个只读的联网工具仍然要被联网闸拦住 */
  it('readOnlyOnly 与 network 同时生效', () => {
    expect(withNet().snapshot({ readOnlyOnly: true, network: false }).map((t) => t.internalId)).toEqual([
      'read'
    ])
  })

  it('无过滤时全部返回,且保持注册顺序', () => {
    expect(seeded().snapshot().map((t) => t.internalId)).toEqual(['read', 'write', 'rm'])
  })

  /** Skill 作者写的可能是任一个名字 —— 让他去猜我们内部用哪个是没有道理的 */
  it('allowList 同时认 internalId 与 externalName', () => {
    const r = new ToolRegistry()
    const long = r.register(reg({ internalId: 'mcp__very-long-server-name__do_something_useful_x' }))
    r.register(reg({ internalId: 'read' }))
    r.register(reg({ internalId: 'other' }))

    expect(r.snapshot({ allowList: ['read'] }).map((t) => t.internalId)).toEqual(['read'])
    expect(r.snapshot({ allowList: [long.externalName] }).map((t) => t.internalId)).toEqual([
      long.internalId
    ])
  })

  it('空 allowList 意味着一个都不给', () => {
    expect(seeded().snapshot({ allowList: [] })).toEqual([])
  })

  it('两个过滤条件是与关系', () => {
    expect(seeded().snapshot({ readOnlyOnly: true, allowList: ['write'] })).toEqual([])
  })

  /**
   * ★ **每轮开始时取一次**(方案 §4.4)。快照必须是一份拷贝,
   * 否则下一轮的注册变动会追溯性地改变上一轮下发给模型的工具列表。
   */
  it('快照不随后续注册变化', () => {
    const r = seeded()
    const snap = r.snapshot()
    r.register(reg({ internalId: '后来的' }))
    expect(snap).toHaveLength(3)
    expect(r.snapshot()).toHaveLength(4)
  })
})

describe('ToolRegistry · 解析与 info', () => {
  it('按 externalName 解析回工具', () => {
    const r = new ToolRegistry()
    const t = r.register(reg({ internalId: 'read file' }))
    expect(r.resolveByExternalName(t.externalName)?.internalId).toBe('read file')
  })

  /** 模型会编名字。编出来的名字必须解析失败,而不是碰巧命中别的工具 */
  it('没见过的名字解析为 undefined', () => {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'read' }))
    expect(r.resolveByExternalName('read_file_v2')).toBeUndefined()
  })

  /**
   * ★ `info()` 要过 IPC。`execute` 是闭包,过不了结构化克隆 ——
   * 忘了剥掉它,`agent:listTools` 就会在运行时抛
   * `DataCloneError: function could not be cloned`,而类型检查一声不吭。
   */
  it('info 剥掉 execute 且能通过结构化克隆', () => {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'read' }))
    const info = r.info()
    expect(info[0]).not.toHaveProperty('execute')
    expect(() => structuredClone(info)).not.toThrow()
  })

  it('info 同样支持过滤', () => {
    const r = new ToolRegistry()
    r.register(reg({ internalId: 'read', readOnly: true }))
    r.register(reg({ internalId: 'write', readOnly: false }))
    expect(r.info({ readOnlyOnly: true }).map((t) => t.internalId)).toEqual(['read'])
  })

  it('execute 拿到的是注册时给的那个函数与 ctx', async () => {
    const r = new ToolRegistry()
    const spy = vi.fn(async () => toolOk('done'))
    const t = r.register(reg({ internalId: 'x', execute: spy }))
    const c = ctx({ depth: 2 })
    await t.execute({ a: 1 }, c)
    expect(spy).toHaveBeenCalledWith({ a: 1 }, c)
  })
})
