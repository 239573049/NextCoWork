import { describe, expect, it } from 'vitest'
import { filterRows } from './filter'

const rows = [
  { name: 'deploy', description: '部署到指定环境', scope: 'project' },
  { name: 'init', description: '分析项目并生成 AGENTS.md', scope: 'builtin' },
  { name: 'review', description: '审查改动', scope: 'global' }
]

describe('filterRows', () => {
  it('空查询 + 全部作用域 = 原样返回', () => {
    expect(filterRows(rows, '', 'all')).toHaveLength(3)
  })

  it('按名字搜', () => {
    expect(filterRows(rows, 'depl', 'all').map((r) => r.name)).toEqual(['deploy'])
  })

  it('★ 也按描述搜 —— 记得住「那个部署相关的」却想不起名字，比记错名字更常见', () => {
    expect(filterRows(rows, '审查', 'all').map((r) => r.name)).toEqual(['review'])
  })

  it('搜索忽略大小写和首尾空白', () => {
    expect(filterRows(rows, '  DEPLOY ', 'all').map((r) => r.name)).toEqual(['deploy'])
  })

  it('按作用域筛', () => {
    expect(filterRows(rows, '', 'project').map((r) => r.name)).toEqual(['deploy'])
    expect(filterRows(rows, '', 'global').map((r) => r.name)).toEqual(['review'])
  })

  it('★ builtin 在「全局」「本工作区」下都不出现 —— 它哪一边都不属于', () => {
    expect(filterRows(rows, '', 'global').some((r) => r.scope === 'builtin')).toBe(false)
    expect(filterRows(rows, '', 'project').some((r) => r.scope === 'builtin')).toBe(false)
    expect(filterRows(rows, '', 'all').some((r) => r.scope === 'builtin')).toBe(true)
  })

  it('搜索和作用域是「与」的关系', () => {
    expect(filterRows(rows, '部署', 'global')).toHaveLength(0)
  })
})
