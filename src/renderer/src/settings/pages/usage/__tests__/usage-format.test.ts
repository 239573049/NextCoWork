import { describe, expect, it } from 'vitest'
import type { Translate } from '../../../../i18n'
import {
  formatCompactNumber,
  formatCostMicros,
  formatCosts,
  formatDayLong,
  formatDayShort,
  formatDuration,
  formatLatency,
  formatPercent,
  windowFor
} from '../usage-format'

/** 只回显 key 与参数,断言的是「调了哪条文案、带了什么数」,不依赖真实译文。 */
const t = ((key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}(${JSON.stringify(params)})`) as unknown as Translate

describe('windowFor', () => {
  const now = 1_757_808_000_000

  it('上界是开区间,取 now + 1', () => {
    // 取 now 的话,恰好落在这一毫秒的记录(刚发完的那条)会查不到
    expect(windowFor('24h', now).to).toBe(now + 1)
  })

  it('各档时长正确', () => {
    expect(windowFor('24h', now).from).toBe(now + 1 - 24 * 60 * 60 * 1000)
    expect(windowFor('7d', now).from).toBe(now + 1 - 7 * 24 * 60 * 60 * 1000)
    expect(windowFor('30d', now).from).toBe(now + 1 - 30 * 24 * 60 * 60 * 1000)
  })

  it('全部档不带下界', () => {
    expect(windowFor('all', now)).toEqual({ to: now + 1 })
    expect(windowFor('all', now).from).toBeUndefined()
  })
})

describe('formatCompactNumber', () => {
  // 手写 K/M/B 在中文界面上是错的,这条钉住走的是 Intl
  it('中文出万/亿,英文出 K/M', () => {
    expect(formatCompactNumber(40_732_000, 'zh-CN')).toContain('万')
    expect(formatCompactNumber(40_732_000, 'en-US')).toMatch(/M$/)
  })

  it('百万以下不带小数', () => {
    expect(formatCompactNumber(12_345, 'en-US')).toBe('12K')
  })

  it('零照常显示', () => {
    expect(formatCompactNumber(0, 'en-US')).toBe('0')
  })
})

describe('formatPercent', () => {
  it('null 显示为占位符而不是 0%', () => {
    expect(formatPercent(null, 'en-US')).toBe('—')
  })

  it('0 显示为 0% —— 与 null 不是一回事', () => {
    expect(formatPercent(0, 'en-US')).toBe('0%')
  })

  it('保留一位小数', () => {
    expect(formatPercent(0.4567, 'en-US')).toBe('45.7%')
  })
})

describe('formatCostMicros', () => {
  it('常规金额两位小数', () => {
    expect(formatCostMicros(1_500_000, 'USD', 'en-US')).toBe('$1.50')
  })

  /*
   * 单次请求常常是 0.0003 美元。按两位显示全是 $0.00,而一页的 $0.00 加起来
   * 是真金白银 —— 那样的表格看着像坏了。
   */
  it('不足一分的金额放宽到六位小数(尾随零裁掉)', () => {
    expect(formatCostMicros(300, 'USD', 'en-US')).toBe('$0.0003')
    expect(formatCostMicros(1_234, 'USD', 'en-US')).toBe('$0.001234')
  })

  it('真正的 0 仍显示两位', () => {
    expect(formatCostMicros(0, 'USD', 'en-US')).toBe('$0.00')
  })

  it('币种跟随参数', () => {
    expect(formatCostMicros(2_000_000, 'CNY', 'zh-CN')).toContain('2.00')
  })
})

describe('formatCosts', () => {
  it('空列表显示占位符', () => {
    expect(formatCosts([], 'en-US')).toBe('—')
  })

  // 跨币种相加得到的数字没有单位,比不显示更糟
  it('多币种用 + 并列,不相加', () => {
    const out = formatCosts(
      [
        { currency: 'USD', micros: 1_000_000 },
        { currency: 'CNY', micros: 7_000_000 }
      ],
      'en-US'
    )
    expect(out).toContain('+')
    expect(out).toContain('$1.00')
    expect(out).not.toBe('$8.00')
  })
})

describe('formatLatency', () => {
  it('null 显示占位符', () => {
    expect(formatLatency(null, 'en-US', t)).toBe('—')
  })

  it('小于一秒走毫秒档', () => {
    expect(formatLatency(250, 'en-US', t)).toContain('usage.milliseconds')
  })

  it('一秒及以上走秒档', () => {
    expect(formatLatency(1_200, 'en-US', t)).toContain('usage.seconds')
  })

  it('恰好 1000 毫秒算秒', () => {
    expect(formatLatency(1_000, 'en-US', t)).toContain('usage.seconds')
  })
})

describe('formatDuration', () => {
  it('零和负数显示占位符', () => {
    expect(formatDuration(0, 'en-US', t)).toBe('—')
    expect(formatDuration(-5, 'en-US', t)).toBe('—')
  })

  // 「最长聊天 0 分钟」读起来像功能坏了
  it('不满一分钟走秒档', () => {
    expect(formatDuration(45_000, 'en-US', t)).toContain('usage.duration.s')
  })

  it('不满一小时走分档', () => {
    expect(formatDuration(25 * 60_000, 'en-US', t)).toContain('usage.duration.m')
  })

  it('超过一小时走时分档,分钟取余数不是总数', () => {
    const out = formatDuration((2 * 60 + 13) * 60_000, 'en-US', t)
    expect(out).toContain('usage.duration.hm')
    expect(out).toContain('"hours":"2"')
    expect(out).toContain('"minutes":"13"')
  })

  it('整点小时的分钟是 0 而不是被省略', () => {
    expect(formatDuration(3 * 60 * 60_000, 'en-US', t)).toContain('"minutes":"0"')
  })
})

describe('日期格式化', () => {
  /*
   * ★ 按 UTC 解析并按 UTC 格式化。少了 timeZone: 'UTC',东八区以西的用户会看到
   * 前一天 —— 热力图方块的日期和 tooltip 的日期差一天,两边各自看都像对的。
   */
  it('不随本地时区漂移一天', () => {
    expect(formatDayLong('2026-09-14', 'zh-CN')).toContain('14')
    expect(formatDayLong('2026-09-14', 'zh-CN')).toContain('2026')
    expect(formatDayShort('2026-01-01', 'en-US')).toContain('1')
  })

  it('中文出年月日', () => {
    expect(formatDayLong('2026-09-14', 'zh-CN')).toBe('2026年9月14日')
  })

  it('非法日期原样返回,不显示 Invalid Date', () => {
    expect(formatDayLong('', 'en-US')).toBe('')
    expect(formatDayShort('not-a-day', 'en-US')).toBe('not-a-day')
  })
})
