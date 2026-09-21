/**
 * `syncInto` / `runScripts` 的单测 —— widget「边生成边渲染」的全部难点都在这两个函数。
 *
 * 它跑在 Node 里,所以要自己搭一个 JSDOM 并把 `document` / `Node` / `Element`
 * 三个全局换成 jsdom 的(`sync.ts` 用的是浏览器全局,而 vitest 的
 * environment 是 node —— 见 `vitest.config.ts` 的文件头)。
 *
 * `runScripts: 'dangerously'` 是**故意的**:下面有一条用例要证明"模板里解析出来的
 * script 在被 runScripts 搬过去之前一次都不执行"。jsdom 默认不执行任何脚本,
 * 那样这条用例会永远通过,等于没测。
 */
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scriptCount, runScripts, syncInto } from '../sync'

let dom: JSDOM
let root: Element

function sideEffect(): unknown {
  return (dom.window as unknown as Record<string, unknown>)['__ncwRan']
}

/**
 * `root.childNodes[i]` 的类型是 lib.dom 的 `ChildNode | undefined`,而 jsdom 的
 * 节点类型是它自己的一套 —— `instanceof dom.window.Element` 在 TS 那边窄化不动,
 * 断言里会连 `.classList` 都说不存在。统一从这个口子取,只在这里 cast 一次。
 */
function child(parent: Element, index: number): Element {
  const node = parent.childNodes[index]
  if (node === undefined) throw new Error(`fixture: no child at ${String(index)}`)
  return node as unknown as Element
}

/** 末尾那个节点(script 必须在最后)—— 同上,类型要从 lib.dom 拉回来。 */
function lastChild(parent: Element): Element {
  const node = parent.lastChild
  if (node === null) throw new Error('fixture: no lastChild')
  return node as unknown as Element
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { runScripts: 'dangerously' })
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Node', dom.window.Node)
  vi.stubGlobal('Element', dom.window.Element)
  const element = dom.window.document.getElementById('root')
  if (element === null) throw new Error('fixture #root missing')
  root = element
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncInto · 增量同步', () => {
  /**
   * ★ 这是整个功能的观感来源:已经画好的节点必须**原地留着**。
   * 换成 `innerHTML` 也能得到一样的 DOM 结构,但那一棵是全新造的 ——
   * 于是每一帧全部重排(屏幕持续白闪)、滚动位置丢失、输入框里的字被清掉。
   * 所以这里断言的是**对象身份**,不是结构相等。
   */
  it('追加新节点时,已有的节点原地保留', () => {
    syncInto(root, '<div class="a">1</div>')
    const first = root.childNodes[0]
    syncInto(root, '<div class="a">1</div><div class="b">2</div>')
    expect(root.childNodes.length).toBe(2)
    expect(root.childNodes[0]).toBe(first)
  })

  /**
   * ★ 浏览器会把**不完整**的标签自动闭合,所以"新内容在末尾"这个直觉不成立:
   * `<div class="cards">` 单独一帧解析出来是一个没有子节点的 div,下一帧多出来的
   * 那个 `.c` 是它的**子节点**而不是兄弟节点。按位置递归对齐两棵树才同时覆盖
   * 这两种情形 —— 只做"往后追加兄弟"的实现在这里会把内容摊平。
   */
  it('半截标签被自动闭合后,后续内容挂在同一个父节点下面', () => {
    syncInto(root, '<div class="cards">')
    const cards = child(root, 0)
    expect(cards.childNodes.length).toBe(0)

    syncInto(root, '<div class="cards"><div class="c">1</div>')
    expect(root.childNodes.length).toBe(1)
    expect(root.childNodes[0]).toBe(cards)
    expect(cards.childNodes.length).toBe(1)
  })

  it('文本逐字增长时复用同一个文本节点', () => {
    syncInto(root, '<p>he')
    const paragraph = root.childNodes[0]
    syncInto(root, '<p>hello')
    expect(root.childNodes[0]).toBe(paragraph)
    expect(paragraph?.textContent).toBe('hello')
  })

  it('属性改了要写回,属性没了要删掉', () => {
    syncInto(root, '<div class="a" style="width:80%">x</div>')
    syncInto(root, '<div style="width:40%">x</div>')
    const div = child(root, 0)
    // 注意断言的是**那个类没了**,而不是整个 class 属性为 null ——
    // 外壳自己的淡入类名会留在上面,见下一条
    expect(div.classList.contains('a')).toBe(false)
    expect(div.getAttribute('style')).toBe('width:40%')
  })

  it('内容变短时删掉多余的尾节点', () => {
    syncInto(root, '<i>1</i><i>2</i><i>3</i>')
    syncInto(root, '<i>1</i>')
    expect(root.childNodes.length).toBe(1)
  })

  it('标签换了就整块替换 —— 同一位置上前后是两种东西', () => {
    syncInto(root, '<span>x</span>')
    syncInto(root, '<div>x</div>')
    expect(root.childNodes.length).toBe(1)
    expect(child(root, 0).tagName).toBe('DIV')
  })

  /**
   * 淡入只标给"这一趟新来的"顶层节点:它的子孙跟着一起进来,不需要逐个标。
   *
   * ★ 复用的节点**保留**淡入类名,这是刻意的:属性同步会抹掉它(新内容的
   * `class` 里当然没有它),而下一帧只隔约 120ms —— 那时 300ms 的动画才走了
   * 四成,抹掉等于把淡入掐断成"啪"地跳出来。所以同步完会补回去。
   */
  it('新插入的节点带淡入类名,且复用时不会被抹掉', () => {
    syncInto(root, '<div class="a">1</div>')
    const first = child(root, 0)
    expect(first.classList.contains('ncw-widget-enter')).toBe(true)

    syncInto(root, '<div class="a">1</div><div class="b">2</div>')
    const second = child(root, 1)
    expect(second.classList.contains('ncw-widget-enter')).toBe(true)
    expect(first.classList.contains('ncw-widget-enter')).toBe(true)
    // 而 widget 自己的类名照常被同步覆盖
    expect(second.classList.contains('b')).toBe(true)
  })

  it('完整的表格片段照常同步', () => {
    syncInto(root, '<table><tr><td>1</td></tr></table>')
    expect(root.querySelectorAll('td').length).toBe(1)
  })
})

describe('runScripts · 执行时机', () => {
  /**
   * ★ 这条是 `final` 语义的全部依据。半截代码里的脚本一旦执行,
   * `getElementById('chart')` 会拿到 null;而且它执行完之后 textContent
   * 只会被改写、不会再触发执行 —— 于是**真正写完的那一版永远不会跑**。
   *
   * 断言里那一半"树里根本没有 script"是刻意的:`syncChildren` 过滤 script
   * 与这条用例是一件事的两面,只断"没执行"的话,过滤被删掉也照样通过。
   */
  it('同步阶段脚本根本不进树,更不会执行', () => {
    syncInto(root, '<div id="chart"></div><script>window.__ncwRan = 1</script>')
    expect(sideEffect()).toBeUndefined()
    expect(scriptCount(root)).toBe(0)
  })

  it('runScripts 之后才执行,并且出现在末尾', () => {
    const html = '<div id="chart"></div><script>window.__ncwRan = 1</script>'
    syncInto(root, html)
    runScripts(root, html, 'n1')
    expect(sideEffect()).toBe(1)
    expect(scriptCount(root)).toBe(1)
    // 末尾:那时它要的 DOM 已经存在
    expect(lastChild(root).tagName).toBe('SCRIPT')
  })

  /**
   * ★ 幂等是必须的:宿主在 `load` 与 `ready` 两次时机都会把当前状态整份重推,
   * 两次都带着 `final: true`。不幂等的话 Chart.js 会被初始化两遍,
   * 症状是同一张图叠两层、第二张盖住第一张。
   */
  it('同一个 root 上重复调用不会让脚本跑第二次', () => {
    const html = '<script>window.__ncwRan = (window.__ncwRan || 0) + 1</script>'
    syncInto(root, html)
    runScripts(root, html, 'n1')
    runScripts(root, html, 'n1')
    expect(sideEffect()).toBe(1)
    expect(scriptCount(root)).toBe(1)
  })

  it('多个脚本按原文顺序执行 —— 库必须排在用它的人前面', () => {
    const html = '<script>window.__ncwOrder = ["first"]</script><script>window.__ncwOrder.push("second")</script>'
    syncInto(root, html)
    runScripts(root, html, 'n1')
    expect((dom.window as unknown as Record<string, unknown>)['__ncwOrder']).toEqual(['first', 'second'])
  })

  it('脚本带上 nonce 与原有属性', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js" defer></script>'
    syncInto(root, html)
    runScripts(root, html, 'nonce-abc')
    const script = root.querySelector('script')
    expect(script?.getAttribute('src')).toBe('https://cdn.jsdelivr.net/npm/chart.js')
    expect(script?.getAttribute('defer')).toBe('')
    // jsdom 不实现 nonce 的"读回为空"隐式行为,所以按 IDL 属性断言
    expect((script as unknown as { nonce?: string })?.nonce).toBe('nonce-abc')
  })
})
