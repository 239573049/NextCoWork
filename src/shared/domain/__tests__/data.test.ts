import { describe, expect, it } from 'vitest'
import {
  DATA_EXPORT_TYPE,
  DATA_EXPORT_VERSION,
  cutoffForAge,
  dataMergeDecision,
  isDataExport
} from '../data'
import { DEFAULT_SETTINGS } from '../settings'

function minimalExport(): Record<string, unknown> {
  return {
    type: DATA_EXPORT_TYPE,
    version: DATA_EXPORT_VERSION,
    exportedAt: '2026-09-05T00:00:00.000Z',
    settings: structuredClone(DEFAULT_SETTINGS),
    workspaces: [],
    sessions: [],
    providers: [],
    aliases: [],
    mcpServers: [],
    searchProviders: [],
    disabledSkillIds: []
  }
}

describe('dataMergeDecision', () => {
  it('本地不存在时直接新增', () => {
    expect(dataMergeDecision(undefined, { id: 'new' })).toBe('new')
  })

  it('双方时间都有效且导入更新时覆盖', () => {
    expect(dataMergeDecision({ updatedAt: 10 }, { updatedAt: 11 })).toBe('overwrite')
  })

  it.each([
    [{ updatedAt: 10 }, { updatedAt: 10 }],
    [{ updatedAt: 11 }, { updatedAt: 10 }],
    [{}, { updatedAt: 10 }],
    [{ updatedAt: 10 }, {}],
    [{ updatedAt: Number.NaN }, { updatedAt: 20 }],
    [{ updatedAt: 10 }, { updatedAt: Number.POSITIVE_INFINITY }]
  ])('相等、较旧、缺失或非法时间都保留本地 %#', (local, incoming) => {
    expect(dataMergeDecision(local, incoming)).toBe('skip')
  })

  it('规则对别名及各种配置记录保持一致', () => {
    const records = [
      { providerId: 'p', alias: 'm', updatedAt: 2 },
      { id: 'provider', updatedAt: 2 },
      { id: 'mcp', updatedAt: 2 },
      { id: 'search', updatedAt: 2 },
      { id: 'workspace', updatedAt: 2 }
    ]
    for (const incoming of records) {
      expect(dataMergeDecision({ ...incoming, updatedAt: 1 }, incoming)).toBe('overwrite')
      expect(dataMergeDecision({ ...incoming, updatedAt: 3 }, incoming)).toBe('skip')
    }
  })
})

describe('cutoffForAge', () => {
  it.each([3, 6, 12] as const)('按 %s 个日历月计算并保留时分秒', (months) => {
    const now = new Date(2026, 8, 5, 13, 14, 15, 123).getTime()
    const expected = new Date(2026, 8 - months, 5, 13, 14, 15, 123).getTime()
    expect(cutoffForAge(now, months)).toBe(expected)
  })

  it('月末会夹到目标月最后一天，不会溢出并多删几天', () => {
    const may31 = new Date(2025, 4, 31, 8, 9, 10, 11).getTime()
    expect(new Date(cutoffForAge(may31, 3))).toEqual(new Date(2025, 1, 28, 8, 9, 10, 11))

    const leapMay31 = new Date(2024, 4, 31, 8, 9, 10, 11).getTime()
    expect(new Date(cutoffForAge(leapMay31, 3))).toEqual(new Date(2024, 1, 29, 8, 9, 10, 11))
  })
})

describe('isDataExport', () => {
  it('接受当前格式和缺少 data 设置块的旧格式', () => {
    const current = minimalExport()
    expect(isDataExport(current)).toBe(true)

    const legacy = minimalExport()
    const settings = legacy.settings as Record<string, unknown>
    delete settings.data
    expect(isDataExport(legacy)).toBe(true)
  })

  it('拒绝未来版本以外的结构损坏、重复主键与空凭证引用', () => {
    const duplicate = minimalExport()
    duplicate.workspaces = [
      {
        id: 'w', name: 'A', rootPath: '/a', settings: {
          permissionMode: 'auto', defaultModel: '', defaultMode: 'normal',
          defaultThinking: 'auto', webSearch: true, activeSkillIds: []
        }, createdAt: 1, lastOpenedAt: 1
      },
      {
        id: 'w', name: 'B', rootPath: '/b', settings: {
          permissionMode: 'auto', defaultModel: '', defaultMode: 'normal',
          defaultThinking: 'auto', webSearch: true, activeSkillIds: []
        }, createdAt: 2, lastOpenedAt: 2
      }
    ]
    expect(isDataExport(duplicate)).toBe(false)

    const emptyRef = minimalExport()
    emptyRef.providers = [{
      id: 'p',
      name: 'P',
      protocol: 'anthropic',
      baseUrl: 'https://example.invalid',
      credentialRef: '',
      priority: 0,
      enabled: true
    }]
    expect(isDataExport(emptyRef)).toBe(false)

    expect(isDataExport({ ...minimalExport(), sessions: 'not-an-array' })).toBe(false)
  })
})
