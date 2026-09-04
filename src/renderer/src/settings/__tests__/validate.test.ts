/**
 * 「网络」页表单逻辑的用例。
 *
 * 代理这块的坏法有一个共同特征:**界面显示一切正常,流量走的却是另一条路**。
 * 所以下面每一条断言钉住的都是「看起来没坏」的那种坏。
 */
import { describe, expect, it } from 'vitest'
import type { ProxySettings } from '../../../../shared/domain/proxy'
import { DEFAULT_PROXY, DIRECT_BYPASS } from '../../../../shared/domain/proxy'
import {
  bypassSummary,
  hasProxyErrors,
  parsePortInput,
  splitPastedAddress,
  validateProxyForm
} from '../validate'

const manual = (over: Partial<ProxySettings> = {}): ProxySettings => ({
  ...DEFAULT_PROXY,
  enabled: true,
  mode: 'manual',
  host: '127.0.0.1',
  port: 7890,
  ...over
})

describe('validateProxyForm', () => {
  it('填全了没有报错', () => {
    expect(hasProxyErrors(validateProxyForm(manual()))).toBe(false)
  })

  /** ★ 关掉之后不该还红着一片 —— 用户会以为自己关不掉 */
  it('关掉代理时一条都不校验', () => {
    const bad = manual({ enabled: false, host: '', authEnabled: true, authUser: '' })
    expect(validateProxyForm(bad)).toEqual({})
  })

  it('跟随系统时不校验手填的三段', () => {
    expect(validateProxyForm(manual({ mode: 'system', host: '' }))).toEqual({})
  })

  it('手动模式缺地址要报', () => {
    expect(validateProxyForm(manual({ host: '  ' })).host).toBeDefined()
  })

  /** 0 是「没填端口」,合法 —— 交给协议默认值 */
  it('端口 0 合法,越界不合法', () => {
    expect(validateProxyForm(manual({ port: 0 })).port).toBeUndefined()
    expect(validateProxyForm(manual({ port: 70000 })).port).toBeDefined()
    expect(validateProxyForm(manual({ port: -1 })).port).toBeDefined()
  })

  /**
   * ★ 开了认证却没填用户名,`app.on('login')` 那个回调会拿空用户名去认证 ——
   * 而代理服务器给的回应是 407,在界面上和「代理挂了」长得一模一样。
   */
  it('开了认证就必须有用户名', () => {
    expect(validateProxyForm(manual({ authEnabled: true, authUser: '' })).authUser).toBeDefined()
    expect(validateProxyForm(manual({ authEnabled: true, authUser: 'me' })).authUser).toBeUndefined()
    // 没开认证时空用户名无所谓
    expect(validateProxyForm(manual({ authEnabled: false, authUser: '' })).authUser).toBeUndefined()
  })
})

describe('parsePortInput', () => {
  it('空串是「没填」,给 0', () => {
    expect(parsePortInput('')).toBe(0)
    expect(parsePortInput('  ')).toBe(0)
  })

  it('正常数字照收', () => {
    expect(parsePortInput('7890')).toBe(7890)
    expect(parsePortInput(' 1080 ')).toBe(1080)
  })

  /** ★ 打不出数字时返回 null,调用点保持原值 —— 否则删到一半端口就变了 */
  it('非数字给 null,不给 0', () => {
    expect(parsePortInput('abc')).toBeNull()
    expect(parsePortInput('78a90')).toBeNull()
    expect(parsePortInput('-1')).toBeNull()
    expect(parsePortInput('7.8')).toBeNull()
  })

  it('越界给 null', () => {
    expect(parsePortInput('65536')).toBeNull()
    expect(parsePortInput('65535')).toBe(65535)
  })
})

describe('splitPastedAddress', () => {
  /**
   * ★ 不拆的话拼出来的是 `http://socks5://127.0.0.1:1080`,
   * Chromium 静默忽略这条烂规则 —— 症状是「填了代理却在直连」。
   */
  it('粘一整条带协议的地址,拆成三段', () => {
    expect(splitPastedAddress('socks5://127.0.0.1:1080')).toEqual({
      scheme: 'socks5',
      host: '127.0.0.1',
      port: 1080
    })
  })

  it('只带端口的也拆,协议补 http', () => {
    expect(splitPastedAddress('127.0.0.1:7890')).toEqual({
      scheme: 'http',
      host: '127.0.0.1',
      port: 7890
    })
  })

  /** ★ 光打了个主机名不动它 —— 用户可能才打到一半 */
  it('纯主机名返回 null,让调用点别动', () => {
    expect(splitPastedAddress('proxy.corp.com')).toBeNull()
    expect(splitPastedAddress('127.0.0.1')).toBeNull()
    expect(splitPastedAddress('')).toBeNull()
  })

  it('协议默认端口也拆得出来', () => {
    expect(splitPastedAddress('https://proxy.corp.com:443')).toEqual({
      scheme: 'https',
      host: 'proxy.corp.com',
      port: 443
    })
  })

  it('拆不出来的返回 null', () => {
    expect(splitPastedAddress('ftp://x:21')).toBeNull()
    expect(splitPastedAddress('127.0.0.1:99999')).toBeNull()
  })
})

describe('bypassSummary', () => {
  /** ★ 内置那个数由表长算出来 —— 写死的数字和表分叉时没有任何机制会报警 */
  it('内置条数就是表长,不是写死的数字', () => {
    expect(bypassSummary('').builtinCount).toBe(DIRECT_BYPASS.length)
  })

  it('用户填的按去重后计数', () => {
    expect(bypassSummary('a.com\nb.com\na.com').userCount).toBe(2)
    expect(bypassSummary('').userCount).toBe(0)
    expect(bypassSummary('  \n \n').userCount).toBe(0)
  })

  it('逗号分号混着填也认', () => {
    expect(bypassSummary('a.com, b.com; c.com').userCount).toBe(3)
  })
})
