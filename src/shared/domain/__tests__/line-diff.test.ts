import { describe, expect, it } from 'vitest'
import { countLineDiff } from '../line-diff'

describe('countLineDiff', () => {
  it('新建文件:所有行都算新增', () => {
    expect(countLineDiff(null, 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 })
  })

  it('删除文件:所有行都算删除', () => {
    expect(countLineDiff('a\nb', null)).toEqual({ additions: 0, deletions: 2 })
  })

  it('改一行:一增一删', () => {
    expect(countLineDiff('a\nb\nc', 'a\nB\nc')).toEqual({ additions: 1, deletions: 1 })
  })

  it('纯新增行:只增不删', () => {
    expect(countLineDiff('a\nc', 'a\nb\nc')).toEqual({ additions: 1, deletions: 0 })
  })

  it('尾随空行不干扰计数', () => {
    expect(countLineDiff('a\n', 'a\nb\n')).toEqual({ additions: 1, deletions: 0 })
  })

  it('内容相同:零增零删', () => {
    expect(countLineDiff('a\nb', 'a\nb')).toEqual({ additions: 0, deletions: 0 })
  })
})
