/**
 * 草稿的 DOM 表示 —— **纯文本 ⇄ 可编辑 DOM** 的双向映射。
 *
 * ★ 权威始终是那段**纯文本**(`文本1 [名字](路径) 文本2`),DOM 只是它的一种画法。
 * 反过来(以 DOM 为权威、发送时再序列化)的话,浏览器每一次自作主张的
 * `<div>`/`<span style>` 都会变成模型看见的内容。
 *
 * ★ 为什么非得 contentEditable:`<textarea>` 里**画不出组件** —— 它的内容是
 * 一段没有结构的字符串,能做的极限是在背后垫一层背景色。要把
 * `[README.md](README.md)` 折叠成一枚只显示文件名的 tag,承载它的必须是元素。
 *
 * 代价是 textarea 白送的那些行为要自己补:光标偏移、换行、粘贴、拖入。
 * 这个文件就是那份补齐,`MentionInput.tsx` 只管把它接到 React 上。
 */
import { parseMentions } from '../../../../shared/domain/file-mention'

/** chip 的标记属性。`data-raw` 是它在纯文本里的原样 —— 读回时用的就是它。 */
const CHIP = 'data-mention'

/** chip 的外观。★ 与转录气泡里的那枚共用,两处分开写迟早长歪。 */
export const MENTION_CHIP_CLASS =
  'inline-flex max-w-full items-baseline gap-1 rounded-[5px] bg-tint-hover px-1.5 align-baseline text-[12.5px] text-fg-muted'

/**
 * lucide `file-text` 的路径数据,手抄一份。
 *
 * ★ 这里不能用 `<FileText/>` 组件:chip 是**命令式**建出来的(见 `MentionInput`
 * 里为什么 React 不能接管这棵子树),那一刻没有 React 渲染器可用。
 */
const ICON =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'class="shrink-0 translate-y-[1.5px] text-fg-faint">' +
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
  '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>' +
  '</svg>'

function chipElement(name: string, path: string, raw: string): HTMLElement {
  const el = document.createElement('span')
  el.setAttribute(CHIP, '')
  el.dataset.raw = raw
  el.dataset.name = name
  /*
    ★ `contenteditable=false` 让这枚 chip 成为**原子**:退格一次整枚删掉,
    而不是先掉一个 `)` 再掉一个 `n` —— 中间那些状态是一串没人想看的半截语法。
  */
  el.setAttribute('contenteditable', 'false')
  el.title = path
  el.className = `${MENTION_CHIP_CLASS} mx-[1px] cursor-default select-none`
  // 常量 HTML,不含任何外部输入
  el.innerHTML = ICON
  const label = document.createElement('span')
  label.className = 'min-w-0 truncate'
  // ★ 文件名走 textContent 而不是拼进 innerHTML —— 文件名是用户数据
  label.textContent = name
  el.append(label)
  return el
}

/** DOM → 纯文本。chip 还原成它的 `data-raw`,也就是当初那段 markdown。 */
export function readDraft(root: HTMLElement): string {
  const out: string[] = []
  collect(root, out, root)
  return out.join('')
}

function collect(parent: Node, out: string[], root: Node): void {
  const kids = parent.childNodes
  for (let i = 0; i < kids.length; i++) {
    const n = kids.item(i)
    if (n === null) continue
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.nodeValue ?? '')
      continue
    }
    if (!(n instanceof HTMLElement)) continue
    if (n.hasAttribute(CHIP)) {
      out.push(n.dataset.raw ?? '')
      continue
    }
    if (n.tagName === 'BR') {
      // ★ 末尾那个 `<br>` 是 `renderDraft` 自己补的(pre-wrap 下尾随换行不占行),
      //   算进去会让草稿每读一次就多一个 `\n`。
      if (parent === root && i === kids.length - 1) continue
      out.push('\n')
      continue
    }
    // 块级元素只可能来自浏览器自作主张(拖入富文本),当成换行,随后会被规范化掉
    if (out.length > 0 && BLOCK.has(n.tagName)) out.push('\n')
    collect(n, out, root)
  }
}

const BLOCK = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE'])

/** 某个 DOM 位置对应纯文本里的第几个字符。 */
function offsetAt(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange()
  r.setStart(root, 0)
  try {
    r.setEnd(node, offset)
  } catch {
    return 0
  }
  const frag = r.cloneContents()
  const out: string[] = []
  collect(frag, out, frag)
  return out.join('').length
}

export interface DraftSelection {
  start: number
  end: number
}

/** 当前选区在纯文本里的区间。焦点不在框里就是 null。 */
export function selectionOf(root: HTMLElement): DraftSelection | null {
  const sel = window.getSelection()
  if (sel === null || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null
  return {
    start: offsetAt(root, r.startContainer, r.startOffset),
    end: offsetAt(root, r.endContainer, r.endOffset)
  }
}

/** 折叠光标的位置。有选区时返回 null —— 那时用户在选文字,不是在写文件名。 */
export function caretOf(root: HTMLElement): number | null {
  const s = selectionOf(root)
  return s !== null && s.start === s.end ? s.start : null
}

/** 把光标放到纯文本的第 `offset` 个字符处。 */
export function placeCaret(root: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (sel === null) return
  const hit = locate(root, offset)
  const r = document.createRange()
  r.setStart(hit.node, hit.offset)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

function locate(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const kids = [...root.childNodes]
  let total = 0
  for (const [i, n] of kids.entries()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.nodeValue ?? '').length
      if (offset <= total + len) return { node: n, offset: offset - total }
      total += len
      continue
    }
    if (!(n instanceof HTMLElement)) continue
    if (n.hasAttribute(CHIP)) {
      const len = (n.dataset.raw ?? '').length
      // ★ chip 内部不是合法落点(整枚 contenteditable=false),
      //   落在它中间的偏移一律推到它后面 —— 否则光标会凭空消失。
      if (offset <= total) return { node: root, offset: i }
      if (offset < total + len) return { node: root, offset: i + 1 }
      total += len
      continue
    }
    if (n.tagName === 'BR') {
      if (offset <= total) return { node: root, offset: i }
      total += 1
    }
  }
  return { node: root, offset: kids.length }
}

/** 纯文本 → DOM。**整棵重画**,所以调用方必须自己把光标放回去。 */
export function renderDraft(root: HTMLElement, text: string): void {
  const kids: Node[] = []
  for (const seg of parseMentions(text)) {
    kids.push(
      seg.kind === 'text'
        ? document.createTextNode(seg.raw)
        : chipElement(seg.name, seg.path, seg.raw)
    )
  }
  const last = kids.at(-1)
  if (last === undefined) {
    // 空草稿:得有个 `<br>` 撑住行高,否则输入框会塌成一条线
    kids.push(document.createElement('br'))
  } else {
    // ★ 末尾是 chip 的话后面必须留个文本节点,不然光标没地方落 —— 表现是
    //   插完引用后再也打不了字。
    if (last.nodeType !== Node.TEXT_NODE) kids.push(document.createTextNode(''))
    if (text.endsWith('\n')) kids.push(document.createElement('br'))
  }
  root.replaceChildren(...kids)
}

/**
 * DOM 画的是不是已经不等于 `text` 该有的样子。
 *
 * 会脏的几种:用户刚把 `[a](b)` 的最后一个 `)` 打出来(该长出 chip)、删掉了半边
 * (该化回文字)、浏览器塞进了我们没画过的元素(拖入富文本),
 * 以及末尾那个 `<br>` 该在却不在 / 不该在却还在。
 *
 * 只在脏的时候重画 —— 重画要动光标,能不动就不动。
 */
export function domDirty(root: HTMLElement, text: string): boolean {
  const want = parseMentions(text).flatMap((s) => (s.kind === 'mention' ? [s] : []))
  const have: HTMLElement[] = []
  let brs = 0
  for (const n of root.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) continue
    if (!(n instanceof HTMLElement)) return true
    if (n.hasAttribute(CHIP)) {
      have.push(n)
      continue
    }
    if (n.tagName !== 'BR') return true
    brs++
  }

  /*
    ★ 末尾的 `<br>` 只在两种时候该存在:草稿是空的(撑住行高),或者它以 `\n`
    结尾(pre-wrap 下尾随换行不占行)。别的时候留着它就是一行幽灵空行 ——
    空草稿里打第一个字的瞬间正好是这种情况,而那是最容易撞上的一步。
  */
  const last = root.lastChild
  const trailingBr = last instanceof HTMLElement && last.tagName === 'BR'
  if (brs !== (trailingBr ? 1 : 0)) return true
  if (trailingBr !== (text === '' || text.endsWith('\n'))) return true

  if (have.length !== want.length) return true
  return have.some((el, i) => el.dataset.raw !== want[i]?.raw || el.textContent !== el.dataset.name)
}
