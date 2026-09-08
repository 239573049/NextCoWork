/**
 * 自报家门这件事有两个容易静默失效的点,各钉一条:
 * 1. UA 的**形状**(纯应用标识,不伪装浏览器)—— 改坏了不报错,只是对面看到别的东西;
 * 2. `withUserAgent` **只补不覆盖** —— 覆盖了的话,将来某家要特定客户端标识时会被抢掉。
 *
 * ★ 「哪些请求带、哪些刻意不带」那张表在 `kernel/user-agent.ts` 的文件头,不在这里 ——
 * 它是设计决定,不是能靠单测钉住的东西(webview 和 WebFetch 走的根本不是这条路)。
 */
import { describe, expect, it } from 'vitest'
import { installUserAgent, userAgent } from '../user-agent'
import { withUserAgent } from '../../search/adapters/http'

describe('user-agent', () => {
  it('是纯应用标识,不含任何浏览器伪装段', () => {
    installUserAgent('9.9.9')
    const ua = userAgent()

    expect(ua).toBe(`NextCoWork/9.9.9 (${process.platform}; ${process.arch})`)
    // Electron 默认那串里的东西一个都不该留下
    expect(ua).not.toMatch(/Mozilla|AppleWebKit|Chrome|Electron|Safari/)
  })

  it('withUserAgent 给没写 UA 的请求补上', async () => {
    installUserAgent('9.9.9')
    let seen: string | null = null
    const fetch = withUserAgent(async (_input, init) => {
      seen = new Headers(init?.headers).get('user-agent')
      return new Response('{}')
    })

    await fetch('https://api.example.com/search', { headers: { accept: 'application/json' } })
    expect(seen).toBe(`NextCoWork/9.9.9 (${process.platform}; ${process.arch})`)
  })

  it('withUserAgent 不覆盖适配器自己写的 UA', async () => {
    installUserAgent('9.9.9')
    let seen: string | null = null
    const fetch = withUserAgent(async (_input, init) => {
      seen = new Headers(init?.headers).get('user-agent')
      return new Response('{}')
    })

    await fetch('https://api.example.com/search', { headers: { 'user-agent': 'their-sdk/1.0' } })
    expect(seen).toBe('their-sdk/1.0')
  })

  it('原有的头一个都不丢', async () => {
    const seen: Headers[] = []
    const fetch = withUserAgent(async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return new Response('{}')
    })

    await fetch('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' }
    })
    expect(seen[0]?.get('authorization')).toBe('Bearer k')
    expect(seen[0]?.get('content-type')).toBe('application/json')
  })
})
