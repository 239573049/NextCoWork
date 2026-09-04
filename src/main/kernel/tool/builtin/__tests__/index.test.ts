import { describe, expect, it } from 'vitest'
import { EXTERNAL_NAME_RE } from '../../../../../shared/agent/tool'
import { builtinTools } from '../index'

/**
 * 内置工具**清单本身**的测试 —— 不测任何一个工具做了什么,只测这张表的形状。
 *
 * 之所以值得单独一个文件:这张表出错的方式全都是「别处挂掉,而这里看不出来」。
 */

describe('builtinTools()', () => {
  /**
   * ★ 这条用例保护的是**另一个文件**。
   *
   * `src/main/kernel/upstream/demo.ts:318` 拿 `tools[0]` 按名字发起调用。
   * echo 不在第一位时,演示上游会改去调 `Read`,拿 `demoInput` 瞎构造一个入参,
   * 于是 `agent-run.test.ts` 那条 `'演示值:text'` 挂在一个和数组顺序毫无关系的
   * 断言上 —— 而报错信息里没有任何东西会指向这个文件。
   */
  it('★ echo 必须排第一 —— 演示上游挑的是 tools[0]', () => {
    const first = builtinTools()[0]
    expect(
      first?.internalId,
      'demo.ts 的演示上游按 tools[0] 发起调用。换了第一位,' +
        'src/main/kernel/__tests__/agent-run.test.ts 里的「演示值:text」' +
        '会以看不出根因的方式挂掉 —— 要挪顺序请先改 demo.ts。'
    ).toBe('echo')
  })

  it('CC 的那几个名字一个不少,而且拼写一致', () => {
    const ids = builtinTools().map((t) => t.internalId)
    for (const want of ['Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep']) {
      expect(ids, `少了 ${want}`).toContain(want)
    }
  })

  it('internalId 不重复 —— 重名会被注册表悄悄顶掉', () => {
    const ids = builtinTools().map((t) => t.internalId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /** 名字不合法的话,上游会以 400 拒掉整个请求,而不是只丢掉这一个工具 */
  it('每个 internalId 都能直接当外部名字用', () => {
    for (const t of builtinTools()) {
      expect(EXTERNAL_NAME_RE.test(t.internalId), t.internalId).toBe(true)
    }
  })

  /**
   * plan 模式靠 `readOnly` 摘掉写工具。标错的代价是**计划模式下真的写了盘**,
   * 而那正是这个模式唯一要保证的事。
   */
  it('★ 只读标记与工具的实际行为对得上', () => {
    const byId = new Map(builtinTools().map((t) => [t.internalId, t]))
    for (const id of ['Read', 'LS', 'Glob', 'Grep']) {
      expect(byId.get(id)?.readOnly, id).toBe(true)
    }
    for (const id of ['Write', 'Edit']) {
      expect(byId.get(id)?.readOnly, id).toBe(false)
      expect(byId.get(id)?.destructive, id).toBe(true)
    }
  })

  /** 描述是模型选工具的**唯一**依据。空描述 = 这个工具基本不会被用上 */
  it('每个工具都有一段够用的描述', () => {
    for (const t of builtinTools()) {
      expect(t.description.length, t.internalId).toBeGreaterThan(20)
    }
  })

  it('每次调用返回的是新数组 —— 调用方改它不会污染下一次', () => {
    const a = builtinTools()
    a.pop()
    expect(builtinTools().length).toBeGreaterThan(a.length)
  })
})
