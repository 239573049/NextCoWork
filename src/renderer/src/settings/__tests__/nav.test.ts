import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_PAGE,
  matchPages,
  matchRows,
  SETTINGS_INDEX,
  SETTINGS_PAGES,
  type SettingsPageId
} from '../nav'

const PAGE_IDS = new Set<SettingsPageId>(SETTINGS_PAGES.map((p) => p.id))

describe('导航表与行目录的自洽', () => {
  it('十项,照参考图', () => {
    expect(SETTINGS_PAGES).toHaveLength(10)
  })

  it('行目录里的 page 全都存在', () => {
    for (const r of SETTINGS_INDEX) expect(PAGE_IDS.has(r.page)).toBe(true)
  })

  /** 表和界面漂移是这套搜索唯一的失效方式 —— 这条断言守的是它的一半 */
  it('行目录里的 sub 必须是那一页真有的子 Tab', () => {
    for (const r of SETTINGS_INDEX) {
      if (r.sub === undefined) continue
      const page = SETTINGS_PAGES.find((p) => p.id === r.page)
      expect(page?.subs?.some((s) => s.id === r.sub), `${r.page}/${r.sub}`).toBe(true)
    }
  })

  it('有子 Tab 的页面,它的行必须指明是哪个子 Tab', () => {
    for (const p of SETTINGS_PAGES) {
      if (p.subs === undefined) continue
      for (const r of SETTINGS_INDEX.filter((x) => x.page === p.id)) {
        expect(r.sub, `${p.id}:${r.title}`).toBeDefined()
      }
    }
  })

  it('默认页在表里', () => {
    expect(PAGE_IDS.has(DEFAULT_SETTINGS_PAGE)).toBe(true)
  })
})

describe('matchRows', () => {
  it('空查询返回空 —— 不是返回全部', () => {
    expect(matchRows('')).toEqual([])
    expect(matchRows('   ')).toEqual([])
  })

  it('命中行标题', () => {
    expect(matchRows('期望端口').map((r) => r.title)).toEqual(['期望端口'])
  })

  it('命中英文关键词', () => {
    const titles = matchRows('proxy').map((r) => r.title)
    expect(titles).toContain('启用代理')
    // 三段拆开之后这一行叫「代理服务器」了(协议 / 地址 / 端口 在同一行里)
    expect(titles).toContain('代理服务器')
  })

  it('命中页名 —— 打「连接」应该把这一页的行全带出来', () => {
    const rows = matchRows('连接')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.page === 'connection')).toBe(true)
  })

  it('大小写与前后空格无关', () => {
    expect(matchRows('  THEME  ')).toEqual(matchRows('theme'))
    expect(matchRows('theme').length).toBeGreaterThan(0)
  })

  it('无命中返回空(驱动空态)', () => {
    expect(matchRows('zzzz没有这一项')).toEqual([])
  })
})

describe('matchPages', () => {
  it('页名命中', () => {
    expect(matchPages('关于').map((p) => p.id)).toEqual(['about'])
  })
  it('空查询返回空', () => {
    expect(matchPages('')).toEqual([])
  })
})
