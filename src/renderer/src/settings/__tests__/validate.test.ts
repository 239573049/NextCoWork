import { describe, expect, it } from 'vitest'
import { normalizeProxyUrl } from '../validate'

describe('normalizeProxyUrl', () => {
  it('缺协议时补 http:// —— 用户打的就是这个样子', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('已有协议原样保留', () => {
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxyUrl('https://proxy.example.com')).toBe('https://proxy.example.com')
  })

  it('空串是合法的「清空」', () => {
    expect(normalizeProxyUrl('')).toBe('')
    expect(normalizeProxyUrl('   ')).toBe('')
  })

  it('去掉尾部空路径,避免同一个地址两种写法反复写回', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7890/')).toBe('http://127.0.0.1:7890')
    // 幂等:规整过的再规整一次不变
    expect(normalizeProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('不认识的协议不合法', () => {
    expect(normalizeProxyUrl('ftp://127.0.0.1')).toBeNull()
    expect(normalizeProxyUrl('javascript:alert(1)')).toBeNull()
  })

  it('没有主机名不合法', () => {
    expect(normalizeProxyUrl('http://')).toBeNull()
    expect(normalizeProxyUrl('://x')).toBeNull()
  })
})
