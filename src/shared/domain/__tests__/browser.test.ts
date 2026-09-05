import { describe, expect, it } from 'vitest'
import { browserPartition } from '../browser'

describe('browserPartition', () => {
  it('同一 Profile 在不同工作区使用不同的持久会话', () => {
    expect(browserPartition('workspace-a', 'profile-1')).not.toBe(
      browserPartition('workspace-b', 'profile-1')
    )
  })

  it('同一工作区的不同 Profile 使用不同的持久会话', () => {
    expect(browserPartition('workspace-a', 'profile-1')).not.toBe(
      browserPartition('workspace-a', 'profile-2')
    )
  })

  it('对分隔符编码，避免不同标识组合碰撞', () => {
    expect(browserPartition('a/profile-b', 'c')).not.toBe(browserPartition('a', 'b/profile-c'))
    expect(browserPartition('工作区 A', '账号/一')).toContain(encodeURIComponent('账号/一'))
  })
})
