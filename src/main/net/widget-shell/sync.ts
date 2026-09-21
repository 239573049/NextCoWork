/**
 * 半截 HTML → 已有 DOM 的**增量同步**。widget 边生成边渲染的全部难点都在这里。
 *
 * ## 需求
 *
 * 模型是按 token 吐 `widget_code` 的,而我们每收到一段就想让用户看见它长出来。
 * 这一步不能靠 `root.innerHTML = html`:
 *
 * 1. **整棵子树被销毁重建** → 每一帧全部重排,屏幕上是持续的白闪,滚动位置也丢;
 * 2. 已经画好的元素无法保留任何状态(焦点、输入框里的字、动画进度)。
 *
 * 所以这里做的是「按位置对齐两棵树,只 patch 差异」,和 morphdom 的做法同类;
 * 自己写而不是 vendor 一个库,是因为需要的只是它 5% 的能力(只看子节点、
 * 不处理 keyed 移动、不做 focus 保留),而这一段是本功能**唯一需要被单测穷尽**
 * 的逻辑(`__tests__/widget-sync.test.ts`),用第三方库反而没法测到我们的用法。
 *
 * ## 为什么不能"只往后追加新节点"
 *
 * 浏览器解析**不完整**的标签时会自动闭合它:
 *
 * ```
 * 第 1 帧: <div class="cards">            → <div class="cards"></div>
 * 第 2 帧: <div class="cards"><div class="c">1</div>
 *          → <div class="cards"><div class="c">1</div></div>
 * ```
 *
 * 第 1 帧的第二个 `</div>` 是浏览器替我们补的。于是「新内容在末尾」这个直觉
 * 不成立 —— 第 2 帧多出来的那个 `.c` 是**第一个 div 的子节点**,不是兄弟节点。
 * 按位置递归对齐两棵树才同时覆盖这两种情形。
 *
 * ## 纯函数边界
 *
 * 这个模块只碰 DOM,不碰 postMessage、不碰 CSP、不碰计时器 ——
 * 那些在 `runtime.ts` 里。于是它在 jsdom 下可以整段单测。
 *
 * ## 脚本:两半必须一起看
 *
 * `syncInto` **不把 `<script>` 放进树**,`runScripts` 从源 HTML 重新解析出脚本、
 * 逐个 `createElement` 搬进树里执行。这两半是一件事:
 *
 * - "插入一段 HTML 字符串"**不会**执行里面的脚本(解析器给 fragment 解析出的
 *   script 标了"已经开始");
 * - "把解析出来的 script 节点克隆进活文档"**会**执行它(模板内容里的那些
 *   没被标过)。
 *
 * 两条方向相反的规矩凑在一起,谁少了谁都会坏,而坏法都不报错 —— 详见
 * `syncChildren` 与 `runScripts` 里各自的说明。
 */

/**
 * 惰性同步期间**唯一允许执行的脚本**是经 `runScripts` 搬进来的那些,
 * 所以这里要先能认出"这是不是 script"。见 `syncChildren` 里那段说明。
 */
function isScript(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'SCRIPT'
}

/** 新插入的节点打这个类名,由外壳的 CSS 做一次淡入(见 `widget-protocol.ts` 的样式表)。 */
const ENTER_CLASS = 'ncw-widget-enter'

/** 两个节点"形状相同"才能复用左边那个,否则只能整体换掉。 */
function sameShape(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (a.nodeType === Node.ELEMENT_NODE) {
    // tagName 两侧都来自同一个 HTML 解析器,大小写规则因此是一致的
    // (HTML 元素大写、SVG 内部元素保留原样),直接比字符串就是对的。
    return (a as Element).tagName === (b as Element).tagName
  }
  return true
}

/**
 * 属性同步。**增、改、删三件事都要做** —— 只覆盖新出现的属性会留下一批
 * "上一帧有、这一帧没有"的陈旧属性:模型把 `style="width:80%"` 改成 `width:40%`
 * 时这不是问题,但它把一整个 `class` 去掉时,用户会看到两套样式叠在一起。
 */
function syncAttributes(current: Element, next: Element): void {
  for (const attr of Array.from(current.attributes)) {
    if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name)
  }
  for (const attr of Array.from(next.attributes)) {
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value)
  }
}

/**
 * 同步**已经配好对**的两个节点(形状相同),返回这一趟新插入了几个节点。
 *
 * 文本节点走 nodeValue;元素节点先属性后递归。
 *
 * ★ 属性同步会**抹掉外壳自己贴的淡入类名**(新内容的 `class="a"` 里当然没有
 * `ncw-widget-enter`),所以同步完要把它补回去。不补的话,一个节点的淡入动画
 * 会在下一帧(约 120ms 后,那时动画才走了四成)被硬生生掐断 ——
 * 表现是新内容"啪"地跳出来,而不是淡进来,而这一点在生成快的时候完全看不出来。
 */
function syncNode(current: Node, next: Node): number {
  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue
    return 0
  }
  if (current instanceof Element && next instanceof Element) {
    const entering = current.classList.contains(ENTER_CLASS)
    syncAttributes(current, next)
    if (entering) current.classList.add(ENTER_CLASS)
    return syncChildren(current, next)
  }
  return 0
}

/** 把一个节点标成"新来的",让它淡入一次。只标顶层新节点:它的子孙一起进来。 */
function markEntering(node: Node): void {
  if (node instanceof Element) node.classList.add(ENTER_CLASS)
}

/**
 * 把 `target` 的子节点同步进 `parent`,返回新插入的节点数。
 *
 * 对齐规则是**按位置**:第 i 个旧子节点对应第 i 个新子节点。对"前缀稳定"的
 * 增长(流式渲染就是这一种)这是最优的 —— 前面几十个节点一个字节都不用动。
 * 对插入型的变化(模型回头改写前面一段)它会多替换几个节点,但结果仍然正确,
 * 只是多做了一点功。
 */
function syncChildren(parent: Node, target: Node): number {
  /*
    ★ **script 在同步阶段一律不入树**,两边的子节点列表都先把它滤掉。

    这不是优化,是必须的。原来以为"模板里解析出来的 script 是惰性的,克隆出去
    也不会执行"—— **那是错的**:`innerHTML` 不执行脚本,靠的是解析器给
    fragment 解析出来的 script 设了"已经开始"标记(**模板里的那些不设**,
    因为模板内容是文档片段,从来不会被"插入文档"这一步准备好)。于是
    `template.innerHTML` 解析出的 script 一旦被 clone 进活文档,浏览器就会
    **执行它**。

    这个误解会带来两个都不报错的后果:`<script>` 刚流出来就带着半截代码执行一次
    (此时它要的 DOM 还不存在),而之后 textContent 只被改写、不会再执行 ——
    于是**真正写完的那一版永远不会跑**。表现是"图画出来了但不动",
    而控制台只有一行语法错误,指向的是模型"写坏的代码"。

    滤掉之后,脚本的唯一执行入口是 `runScripts`,时机由调用方掌握。
    滤的时候**两边一起滤**,位置对齐才不会因为少了一个 script 而整体错位。
  */
  const next = Array.from(target.childNodes).filter((node) => !isScript(node))
  const have = Array.from(parent.childNodes).filter((node) => !isScript(node))
  let entered = 0

  for (let i = 0; i < next.length; i += 1) {
    const want = next[i]
    if (want === undefined) continue
    const current = have[i]

    if (current === undefined) {
      const node = want.cloneNode(true)
      parent.appendChild(node)
      markEntering(node)
      entered += 1
      continue
    }

    if (sameShape(current, want)) {
      entered += syncNode(current, want)
      continue
    }

    // 形状不同(标签换了 / 文本换成了元素)→ 原地替换。旧节点上的一切都留不下,
    // 这是必然的:同一个位置上前后是两种不同的东西。
    const node = want.cloneNode(true)
    parent.replaceChild(node, current)
    markEntering(node)
    entered += 1
  }

  // 新内容比旧的**短**只有一种成因:模型回头把已经写出来的部分改短了。
  // 多余的直接删掉,否则界面上会留着一段已经被改掉的残影。
  // 从尾部往前删、**跳过 script**:它们由 `runScripts` 追加在最后,
  // 不属于这次内容对齐的范围。
  let excess = have.length - next.length
  let cursor: Node | null = parent.lastChild
  while (excess > 0 && cursor !== null) {
    const previous: Node | null = cursor.previousSibling
    if (!isScript(cursor)) {
      parent.removeChild(cursor)
      excess -= 1
    }
    cursor = previous
  }

  return entered
}

/**
 * 把一段(可能是半截的)HTML 同步进 `root`。
 *
 * @returns 这一趟新插入了几个顶层节点 —— 调用方据此决定要不要重新量高度。
 *
 * ★ 用 `<template>` 解析而不是 `root.innerHTML = html`:template 的内容属于一个
 * **惰性文档**,`<img>` 不会开始下载。换成 innerHTML 的话,流式中途每一帧都会把
 * 已经出现过的图片重新请求一遍。
 *
 * ★ **但 script 那件事上,模板并没有帮我们挡住** —— 克隆进活文档的 script 是
 * 会执行的,所以上面 `syncChildren` 显式把它们滤掉了。别把那一句当成多余的。
 *
 * ★ 表格片段(`<td>` / `<tr>` 直接当根)会被 HTML 解析器丢掉,这是浏览器的
 * 规矩,不是这里的 bug:同样的字符串进 `innerHTML` 也一样丢。规范要求模型
 * 产出一个可独立渲染的片段,所以正常路径上不会碰到。
 */
export function syncInto(root: Element, html: string): number {
  const template = document.createElement('template')
  template.innerHTML = html
  return syncChildren(root, template.content)
}

/**
 * 已经执行过脚本的 root。见 `runScripts` 里那条"只跑一次"的说明。
 *
 * 用 WeakSet 而不是在 DOM 上打标记:标记会出现在 widget 自己的子树会被
 * CSS 选择器扫到的范围里(`[data-*]` 这种写法在规范正文的例子里就有),
 * 而我们没有任何理由往别人家 DOM 上写东西。
 */
const started = new WeakSet<Element>()

/**
 * 执行 widget 带来的 `<script>`,**整段 HTML 作为参数**,不是从树里找。
 *
 * 时机由调用方掌握:只在 `final`(流式结束)那一帧调。见文件头最后一段。
 *
 * ★ 脚本从**源 HTML** 重新解析,而不是从当前的 DOM 里捞:同步阶段 script
 * 压根没进树(见 `syncChildren`),所以树里没有可捞的东西。
 *
 * ★ 逐个 `createElement` + 赋 `textContent` 是**唯一**会让它跑起来的写法:
 * `innerHTML` 解析出来的脚本被解析器标了"已经开始",克隆进文档也不会执行
 * (那正是 `syncInto` 里那条过滤的另一半 —— 两种写法在这里是反的,
 * 别把这段"简化"成插入一段 HTML 字符串)。
 *
 * ★ `nonce` 由外壳从响应头对应的那个值取(每个响应新生成,见 `widget-protocol.ts`)。
 * 不设它,内联脚本会被 CSP 拦下,而控制台那句 "Refused to execute inline
 * script" 很容易被当成"widget 代码写错了"。
 *
 * ★ **同一个 root 只跑一次。** 这一点必须成立:宿主在 `load` 与 `ready` 两次
 * 时机都会把当前状态整份重推,而两次都带着 `final: true`。不幂等的话
 * Chart.js 会被初始化两遍,症状是同一张图叠了两层、第二张盖住第一张。
 */
export function runScripts(root: Element, html: string, nonce: string): void {
  if (started.has(root)) return
  started.add(root)

  const template = document.createElement('template')
  template.innerHTML = html
  for (const source of Array.from(template.content.querySelectorAll('script'))) {
    const fresh = document.createElement('script')
    for (const attr of Array.from(source.attributes)) {
      if (attr.name.toLowerCase() === 'nonce') continue
      fresh.setAttribute(attr.name, attr.value)
    }
    fresh.nonce = nonce
    fresh.textContent = source.textContent
    // 追加到末尾而不是原位:规范要求 script 写在最后(那时它要的 DOM 已经存在),
    // 而同步阶段又没有它的位置 —— 两者合起来,末尾就是最接近原意的地方。
    root.appendChild(fresh)
  }
}

/** 测试与诊断用:root 里现在有几个脚本节点(执行过之后才有)。 */
export function scriptCount(root: Element): number {
  return root.querySelectorAll('script').length
}
