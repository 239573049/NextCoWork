// @vitest-environment jsdom
/**
 * 草稿 DOM 层的两条不变量。
 *
 * ★ **恒等**:`readDraft(renderDraft(t)) === t`。这条一破,用户看着一句话、
 * 模型收到另一句话 —— 而且没有任何地方会报错。
 *
 * ★ **光标可往返**:`placeCaret(i)` 之后 `caretOf()` 还是 `i`。这条一破,
 * 表现是打着打着字跳到别处去,几乎无法从现象反推到原因。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { caretOf, domDirty, placeCaret, readDraft, renderDraft } from '../rich-draft'

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

const CASES = [
  '',
  'hello',
  '看下这个文件',
  '[README.md](README.md)',
  '看下 [a.ts](src/a.ts) 这个',
  '[a](a)[b](b)',
  '开头就是 [a.ts](src/a.ts)',
  '[a.ts](src/a.ts) 结尾就是',
  'a\n',
  'a\n\nb',
  '多行\n[a.ts](src/a.ts)\n结束',
  // ★ 网址不是文件引用,必须原样留在文本里
  '见 [文档](https://example.com) 那页',
  // ★ Windows 盘符是路径(scheme 至少两个字符才算网址)
  '[a.ts](C:\\src\\a.ts)'
]

describe('renderDraft / readDraft', () => {
  it.each(CASES)('原样往返: %j', (text) => {
    renderDraft(root, text)
    expect(readDraft(root)).toBe(text)
  })

  it('文件引用画成 chip,只显示文件名', () => {
    renderDraft(root, '看下 [README.md](docs/README.md) 好吗')
    const chips = root.querySelectorAll('[data-mention]')
    expect(chips).toHaveLength(1)
    const chip = chips[0] as HTMLElement
    expect(chip.textContent).toBe('README.md')
    // ★ 底下存的仍是那段 markdown —— 读回来靠的就是它
    expect(chip.dataset.raw).toBe('[README.md](docs/README.md)')
    expect(chip.getAttribute('title')).toBe('docs/README.md')
    expect(chip.getAttribute('contenteditable')).toBe('false')
  })

  it('网址不长 chip', () => {
    renderDraft(root, '见 [文档](https://example.com) 那页')
    expect(root.querySelectorAll('[data-mention]')).toHaveLength(0)
  })

  it('末尾是 chip 时后面留着可落光标的文本节点', () => {
    renderDraft(root, '看 [a.ts](src/a.ts)')
    const last = root.lastChild
    expect(last?.nodeType).toBe(Node.TEXT_NODE)
  })

  it('空草稿撑得住一行', () => {
    renderDraft(root, '')
    expect(root.childNodes).toHaveLength(1)
    expect((root.firstChild as HTMLElement).tagName).toBe('BR')
    expect(readDraft(root)).toBe('')
  })

  it('文件名走 textContent —— 不会被当成 HTML', () => {
    renderDraft(root, '[<img onerror=x>](a.ts)')
    expect(root.querySelector('img')).toBeNull()
    expect(readDraft(root)).toBe('[<img onerror=x>](a.ts)')
  })
})

describe('光标往返', () => {
  it.each(['hello', '看下这个', 'a\n\nb'])('纯文本每个位置都能回到原处: %j', (text) => {
    renderDraft(root, text)
    for (let i = 0; i <= text.length; i++) {
      placeCaret(root, i)
      expect(caretOf(root)).toBe(i)
    }
  })

  it('chip 前后的位置精确,内部一律推到它后面', () => {
    const text = 'ab [a.ts](src/a.ts) cd'
    const link = '[a.ts](src/a.ts)'
    renderDraft(root, text)
    for (const i of [0, 1, 2, 3]) {
      placeCaret(root, i)
      expect(caretOf(root)).toBe(i)
    }
    // ★ chip 是 contenteditable=false 的原子块,它中间没有合法落点。
    //   偏移落进去时必须被推到它**后面** —— 留在原地的话光标会凭空消失。
    for (let i = 4; i < 3 + link.length; i++) {
      placeCaret(root, i)
      expect(caretOf(root)).toBe(3 + link.length)
    }
    for (let i = 3 + link.length; i <= text.length; i++) {
      placeCaret(root, i)
      expect(caretOf(root)).toBe(i)
    }
  })
})

describe('domDirty', () => {
  it('刚画完不脏', () => {
    for (const text of CASES) {
      renderDraft(root, text)
      expect(domDirty(root, text)).toBe(false)
    }
  })

  it('普通打字不脏 —— 所以不会重画,光标也就不会跳', () => {
    renderDraft(root, '看 [a.ts](src/a.ts) 好')
    const last = root.lastChild as Text
    last.nodeValue = `${last.nodeValue ?? ''}吗`
    const text = readDraft(root)
    expect(text).toBe('看 [a.ts](src/a.ts) 好吗')
    expect(domDirty(root, text)).toBe(false)
  })

  it('刚补齐的 markdown 该长出 chip', () => {
    renderDraft(root, '看 [a.ts](src/a.ts')
    expect(domDirty(root, '看 [a.ts](src/a.ts)')).toBe(true)
  })

  it('浏览器塞进来的元素算脏,下一轮会被规范化掉', () => {
    renderDraft(root, 'hello')
    root.append(document.createElement('b'))
    expect(domDirty(root, readDraft(root))).toBe(true)
  })

  it('chip 里被打进了字算脏', () => {
    renderDraft(root, '看 [a.ts](src/a.ts) 好')
    const chip = root.querySelector('[data-mention]') as HTMLElement
    chip.append(document.createTextNode('x'))
    expect(domDirty(root, readDraft(root))).toBe(true)
  })
})

describe('末尾的 <br>', () => {
  it('空草稿里打第一个字之后,撑行的 <br> 就该走了', () => {
    renderDraft(root, '')
    // 模拟浏览器把字插在 <br> 前面
    root.insertBefore(document.createTextNode('a'), root.firstChild)
    expect(readDraft(root)).toBe('a')
    // ★ 不判脏的话它会留下来,表现是输入框底下多出一行空行
    expect(domDirty(root, 'a')).toBe(true)
  })

  it('删到只剩一个换行时,该补回 <br> 让那个空行看得见', () => {
    renderDraft(root, 'a\nb')
    ;(root.firstChild as Text).nodeValue = 'a\n'
    expect(readDraft(root)).toBe('a\n')
    expect(domDirty(root, 'a\n')).toBe(true)
    renderDraft(root, 'a\n')
    expect(domDirty(root, 'a\n')).toBe(false)
  })
})
