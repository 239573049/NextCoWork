/**
 * 三家结果页解析器的用例 —— **纯函数、零网络**。
 *
 * 钉住的是这一类失败:引擎改版之后解析器悄悄变成零结果。零结果不会报错,
 * 在界面上表现为「搜索用不了了」,而日志里什么也没有。所以这里喂的是
 * 各家结果页的**结构缩样**(类名和标签层次照实,正文换成占位),
 * 断言取到了标题、真实地址和摘要。
 *
 * 样本不是完整页面:完整页面几百 KB,而且里面绝大部分与解析无关 ——
 * 留下的是解析器真正依赖的那几层结构,改坏哪一层这里就红哪一条。
 */
import { describe, expect, it } from 'vitest'
import { anchorsIn, looksBlocked, normalizeHref, parseSerp, splitBlocks } from '../serp'

/*
 * ★ 第一条里那个 `class="tptt"` 的链接是照实抄的:真实的 `b_algo` 块里,
 * **排在标题前面**还有一个 href 相同、内容是面包屑的链接。
 * 取「块里第一个链接」会得到「example.com https://example.com/a」这种标题 ——
 * 地址是对的,所以既不报错也不零结果,只是每条标题都多一截面包屑。
 */
const BING = `
<ol id="b_results">
  <li class="b_algo">
    <div class="tptt"><a href="https://example.com/a">example.com<span>https://example.com › a</span></a></div>
    <h2><a href="https://example.com/a">标题 A</a></h2>
    <div class="b_caption"><p>A 的摘要<b>关键词</b>后半句</p></div></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9i">标题 B</a></h2>
    <div class="b_caption"><p>B 的摘要</p></div></li>
  <li class="b_pag">下一页</li>
</ol>`

const DDG = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fd&amp;rut=xx">DDG 标题</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fd">DDG 摘要</a>
  </div>
  <div class="result result--ad result--ad--small">
    <a class="result__a" href="https://ad.example.net/x">广告标题</a>
    <a class="result__snippet">买它</a>
  </div>
</div>`

const BAIDU = `
<div id="content_left">
  <div class="result c-container" id="1">
    <h3 class="t"><a href="http://www.baidu.com/link?url=abcdef">百度标题</a></h3>
    <div class="c-abstract">百度摘要<em>高亮</em>剩下的</div>
  </div>
</div>`

describe('parseSerp · Bing', () => {
  it('取出标题、地址和摘要', () => {
    const items = parseSerp('bing', BING)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: '标题 A', url: 'https://example.com/a' })
    expect(items[0]?.snippet).toContain('A 的摘要')
  })

  /** ★ 标题取 `<h2>` 里的那个,而不是块里第一个链接 —— 见样本上面那段注释 */
  it('面包屑链接排在标题前面时,标题仍然是干净的', () => {
    expect(parseSerp('bing', BING)[0]?.title).not.toContain('example.com ›')
  })

  /** ★ `/ck/a?…&u=a1<base64url>` 是 Bing 的跳转壳。解不开的话模型拿到的全是 bing.com 链接 */
  it('把 Bing 的跳转链接还原成真实地址', () => {
    const items = parseSerp('bing', BING)
    expect(items[1]?.url).toBe('https://example.org/b')
  })

  it('分页那类不是结果的块不会混进来', () => {
    expect(parseSerp('bing', BING).some((i) => i.title.includes('下一页'))).toBe(false)
  })
})

describe('parseSerp · DuckDuckGo', () => {
  it('把 uddg 跳转参数解成真实地址,并去掉标题里的标签', () => {
    const items = parseSerp('duckduckgo', DDG)
    expect(items[0]).toMatchObject({ title: 'DDG 标题', url: 'https://example.com/d' })
    expect(items[0]?.snippet).toBe('DDG 摘要')
  })

  /** ★ 广告位和正常结果长得一模一样。不滤掉的话模型会认真引用它 */
  it('丢掉 result--ad 广告位', () => {
    expect(parseSerp('duckduckgo', DDG).some((i) => i.url.includes('ad.example.net'))).toBe(false)
  })
})

describe('parseSerp · 百度', () => {
  it('取 h3 里的标题,摘要去掉高亮标签', () => {
    const items = parseSerp('baidu', BAIDU)
    expect(items[0]?.title).toBe('百度标题')
    // 标签位置留下一个空格 —— `htmlToText` 一贯的行为(它按块级元素断行、行内标签换空格),
    // 这里照实钉住:哪天有人给内联标签改成直接删掉,摘要里的词会粘成一坨
    expect(items[0]?.snippet).toBe('百度摘要 高亮 剩下的')
  })

  /** ★ 跳转链接**原样保留**(见 serp.ts 的注释):解它要多一次请求,交给 WebFetch 更划算 */
  it('保留 baidu.com/link 跳转地址而不是丢掉这条结果', () => {
    expect(parseSerp('baidu', BAIDU)[0]?.url).toContain('baidu.com/link?url=abcdef')
  })
})

describe('parseSerp · 结构变了的时候', () => {
  /** 改版的症状就是这个:页面是 200、内容也正常,但一条都认不出来 */
  it('认不出结构时给空数组而不是抛', () => {
    expect(parseSerp('bing', '<html><body><div class="whatever">换了</div></body></html>')).toEqual(
      []
    )
  })

  it('同一个地址出现两次只留一条', () => {
    const doubled = BING + BING
    const urls = parseSerp('bing', doubled).map((i) => i.url)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('looksBlocked', () => {
  /** 「被挡住」和「解析不出来」要分开报 —— 前者换个网络就好,后者是这里的 bug */
  it('认得出验证码 / 异常流量页', () => {
    expect(looksBlocked('<html><body>请完成安全验证</body></html>')).toBe(true)
    expect(looksBlocked('<html><body>Unusual traffic from your network</body></html>')).toBe(true)
    expect(looksBlocked(BING)).toBe(false)
  })
})

describe('解析工具', () => {
  it('splitBlocks 按起始标记切,块数等于标记数', () => {
    expect(splitBlocks(BING, /<li[^>]+class="[^"]*\bb_algo\b[^"]*"/)).toHaveLength(2)
  })

  it('anchorsIn 解掉 href 里的实体', () => {
    const [first] = anchorsIn('<a href="https://x.test/?a=1&amp;b=2">t</a>')
    expect(first?.href).toBe('https://x.test/?a=1&b=2')
  })

  it('normalizeHref 拒绝相对地址和 javascript:,补全协议相对地址', () => {
    expect(normalizeHref('/relative')).toBeNull()
    expect(normalizeHref('javascript:alert(1)')).toBeNull()
    expect(normalizeHref('//example.com/x')).toBe('https://example.com/x')
  })
})
