import { afterEach, describe, expect, it } from 'vitest'
import { recordChange, takeChanges, resetChangeRecorderForTest } from '../change-recorder'

afterEach(() => resetChangeRecorderForTest())

describe('change-recorder', () => {
  it('同一轮多次改同一文件:保留首个 before、推进到最后一个 after', () => {
    recordChange('run', { abs: '/w/a.ts', relPath: 'a.ts', before: 'v0', after: 'v1', inWorkspace: true })
    recordChange('run', { abs: '/w/a.ts', relPath: 'a.ts', before: 'v1', after: 'v2', inWorkspace: true })
    const changes = takeChanges('run')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ before: 'v0', after: 'v2', changeKind: 'modified' })
  })

  it('新建文件的 created 一旦置位不被后续 modify 翻转', () => {
    recordChange('run', { abs: '/w/n.ts', relPath: 'n.ts', before: null, after: 'a', inWorkspace: true })
    recordChange('run', { abs: '/w/n.ts', relPath: 'n.ts', before: 'a', after: 'b', inWorkspace: true })
    const [change] = takeChanges('run')
    expect(change).toMatchObject({ before: null, after: 'b', changeKind: 'created' })
  })

  it('takeChanges 读即清:第二次取空', () => {
    recordChange('run', { abs: '/w/a.ts', relPath: 'a.ts', before: 'x', after: 'y', inWorkspace: true })
    expect(takeChanges('run')).toHaveLength(1)
    expect(takeChanges('run')).toHaveLength(0)
  })

  it('按 runId 分桶,互不串味', () => {
    recordChange('r1', { abs: '/w/a.ts', relPath: 'a.ts', before: '1', after: '2', inWorkspace: true })
    recordChange('r2', { abs: '/w/b.ts', relPath: 'b.ts', before: '3', after: '4', inWorkspace: false })
    expect(takeChanges('r1').map((c) => c.relPath)).toEqual(['a.ts'])
    expect(takeChanges('r2')[0]).toMatchObject({ relPath: 'b.ts', inWorkspace: false })
  })
})
