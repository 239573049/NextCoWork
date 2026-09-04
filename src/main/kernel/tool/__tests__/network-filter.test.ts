/**
 * 联网闸的**具体那一例**:Composer 上那颗药丸关掉时,`web_search` 到底在不在
 * 下发给模型的工具表里。
 *
 * `registry.test.ts` 已经用一个合成工具钉住了 `network` 过滤的机制;
 * 这个文件补的是另一半 —— 机制对上了,但**真的那个工具有没有接进去**。
 * 两者会各自失败:前者在过滤逻辑写错时红,后者在 `web_search` 忘了标
 * `needsNetwork` 时红。后一种在合成工具的用例里永远看不出来。
 */
import { describe, expect, it } from 'vitest'
import { builtinTools } from '../builtin'
import { ToolRegistry } from '../registry'

function seeded(): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of builtinTools()) r.register(t)
  return r
}

const ids = (r: ToolRegistry, network?: boolean): string[] =>
  r.snapshot(network === undefined ? {} : { network }).map((t) => t.internalId)

describe('联网闸 · 真的内置工具', () => {
  /** ★ 药丸关掉 = 模型压根看不到搜索工具,而不是看到了再被拒 */
  it('webSearch:false 时 web_search 不在快照里', () => {
    const list = ids(seeded(), false)
    expect(list).not.toContain('web_search')
    expect(list).not.toContain('WebFetch')
  })

  it('webSearch:true 时它回来', () => {
    expect(ids(seeded(), true)).toContain('web_search')
  })

  /** 关掉的**只是**联网工具 —— 顺手把读写工具也过滤掉的话,plan 模式那条路会被改坏 */
  it('关掉联网不影响其他工具', () => {
    const off = ids(seeded(), false)
    for (const id of ['Read', 'Write', 'Edit', 'Bash', 'Grep']) {
      expect(off).toContain(id)
    }
  })

  /**
   * ★ 关掉之后少的**正好**是那两个联网工具,一个不多一个不少。
   *
   * 用差集而不是逐个点名:将来加第三个联网工具时,这条会因为差集变了而红,
   * 提醒人来确认「它真该被这颗药丸管住吗」。
   */
  it('关掉前后的差集正好是联网工具集', () => {
    const r = seeded()
    const gone = new Set(ids(r, true))
    for (const id of ids(r, false)) gone.delete(id)
    expect([...gone].sort()).toEqual(['WebFetch', 'browser_navigate', 'browser_open', 'browser_snapshot', 'web_search'])
  })

  /** 缺省不过滤 —— 理由在 `SnapshotFilter.network` 的注释里 */
  it('不传 network 时 web_search 照常在', () => {
    expect(ids(seeded())).toContain('web_search')
  })
})
