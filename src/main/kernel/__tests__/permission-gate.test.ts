import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '../../../shared/agent/permission'
import { PERMISSION_MODES } from '../../../shared/agent/permission'
import { TOOLS_NEEDING_NETWORK, evaluate, permissionFacts } from '../permission-gate'
import { builtinTools } from '../tool/builtin'

/**
 * 权限闸门的**穷举**表。
 *
 * ★ 下面那张 `GOLDEN` 是**手写的期望值**,不是从 `evaluate()` 生成的。
 * 用一个「独立实现的期望函数」来对拍是没有意义的 —— 那只是把同一套 if 抄了两遍,
 * 两边一起改错的时候测试照绿。所以这里写死 48 行结果,改动策略必然改到这张表,
 * 而改表的人会被迫逐行看一眼自己在放开什么。
 *
 * 列:模式 / readOnly / destructive / needsNetwork / webSearch → 结果(1 = true)
 *
 * `readOnly` 与 `destructive` 同时为真是不合理的组合,但仍然列进来 ——
 * 穷举的价值就在于「不合理的输入也有确定的答案」,而这里的答案是「按只读放行」。
 */
const GOLDEN = `
ask  1 1 1 1 allow
ask  1 1 1 0 deny
ask  1 1 0 1 allow
ask  1 1 0 0 allow
ask  1 0 1 1 allow
ask  1 0 1 0 deny
ask  1 0 0 1 allow
ask  1 0 0 0 allow
ask  0 1 1 1 ask
ask  0 1 1 0 deny
ask  0 1 0 1 ask
ask  0 1 0 0 ask
ask  0 0 1 1 ask
ask  0 0 1 0 deny
ask  0 0 0 1 ask
ask  0 0 0 0 ask
auto 1 1 1 1 allow
auto 1 1 1 0 deny
auto 1 1 0 1 allow
auto 1 1 0 0 allow
auto 1 0 1 1 allow
auto 1 0 1 0 deny
auto 1 0 0 1 allow
auto 1 0 0 0 allow
auto 0 1 1 1 ask
auto 0 1 1 0 deny
auto 0 1 0 1 ask
auto 0 1 0 0 ask
auto 0 0 1 1 allow
auto 0 0 1 0 deny
auto 0 0 0 1 allow
auto 0 0 0 0 allow
full 1 1 1 1 allow
full 1 1 1 0 deny
full 1 1 0 1 allow
full 1 1 0 0 allow
full 1 0 1 1 allow
full 1 0 1 0 deny
full 1 0 0 1 allow
full 1 0 0 0 allow
full 0 1 1 1 allow
full 0 1 1 0 deny
full 0 1 0 1 allow
full 0 1 0 0 allow
full 0 0 1 1 allow
full 0 0 1 0 deny
full 0 0 0 1 allow
full 0 0 0 0 allow
`

interface Row {
  mode: PermissionMode
  readOnly: boolean
  destructive: boolean
  needsNetwork: boolean
  webSearch: boolean
  want: string
  label: string
}

const ROWS: Row[] = GOLDEN.trim()
  .split('\n')
  .map((line) => {
    const [mode, ro, de, ne, we, want] = line.trim().split(/\s+/)
    return {
      mode: mode as PermissionMode,
      readOnly: ro === '1',
      destructive: de === '1',
      needsNetwork: ne === '1',
      webSearch: we === '1',
      want: want ?? '',
      label: line.trim()
    }
  })

describe('PermissionGate · 穷举那张表', () => {
  it('表本身是完备的:3 档 × 4 个布尔 = 48 行,无重复无遗漏', () => {
    expect(ROWS).toHaveLength(48)
    const keys = new Set(ROWS.map((r) => `${r.mode}${String(r.readOnly)}${String(r.destructive)}${String(r.needsNetwork)}${String(r.webSearch)}`))
    expect(keys.size).toBe(48)
    expect(new Set(ROWS.map((r) => r.mode))).toEqual(new Set(PERMISSION_MODES))
    for (const r of ROWS) expect(['allow', 'deny', 'ask'], r.label).toContain(r.want)
  })

  for (const r of ROWS) {
    it(r.label, () => {
      expect(evaluate(r).kind, r.label).toBe(r.want)
    })
  }
})

/**
 * 上面 48 行已经把结果钉死了,这一组钉的是**为什么是这个结果** ——
 * 也就是那几行的**顺序**。顺序错了,上面某几行会跟着变,但从失败信息里
 * 看不出是顺序的问题;这几条的名字就是答案。
 */
describe('PermissionGate · 顺序即语义', () => {
  it('★ 联网开关排在只读放行之前 —— 只读的联网工具在开关关掉时仍然要拒', () => {
    const o = evaluate({
      mode: 'full',
      readOnly: true,
      destructive: false,
      needsNetwork: true,
      webSearch: false
    })
    expect(o.kind).toBe('deny')
  })

  it('★ full 档也放宽不了联网开关 —— 那是用户的硬开关,不是权限档位', () => {
    for (const mode of PERMISSION_MODES) {
      const o = evaluate({
        mode,
        readOnly: false,
        destructive: false,
        needsNetwork: true,
        webSearch: false
      })
      expect(o.kind, mode).toBe('deny')
    }
  })

  it('★ ask 档下的只读工具直接放行 —— 每读一个文件弹一次窗,用户会学会无脑点允许', () => {
    const o = evaluate({
      mode: 'ask',
      readOnly: true,
      destructive: true,
      needsNetwork: false,
      webSearch: false
    })
    expect(o.kind).toBe('allow')
  })

  it('auto 档只对破坏性操作发问,非破坏的写操作直接放行', () => {
    const base = { mode: 'auto' as const, readOnly: false, needsNetwork: false, webSearch: true }
    expect(evaluate({ ...base, destructive: true }).kind).toBe('ask')
    expect(evaluate({ ...base, destructive: false }).kind).toBe('allow')
  })

  it('needsNetwork 省略时等同 false —— 绝大多数工具不用写这个字段', () => {
    const o = evaluate({ mode: 'full', readOnly: false, destructive: true, webSearch: false })
    expect(o.kind).toBe('allow')
  })
})

describe('PermissionGate · 拒绝的说辞', () => {
  it('★ 联网被拒时要堵死「改用 Bash 里的 curl」这条路', () => {
    const o = evaluate({
      mode: 'full',
      readOnly: true,
      destructive: false,
      needsNetwork: true,
      webSearch: false
    })
    expect(o.kind === 'deny' && o.reason).toContain('curl')
    expect(o.kind === 'deny' && o.reason).toContain('user')
  })
})

describe('TOOLS_NEEDING_NETWORK', () => {
  /**
   * ★ 这条是**跨文件**的一致性检查。表里写错一个字(`webFetch` / `web_fetch`)
   * 的后果是:联网开关变成一个什么都不管的摆设,而所有单测照绿 ——
   * 因为 `evaluate()` 自己是对的,错的是没人往它手里递 `needsNetwork: true`。
   */
  it('★ 每一项都必须是真实注册了的 internalId', () => {
    const ids = new Set(builtinTools().map((t) => t.internalId))
    for (const id of TOOLS_NEEDING_NETWORK) {
      expect(ids, `TOOLS_NEEDING_NETWORK 里的 "${id}" 不是任何一个已注册工具的 internalId`).toContain(id)
    }
  })

  it('WebFetch 在表里', () => {
    expect(TOOLS_NEEDING_NETWORK.has('WebFetch')).toBe(true)
  })

  it('文件类工具不在表里 —— 在的话联网开关会顺手把读文件也关掉', () => {
    for (const id of ['Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep', 'Bash', 'TodoWrite']) {
      expect(TOOLS_NEEDING_NETWORK.has(id), id).toBe(false)
    }
  })

  /**
   * ★ 表和字段是**取或**的关系(见 `runtime.ts` 里那一行),所以它们不一致时
   * 这道闸仍然是对的 —— 但那说明有一边写漏了,而漏的那一边可能是将来唯一被读的那边。
   * 这条不是安全断言,是**一致性**断言,失败信息要说清该改哪一边。
   */
  it('★ 表里的每个内置工具,自己的 needsNetwork 字段也必须是 true', () => {
    for (const t of builtinTools()) {
      if (!TOOLS_NEEDING_NETWORK.has(t.internalId)) continue
      expect(
        t.needsNetwork,
        `${t.internalId} 在 TOOLS_NEEDING_NETWORK 里,但它的 needsNetwork 字段是 false —— ` +
          `请改工具那边的字段,别把这张下限表当成唯一的判定来源`
      ).toBe(true)
    }
  })

  /**
   * ★ 这条用例的价值全在**失败的时候**:新加一个联网工具却忘了更新下限表,
   * 它会在这里挡下来。所以断言写成「两边完全一致」,而不是「表里的都在」——
   * 后者放得过「工具说自己联网、表里没有」这一半,而那一半才是会漏的那一半。
   *
   * `Bash` **刻意不在这两边**:标它联网等于「关掉联网开关 = 关掉 Bash」,
   * 而那不是那颗药丸上写的意思。curl 这条路由 `NETWORK_OFF` 在提示词层面拦。
   */
  it('★ 出网的内置工具 = 下限表 —— 加一个就得同时更新两边', () => {
    const net = builtinTools()
      .filter((t) => t.needsNetwork)
      .map((t) => t.internalId)
      .sort()
    expect(net).toEqual([...TOOLS_NEEDING_NETWORK].sort())
    expect(net).toEqual(['WebFetch', 'web_search'])
  })
})

/**
 * `permissionFacts` —— 系统提示词 `# Environment` 里那几行。
 *
 * ★ 这一组钉的不是文案,是**它和上面那张表说同一件事**。漂移的表现最坏:
 * 提示词说「写盘会被拒」而闸门其实放行,模型就会**提前放弃**一件它做得成的事,
 * 而这中间不会有任何报错。
 */
describe('permissionFacts', () => {
  it('三档说三种话', () => {
    expect(permissionFacts('ask', true)).toContain('Permission mode: ask')
    expect(permissionFacts('ask', true)).toContain('DENIED')
    expect(permissionFacts('auto', true)).toContain('DENIED') // 破坏性操作那一档
    expect(permissionFacts('full', true)).not.toContain('DENIED')
  })

  it('★ 读永远放行 —— 三档都不能把读说成要审批', () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionFacts(mode, true)).toContain('Reading and searching: run without asking')
    }
  })

  it('★ 联网开关连 full 档都放宽不了,而且要堵死 Bash 那条路', () => {
    const s = permissionFacts('full', false)

    expect(s).toContain('the network switch is off')
    expect(s).toContain('Bash')
  })

  it('★ 说的和那张表判的是同一件事', () => {
    for (const mode of PERMISSION_MODES) {
      for (const webSearch of [true, false]) {
        const said = permissionFacts(mode, webSearch)
        const write = evaluate({ mode, readOnly: false, destructive: true, webSearch })
        const line = said.split('\n').find((l) => l.startsWith('- Writing files')) ?? ''

        expect(line.includes('DENIED')).toBe(write.kind === 'ask')
        expect(line.includes('run without asking')).toBe(write.kind === 'allow')
      }
    }
  })
})
