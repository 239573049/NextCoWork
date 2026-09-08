/**
 * 导入模型弹窗的判断逻辑。
 *
 * ★ 这一组守的坏有一个共同点:**全都不报错。** 弹窗照常打开、按钮照常能点,
 * 只是勾选的结果和用户以为的不一样 —— 而「更新列表」是个替换操作,
 * 差一条就是一条别名被删掉。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_ALIASES_PER_PROVIDER,
  type FetchedModel,
  type ModelAlias
} from '../../../../../../shared/domain/provider'
import { endpointFor, findPreset } from '../../../../../../shared/domain/presets'
import {
  addedModels,
  filterRows,
  importRows,
  initialSelection,
  modelListAvailability,
  submitOrder,
  toggleAll,
  toggleRow,
  type ImportRow
} from '../import-models'

const alias = (upstreamModel: string, aliasName = upstreamModel): ModelAlias => ({
  alias: aliasName,
  providerId: 'p',
  upstreamModel,
  capabilities: { tools: true, vision: true, thinking: false, caching: true },
  contextWindow: 200_000,
  maxOutputTokens: 8192
})

const fetched = (...ids: string[]): FetchedModel[] => ids.map((id) => ({ id }))
const row = (id: string, added = false, fromUpstream = true): ImportRow => ({
  id,
  added,
  fromUpstream
})

describe('importRows', () => {
  it('上游顺序照搬,已配过的挂 added', () => {
    const rows = importRows(fetched('a', 'b', 'c'), [alias('b')])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows.map((r) => r.added)).toEqual([false, true, false])
    expect(rows.every((r) => r.fromUpstream)).toBe(true)
  })

  it('Anthropic 的 display_name 带过来,OpenAI 族没有就不占位', () => {
    const rows = importRows([{ id: 'a', displayName: 'Claude A' }, { id: 'b' }], [])
    expect(rows[0]?.displayName).toBe('Claude A')
    expect(rows[1]?.displayName).toBeUndefined()
  })

  /**
   * ★★ 这一条是整个文件最重要的。弹窗是**替换**语义,只显示上游报回来的那些的话,
   * 一个用户手工配过、而 `/models` 恰好没列的别名会在他点「更新列表」时被连带删掉,
   * 而他从头到尾没在弹窗里见过它。
   */
  it('★ 本地有、上游这次没报的别名也要列出来,排在末尾并标成非上游', () => {
    const rows = importRows(fetched('a'), [alias('a'), alias('我手工配的')])
    expect(rows.map((r) => r.id)).toEqual(['a', '我手工配的'])
    expect(rows[1]).toEqual({ id: '我手工配的', added: true, fromUpstream: false })
  })

  it('★ 而且它默认是勾上的 —— 默认不勾等于替用户删掉他没见过的东西', () => {
    const rows = importRows(fetched('a'), [alias('本地独有')])
    expect(initialSelection(rows).has('本地独有')).toBe(true)
  })

  it('别名被改过名字时按 upstreamModel 认,不按 alias', () => {
    // 用户把 `gpt-5.6` 的别名改成了「主力」;上游报的仍然是 gpt-5.6
    const rows = importRows(fetched('gpt-5.6'), [alias('gpt-5.6', '主力')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.added).toBe(true)
  })

  it('上游把同一个 id 报了两次只留一行', () => {
    expect(importRows(fetched('a', 'a'), [])).toHaveLength(1)
  })

  it('addedModels 取的是 upstreamModel 那一列', () => {
    expect(addedModels([alias('u1', 'a1')])).toEqual(new Set(['u1']))
  })
})

describe('initialSelection', () => {
  it('已添加的默认勾上,没添加的不勾', () => {
    const rows = [row('a', true), row('b'), row('c', true)]
    expect(initialSelection(rows)).toEqual(new Set(['a', 'c']))
  })

  /**
   * ★ 库里已有的可能超过 20(上限是后加的)。勾满全部会让「更新列表」按钮
   * 点不动又说不清为什么 —— 那比少勾几个糟。
   */
  it('★ 已添加的超过上限时只勾前 20 个,而不是勾满等按钮报错', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`m${String(i)}`, true))
    const sel = initialSelection(rows)
    expect(sel.size).toBe(MAX_ALIASES_PER_PROVIDER)
    expect(sel.has('m0')).toBe(true)
    expect(sel.has('m24')).toBe(false)
  })
})

describe('filterRows', () => {
  const rows = [row('gpt-5.6'), { ...row('claude-x'), displayName: 'Claude X' }]

  it('空查询 = 全部', () => {
    expect(filterRows(rows, '   ')).toHaveLength(2)
  })

  it('按 id 匹配,大小写不敏感', () => {
    expect(filterRows(rows, 'GPT').map((r) => r.id)).toEqual(['gpt-5.6'])
  })

  it('★ 显示名也能搜到 —— Anthropic 那边列表里露出来的是它,不是 id', () => {
    // id 是 claude-x(带连字符),显示名是 Claude X(带空格)。用户照着屏幕上看到的打
    expect(filterRows(rows, 'claude x').map((r) => r.id)).toEqual(['claude-x'])
    expect(filterRows(rows, 'Claude').map((r) => r.id)).toEqual(['claude-x'])
  })

  it('两边都不沾就不出现', () => {
    expect(filterRows(rows, 'llama')).toEqual([])
  })
})

describe('toggleRow', () => {
  it('勾上 / 取消勾选', () => {
    const a = toggleRow(new Set(), 'x')
    expect(a).toEqual({ selected: new Set(['x']), atCap: false })
    expect(toggleRow(a.selected, 'x').selected.size).toBe(0)
  })

  /**
   * ★ 到上限时**报 atCap**,而不是让复选框点下去毫无反应 —— 后者看着就是个 bug,
   * 用户会以为是应用卡了,不会想到「原来是有上限」。
   */
  it('★ 到上限时加不进去,并明确回报 atCap', () => {
    const full = new Set(
      Array.from({ length: MAX_ALIASES_PER_PROVIDER }, (_, i) => `m${String(i)}`)
    )
    const r = toggleRow(full, '再来一个')
    expect(r.atCap).toBe(true)
    expect(r.selected.has('再来一个')).toBe(false)
    expect(r.selected.size).toBe(MAX_ALIASES_PER_PROVIDER)
  })

  it('到上限时**取消**勾选照样能做 —— 否则就锁死了', () => {
    const full = new Set(
      Array.from({ length: MAX_ALIASES_PER_PROVIDER }, (_, i) => `m${String(i)}`)
    )
    expect(toggleRow(full, 'm0').selected.size).toBe(MAX_ALIASES_PER_PROVIDER - 1)
  })

  it('不改动传进来的那个 Set(React 靠新引用重渲染)', () => {
    const before = new Set(['a'])
    toggleRow(before, 'b')
    expect(before).toEqual(new Set(['a']))
  })
})

describe('toggleAll', () => {
  const visible = [row('a'), row('b'), row('c')]

  it('作用域是筛出来的那些,不是全表', () => {
    // 用户搜了之后点全选:只该动可见的这三个,'z' 不受影响
    const r = toggleAll(new Set(['z']), visible)
    expect(r.selected).toEqual(new Set(['z', 'a', 'b', 'c']))
  })

  it('可见的都已勾上时变成取消全选', () => {
    const r = toggleAll(new Set(['a', 'b', 'c', 'z']), visible)
    expect(r.selected).toEqual(new Set(['z']))
  })

  it('★ 撞上限时勾到满为止并回报 truncated,不是静默少勾', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`m${String(i)}`))
    const r = toggleAll(new Set(), many)
    expect(r.selected.size).toBe(MAX_ALIASES_PER_PROVIDER)
    expect(r.truncated).toBe(true)
  })

  it('可见为空时不算「都已勾上」,不去清空已选', () => {
    expect(toggleAll(new Set(['a']), []).selected).toEqual(new Set(['a']))
  })
})

describe('submitOrder', () => {
  it('★ 照弹窗里的显示顺序提交,不按勾选先后 —— 顺序就是别名表的顺序(首位是主模型)', () => {
    const rows = [row('a'), row('b'), row('c')]
    const sel = new Set(['c', 'a'])
    expect(submitOrder(rows, sel)).toEqual(['a', 'c'])
  })
})

describe('modelListAvailability', () => {
  /** 从预设表里现取,取不到就直说 —— 免得改了预设之后这里断言的是个幻觉 */
  function ep(id: string, protocol: 'anthropic' | 'openai-chat'): { baseUrl: string } {
    const p = findPreset(id)
    if (p === null) throw new Error(`预设 ${id} 不在表里了`)
    const e = endpointFor(p, protocol)
    if (e === null) throw new Error(`预设 ${id} 没有 ${protocol} 端点了`)
    return e
  }

  it('支持拉列表的照常放行,且不废话', () => {
    const e = ep('routin', 'anthropic')
    const r = modelListAvailability({ id: 'routin', protocol: 'anthropic', baseUrl: e.baseUrl })
    expect(r.hint).toBeNull()
  })

  it('免鉴权的那几家:needsKey 为 false,并提示可以先看看', () => {
    const e = ep('openrouter', 'openai-chat')
    const r = modelListAvailability({
      id: 'openrouter',
      protocol: 'openai-chat',
      baseUrl: e.baseUrl
    })
    expect(r.needsKey).toBe(false)
    expect(r.hint).not.toBeNull()
  })

  /**
   * ★★ 这条是本文件的重点:**没有任何输入能让按钮消失**。
   * 曾经 `supportsModelList: false` + 地址没改过会返回 enabled:false,
   * 前端据此把按钮焊死。但那批标记是拿没有有效 key 的请求探的 —— 先验鉴权
   * 再路由的网关一律回 401,于是「key 不对」被记成了「没有列表端点」。
   * 标错成 false 的代价是用户完全没有绕过办法,所以这条禁令整个删掉了。
   */
  it('★ 实测没有列表端点的那家,也只出提示、不再置灰', () => {
    const e = ep('deepseek', 'anthropic')
    const r = modelListAvailability({ id: 'deepseek', protocol: 'anthropic', baseUrl: e.baseUrl })
    expect(r).not.toHaveProperty('enabled')
    expect(r.hint).toContain('可以试')
  })

  it('★ 千帆(被标错成没有列表端点的那家)照样能点', () => {
    const e = ep('qianfan', 'openai-chat')
    const r = modelListAvailability({ id: 'qianfan', protocol: 'openai-chat', baseUrl: e.baseUrl })
    expect(r).not.toHaveProperty('enabled')
    expect(r.hint).toContain('可以试')
  })

  it('地址被改过时,提示换成「你改过地址」那条', () => {
    const r = modelListAvailability({
      id: 'deepseek',
      protocol: 'anthropic',
      baseUrl: 'https://my-relay.example.com/anthropic'
    })
    expect(r.hint).toContain('改过地址')
  })

  it('尾斜杠不算「改过地址」', () => {
    const e = ep('deepseek', 'anthropic')
    expect(
      modelListAvailability({
        id: 'deepseek',
        protocol: 'anthropic',
        baseUrl: `${e.baseUrl}/`
      }).hint
    ).not.toContain('改过地址')
  })

  it('★ 预设里没有这家 = 未知 —— 自建供应商连提示都不给', () => {
    const r = modelListAvailability({
      id: '我司内部网关',
      protocol: 'openai-chat',
      baseUrl: 'https://gw.corp/v1'
    })
    expect(r).toEqual({ hint: null, needsKey: true })
  })

  it('预设有、但没有当前这个协议的端点时也算「未知」', () => {
    // RoutinAI 刻意没有 openai-responses
    expect(
      findPreset('routin') !== null && endpointFor(findPreset('routin')!, 'openai-responses')
    ).toBeNull()
    expect(
      modelListAvailability({
        id: 'routin',
        protocol: 'openai-responses',
        baseUrl: 'https://api.routin.ai/v1'
      }).hint
    ).toBeNull()
  })
})
