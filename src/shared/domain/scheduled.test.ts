import { describe, expect, it } from 'vitest'
import { nextScheduledAt, nextScheduledOccurrence } from './scheduled'

const shanghai = 'Asia/Shanghai'

describe('scheduled date calculation', () => {
  it('interprets one-off local time in the task timezone and stores UTC', () => {
    const next = nextScheduledAt({ kind: 'once', at: '2026-09-12T09:30' }, shanghai, Date.parse('2026-09-11T00:00:00Z'))
    expect(next).toBe(Date.parse('2026-09-12T01:30:00Z'))
  })

  it('advances a daily task by local clock time across the UTC day boundary', () => {
    const next = nextScheduledAt({ kind: 'daily', time: '00:15' }, shanghai, Date.parse('2026-09-11T00:30:00Z'))
    expect(next).toBe(Date.parse('2026-09-11T16:15:00Z'))
  })

  it('supports weekly selection and same-day repeat windows', () => {
    const next = nextScheduledOccurrence(
      { kind: 'weekly', weekdays: [1], time: '09:00' },
      shanghai,
      { enabled: true, endTime: '11:00', intervalMinutes: 60 },
      Date.parse('2026-09-13T02:00:00Z'),
    )
    expect(next).toBe(Date.parse('2026-09-14T01:00:00Z'))
    expect(nextScheduledOccurrence(
      { kind: 'weekly', weekdays: [1], time: '09:00' },
      shanghai,
      { enabled: true, endTime: '11:00', intervalMinutes: 60 },
      Date.parse('2026-09-14T01:30:00Z'),
    )).toBe(Date.parse('2026-09-14T02:00:00Z'))
  })
})
