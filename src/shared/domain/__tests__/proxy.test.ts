/**
 * 代理那几个纯函数。
 *
 * 这一整块的失败模式只有一种,但它很糟:**界面显示「代理已开启」,请求却
 * 走了别的路**。规则串拼错、白名单把目标域名意外命中、半截配置静默退成系统代理 ——
 * 三种成因,同一个观察不到的后果。所以这里逐条钉。
 *
 * `migrateLegacyProxy` 的用例在 `settings.test.ts`(它的调用点在 `mergeSettings`,
 * 和合并语义绑在一起才看得出意义)。
 */
import { describe, expect, it } from 'vitest'
import type { ProxySettings } from '../proxy'
import {
  DEFAULT_PROXY,
  DIRECT_BYPASS,
  composeProxyUrl,
  normalizeBypassList,
  parseProxyEndpoint,
  proxyBypassRules,
  proxyConfigFor
} from '../proxy'

const p = (over: Partial<ProxySettings> = {}): ProxySettings => ({ ...DEFAULT_PROXY, ...over })

/** 一份填好了的手动代理,大多数用例在它上面改一个字段 */
const manual = (over: Partial<ProxySettings> = {}): ProxySettings =>
  p({ enabled: true, mode: 'manual', scheme: 'http', host: '127.0.0.1', port: 7890, ...over })

describe('composeProxyUrl', () => {
  it('三段拼成 url', () => {
    expect(composeProxyUrl({ scheme: 'socks5', host: '127.0.0.1', port: 1080 })).toBe(
      'socks5://127.0.0.1:1080'
    )
  })

  it('端口为 0 时省掉端口', () => {
    expect(composeProxyUrl({ scheme: 'http', host: 'proxy.corp', port: 0 })).toBe(
      'http://proxy.corp'
    )
  })

  /** 没填地址 = 没有代理,给空串让上层决定怎么处理,而不是拼出一个 `http://` */
  it('没填地址给空串', () => {
    expect(composeProxyUrl({ scheme: 'http', host: '', port: 7890 })).toBe('')
    expect(composeProxyUrl({ scheme: 'http', host: '   ', port: 7890 })).toBe('')
  })
})

describe('normalizeBypassList', () => {
  it('换行 / 逗号 / 分号混着填都认', () => {
    expect(normalizeBypassList('a.com\nb.com, c.com; d.com')).toEqual([
      'a.com',
      'b.com',
      'c.com',
      'd.com'
    ])
  })

  it('去空白、丢空行', () => {
    expect(normalizeBypassList('  a.com  \n\n\n  b.com  ')).toEqual(['a.com', 'b.com'])
    expect(normalizeBypassList('')).toEqual([])
    expect(normalizeBypassList('\n,;\n')).toEqual([])
  })

  /** 去重是为了让界面上那句「已添加 N 条」不骗人 */
  it('去重', () => {
    expect(normalizeBypassList('a.com\na.com\nb.com')).toEqual(['a.com', 'b.com'])
  })

  /** ★ 保序,不排序 —— 用户按自己的心智写的,重排会像「它把我写的弄乱了」 */
  it('保持用户写的顺序', () => {
    expect(normalizeBypassList('z.com\na.com\nm.com')).toEqual(['z.com', 'a.com', 'm.com'])
  })
})

describe('proxyBypassRules', () => {
  it('用户填的在前,内置表在后,分号连接', () => {
    const rules = proxyBypassRules(manual({ bypass: 'my.corp\ninternal.dev' })).split(';')
    expect(rules.slice(0, 2)).toEqual(['my.corp', 'internal.dev'])
    expect(rules.slice(2)).toEqual([...DIRECT_BYPASS])
  })

  it('用户没填时就是内置表本身', () => {
    expect(proxyBypassRules(manual()).split(';')).toEqual([...DIRECT_BYPASS])
  })

  /**
   * ★ 回环必须在表里。少了它,应用自己那个 `127.0.0.1:19836` 开放网关、
   * 以及本地起的 MCP http 服务器,都会被塞进代理绕一圈 —— 而多数代理
   * 根本不肯转发到回环地址,表现是「开了代理之后本地功能全坏了」。
   */
  it('内置表覆盖回环与私有网段', () => {
    for (const must of ['localhost', '127.0.0.1', '::1', '<local>', '192.168.0.0/16']) {
      expect(DIRECT_BYPASS).toContain(must)
    }
  })

  /** 界面上那句「已自动添加 N 个直连域名」的 N 从这里来,所以表不能有重复项 */
  it('内置表本身没有重复', () => {
    expect(new Set(DIRECT_BYPASS).size).toBe(DIRECT_BYPASS.length)
  })
})

describe('proxyConfigFor', () => {
  it('关掉 = 直连', () => {
    expect(proxyConfigFor(p({ enabled: false }))).toEqual({ mode: 'direct' })
  })

  /** ★ 关掉时必须给出 `direct` 而不是「什么都不给」—— 见 `applyProxy` 里的说明 */
  it('从手动改成关掉时也是直连,不留下旧规则', () => {
    expect(proxyConfigFor(manual({ enabled: false }))).toEqual({ mode: 'direct' })
  })

  it('跟随系统', () => {
    expect(proxyConfigFor(p({ enabled: true, mode: 'system' }))).toEqual({ mode: 'system' })
  })

  it('手动:一条规则对所有协议生效,并带上白名单', () => {
    const cfg = proxyConfigFor(manual({ bypass: 'my.corp' }))
    expect(cfg.proxyRules).toBe('http://127.0.0.1:7890')
    expect(cfg.proxyBypassRules?.startsWith('my.corp;')).toBe(true)
    expect(cfg.mode).toBeUndefined()
  })

  it('socks5 原样进规则串', () => {
    expect(proxyConfigFor(manual({ scheme: 'socks5', port: 1080 })).proxyRules).toBe(
      'socks5://127.0.0.1:1080'
    )
  })

  /**
   * ★ **「开了但地址没填完」走直连,不退回系统代理。**
   *
   * 退回系统代理更宽容,但那样用户会在「我明明配了自己的代理」的同时
   * 走着另一条线路,而界面上这两种情况长得一模一样。直连至少和「关掉」
   * 是同一个可观察行为。
   */
  it('开了但地址是空的 → 直连,而不是系统代理', () => {
    expect(proxyConfigFor(manual({ host: '' }))).toEqual({ mode: 'direct' })
  })
})

describe('parseProxyEndpoint', () => {
  /** ★ 用户十有八九只会打 `127.0.0.1:7890` —— 那正是各家代理软件显示的样子 */
  it('缺协议时补 http', () => {
    expect(parseProxyEndpoint('127.0.0.1:7890')).toEqual({
      scheme: 'http',
      host: '127.0.0.1',
      port: 7890
    })
  })

  it('带协议时照原样认', () => {
    expect(parseProxyEndpoint('socks5://10.0.0.1:1080')).toEqual({
      scheme: 'socks5',
      host: '10.0.0.1',
      port: 1080
    })
  })

  it('协议大小写不敏感', () => {
    expect(parseProxyEndpoint('SOCKS5://h:1')?.scheme).toBe('socks5')
  })

  it('不填端口就是 0,交给协议默认值', () => {
    expect(parseProxyEndpoint('proxy.corp')).toEqual({ scheme: 'http', host: 'proxy.corp', port: 0 })
  })

  it('认不出的协议直接判不合法', () => {
    expect(parseProxyEndpoint('ftp://h:21')).toBeNull()
    expect(parseProxyEndpoint('ws://h:80')).toBeNull()
  })

  /**
   * ★ 越界端口必须判不合法,**不能静默丢掉**。
   * `127.0.0.1:99999` 会被 `URL` 解析成「主机 127.0.0.1、没有端口」——
   * 于是用户填的 99999 消失了,代理连去了 80 端口,而界面上什么都没提示。
   */
  it('越界端口判不合法,而不是静默变成没有端口', () => {
    expect(parseProxyEndpoint('127.0.0.1:99999')).toBeNull()
    expect(parseProxyEndpoint('127.0.0.1:0')).toBeNull()
  })

  /**
   * ★ 协议默认端口**不能被当成「没写端口」丢掉**。
   *
   * `URL` 会把 `https://…:443` 规范化成 `port === ''`,和「越界端口被吞掉」
   * 长得一模一样。按后者处理的话,443/80 上的企业代理会被判成地址不合法,
   * 而用户填的完全正确 —— 这条用例就是那个 bug 的现场。
   */
  it('协议默认端口照样认', () => {
    expect(parseProxyEndpoint('https://a.b.c:443')).toEqual({
      scheme: 'https',
      host: 'a.b.c',
      port: 443
    })
    expect(parseProxyEndpoint('http://proxy.corp:80')?.port).toBe(80)
  })

  it('空串和纯空白是不合法', () => {
    expect(parseProxyEndpoint('')).toBeNull()
    expect(parseProxyEndpoint('   ')).toBeNull()
  })

  it('没有主机名的判不合法', () => {
    expect(parseProxyEndpoint('http://')).toBeNull()
  })

  /** IPv6 字面量的方括号要留着 —— 去掉之后拼回 url 就不合法了 */
  it('IPv6 字面量保留方括号', () => {
    const ep = parseProxyEndpoint('http://[::1]:8080')
    expect(ep?.host).toBe('[::1]')
    expect(ep?.port).toBe(8080)
    expect(composeProxyUrl({ scheme: 'http', host: ep!.host, port: ep!.port })).toBe(
      'http://[::1]:8080'
    )
  })

  /** 解析出来的三段拼回去,应当还是同一个地址 —— 表单「粘贴一行」那条路的往返 */
  it('解析再拼回去是同一个地址', () => {
    for (const raw of ['socks5://127.0.0.1:1080', 'http://proxy.corp:3128', 'https://a.b.c:443']) {
      expect(composeProxyUrl(parseProxyEndpoint(raw)!)).toBe(raw)
    }
  })
})
