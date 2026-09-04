import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount } from '../format'

describe('formatBytes', () => {
  it('1KB 以下用整数字节', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('逐级进位,一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  })

  /** 步骤 6 之前拿不到数 —— 界面上出现 `NaN MB` 时没人分得清是没实现还是算错了 */
  it('拿不到数时是破折号,不是 NaN', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('formatCount', () => {
  it('正常与降级', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1234)).toBe('1234')
    expect(formatCount(undefined)).toBe('—')
  })
})
