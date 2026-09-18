/**
 * 视图垫片的注入 —— 插件视图「跟随宿主主题」这件事的落点。
 *
 * ## 为什么这段必须由宿主注入
 *
 * 宿主(`renderer/src/shell/PluginViewFrame.tsx`)一直在往视图 iframe
 * postMessage 一条 `ncw:theme`,带着 24 个 color token 和 `appearance`。
 * 但视图与宿主**不同源**,而 `__runtime.js` 那套 API 垫片只经 `__host.html`
 * 的 importmap 加载 —— **只服务于隐藏的插件宿主页面,视图这边一行都够不着**。
 * 于是那条消息长期发出去之后没有任何人接:插件视图在深色主题下照样一片白,
 * 而且不报任何错。
 *
 * ## 这里钉的三件事
 *
 * 1. **注入真的发生了**,而且落在 `<head>` 里 —— 宿主是在 iframe 的 `load`
 *    事件里发第一条主题的,晚于全部解析;垫片必须在文档里先出现。
 * 2. **nonce 与响应头是同一个**。分两次生成等于没注入:CSP 照样拦,
 *    症状是「插件视图颜色永远不对」加控制台一句 Refused to execute。
 * 3. **非 HTML 不动**。图片/字体/wasm 仍然流式透传,不为这件事先进内存。
 */
import { describe, expect, it } from 'vitest'
import { injectViewShim } from '../protocol'

function nonceOf(html: string): string | null {
  return /<script nonce="([^"]+)"/.exec(html)?.[1] ?? null
}

describe('插件视图的主题垫片', () => {
  it('★ 注入在 <head> 开头 —— 要抢在插件自己的脚本读 __ncwTheme 之前', () => {
    const out = injectViewShim('<!doctype html><html><head><title>x</title></head><body></body></html>', 'N1')
    expect(out).toContain('<script nonce="N1">')
    // 垫片在 <title> 之前:插件同步读 __ncwTheme 时它必须已经在了
    expect(out.indexOf('<script nonce="N1">')).toBeLessThan(out.indexOf('<title>'))
    expect(out).toContain('__ncwTheme')
    expect(out).toContain("'ncw:theme'")
  })

  it('token 写成 --ncw-* —— 那是给插件作者的公开名字,不是宿主内部的 --color-*', () => {
    const out = injectViewShim('<html><head></head></html>', 'N')
    expect(out).toContain("'--ncw-'")
    expect(out).not.toContain('--color-')
  })

  it('★ 只认同源的消息 —— 视图是能被插件导航走的', () => {
    const out = injectViewShim('<html><head></head></html>', 'N')
    expect(out).toContain('event.origin !== location.origin')
  })

  it('没有 <head> 的畸形文档也要注入,不能静默跳过', () => {
    // 静默跳过的后果:这个插件的视图永远不跟随主题,而且一个字都不报
    expect(injectViewShim('<html><body>hi</body></html>', 'N')).toContain('<script nonce="N">')
    expect(injectViewShim('<p>片段</p>', 'N')).toContain('<script nonce="N">')
  })

  it('原正文一字不改 —— 垫片是加进去的,不是替换掉什么', () => {
    const body = '<html><head></head><body><div id="root">保留我</div></body></html>'
    const out = injectViewShim(body, 'N')
    expect(out).toContain('<div id="root">保留我</div>')
    expect(nonceOf(out)).toBe('N')
  })
})
