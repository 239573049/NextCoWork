/**
 * 「子代理不问人」的**工具表那一半**。
 *
 * `Task` 的工具描述里白纸黑字写着 *A SUBAGENT CANNOT ASK THE USER ANYTHING*
 * (`builtin/task.ts`),而机制一直没跟上:`allowedTools` 只在 agent 定义写了
 * `tools:` 时才收窄,所以**默认子代理拿得到 `AskUserQuestion`**。它一调,
 * `InteractionGate.request()` 就永久挂住 —— 那个 Promise 只在 `answer()` 或
 * abort 时结算,而子代理的提问在界面上根本无处可答:`Thread` 的审批面板随父 run
 * 结束而消失,`listInteractions` 在父 handle 回收后返回空数组。
 *
 * 症状就是用户看到的那张卡片:跑了一个钟头,工具调用数不动,里面什么也没发生。
 *
 * 和 `network-filter.test.ts` 同一个形状:那边钉联网药丸,这边钉这一道。
 */
import { describe, expect, it } from 'vitest'
import { builtinTools } from '../builtin'
import { ToolRegistry } from '../registry'

function seeded(): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of builtinTools()) r.register(t)
  return r
}

/**
 * ★ 一律带上 `mode: 'plan'`。
 *
 * `snapshot()` 只在 plan 档放行 `submit_plan`,而 plan 档**会传染给子代理**
 * (`childRequestFor`:`mode: parentReq.mode === 'plan' ? 'plan' : 'normal'`)——
 * 所以「规划模式下派出去的子代理」正是第二条死锁路径,也正是这几条用例要钉的场景。
 * 不传 mode 的话 `submit_plan` 照样在表里(缺省不过滤),但那测的就不是真实路径了。
 */
const ids = (r: ToolRegistry, noInteraction?: boolean): string[] =>
  r.snapshot(noInteraction === undefined ? { mode: 'plan' } : { mode: 'plan', noInteraction }).map((t) => t.internalId)

describe('子代理不问人 · 工具快照', () => {
  it('noInteraction:true 时两个交互工具都不在快照里', () => {
    const list = ids(seeded(), true)
    expect(list).not.toContain('AskUserQuestion')
    expect(list).not.toContain('submit_plan')
  })

  /**
   * ★ 摘掉的**正好**是那两个,一个不多一个不少。
   *
   * 用差集而不是逐个点名:将来再加一个会向用户发问的工具时,这条会因为差集变了
   * 而红 —— 提醒人来回答「子代理调到它会不会又挂住」。漏掉一个的代价不是
   * 一次报错,是一次静默的永久阻塞。
   *
   * (`RequestPlanApproval` 不在这份名单里,不是漏了:`builtin/interaction.ts`
   * 虽然定义了它,`builtin/index.ts` 从来没有注册过它 —— 它已被带 plan-v2 落库的
   * `submit_plan` 取代。下一条用例把这件事本身也钉住。)
   */
  it('摘掉前后的差集正好是交互工具集', () => {
    const r = seeded()
    const gone = new Set(ids(r))
    for (const id of ids(r, true)) gone.delete(id)
    expect([...gone].sort()).toEqual(['AskUserQuestion', 'submit_plan'])
  })

  /**
   * ★ 这条钉的是「名单为什么就这两个」。
   *
   * 判据不是我记得有几个,是**代码里 `await ctx.interact(...)` 的工具就这两个**。
   * 哪天有人给第三个工具接上 `ctx.interact` 却忘了往 `INTERACTIVE_TOOLS` 里加,
   * 上面那条差集用例会红;而哪天有人真把 `planApprovalTool` 注册进去,这条会红。
   * 两个方向都有人守着。
   */
  it('注册表里会向用户发问的工具只有这两个', () => {
    const all = new Set(ids(seeded()))
    expect(all.has('AskUserQuestion')).toBe(true)
    expect(all.has('submit_plan')).toBe(true)
    // 定义在 interaction.ts 但从未被 builtin/index.ts 注册 —— 是死代码,不是遗漏
    expect(all.has('RequestPlanApproval')).toBe(false)
  })

  /** 主代理那条路一个字都不该变 —— 缺省不过滤 */
  it('不传 noInteraction 时它们照常在', () => {
    const list = ids(seeded())
    expect(list).toContain('AskUserQuestion')
    expect(list).toContain('submit_plan')
  })

  it('摘掉交互工具不影响其他工具', () => {
    const list = ids(seeded(), true)
    for (const id of ['Read', 'Grep', 'Task']) {
      expect(list).toContain(id)
    }
  })

  /** 两道闸互不干扰:联网开着、只是不许问人 */
  it('和联网闸叠加时各管各的', () => {
    const list = seeded().snapshot({ noInteraction: true, network: true }).map((t) => t.internalId)
    expect(list).toContain('web_search')
    expect(list).not.toContain('AskUserQuestion')
  })
})
