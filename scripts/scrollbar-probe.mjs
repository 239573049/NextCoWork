/**
 * 滚动条「无背景」的验收探针。
 *
 * **CSS 里写了 `background: transparent` 不等于渲染出来没底色** —— Chromium 的
 * 滚动条是 UA 内建绘制的,`::-webkit-scrollbar-track` 只要有一条更高优先级的规则
 * 没被覆盖到,或者压根没匹配上(比如以前的 `.scroll-thin` 是 opt-in,漏挂 class 的
 * 容器就走默认皮肤),都会留下一条灰轨道。所以这里不读 computed style,
 * **直接截真实像素**,把轨道那几列和旁边的内容底色逐行比。
 *
 * 判据:
 *   1. 轨道列的像素 == 该行内容区的底色 —— 也就是「看不出这里有条轨道」;
 *   2. thumb 所在行必须**不同于**底色 —— 否则就是滚动条整个消失了,
 *      那是另一种 bug,不是我们要的效果;
 *   3. 深浅两个主题都要过 —— 两套 token 的 tint 方向是相反的;
 *   4. 必须覆盖 Dialog(以前漏挂 `.scroll-thin` 的那个,截图里的 case)。
 *
 * CDP 驱动抄自 screenshot.mjs / segmented-probe.mjs。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9338

class Cdp {
  #ws
  #id = 0
  #waiting = new Map()

  static async attach(wsUrl) {
    const c = new Cdp()
    c.#ws = new WebSocket(wsUrl)
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const w = c.#waiting.get(msg.id)
      if (w === undefined) return
      c.#waiting.delete(msg.id)
      if (msg.error) w.reject(new Error(JSON.stringify(msg.error)))
      else w.resolve(msg.result)
    })
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true })
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }))
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) {
      throw new Error(`页面里抛了:${r.exceptionDetails.exception?.description ?? '?'}`)
    }
    return r.result.value
  }

  async shootRaw() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }
}

async function until(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== null && v !== undefined && v !== false) return v
    if (Date.now() > deadline) throw new Error(`超时等待「${label}」`)
    await sleep(200)
  }
}

/**
 * 在页面里用 canvas 解 PNG 并采样 —— 比在 Node 里引 PNG 解码依赖轻。
 * 传入 CSS 坐标的矩形,返回每行的像素数组。注意 devicePixelRatio:
 * 截图是物理像素,getBoundingClientRect 给的是 CSS 像素,不换算会采到别的地方。
 */
const SAMPLE_FN = `
window.__samplePng = async (b64, rects) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const cv = document.createElement('canvas')
  cv.width = img.width; cv.height = img.height
  const cx = cv.getContext('2d')
  cx.drawImage(img, 0, 0)
  const dpr = img.width / window.innerWidth
  return rects.map((r) => {
    const x = Math.round(r.x * dpr), y = Math.round(r.y * dpr)
    const w = Math.max(1, Math.round(r.w * dpr)), h = Math.max(1, Math.round(r.h * dpr))
    const d = cx.getImageData(x, y, w, h).data
    const px = []
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i+1], d[i+2]])
    return px
  })
}
`

const hex = (p) => '#' + p.map((v) => v.toString(16).padStart(2, '0')).join('')
const same = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

/** 出现次数最多的颜色 —— 用众数而不是均值,均值会把 thumb 和底色混成一个不存在的色 */
function mode(pixels) {
  const m = new Map()
  for (const p of pixels) {
    const k = hex(p)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  let best = null, n = 0
  for (const [k, c] of m) if (c > n) { n = c; best = k }
  return { color: best, ratio: n / pixels.length }
}

let child = null
let failed = false
const results = []

function check(label, ok, detail) {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/nextcowork-sb-${Date.now()}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  const target = await until('渲染进程 CDP target', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      return null
    }
  })

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await until('对话输入框', () =>
    cdp.eval(`document.querySelector('[data-testid="composer-input"]') !== null`)
  )
  await cdp.eval(SAMPLE_FN)

  // ── 造一个必定溢出的滚动容器,直接挂在 body 上。
  //    用真实业务面板做样本有个问题:内容不一定够长,不滚就没有滚动条可测。
  //    这里显式造一个,并且**故意不挂 `.scroll-thin`** —— 测的正是「全局默认」
  //    这条路径,也就是 Dialog 漏挂 class 时走的那条。
  const probeRect = await cdp.eval(`
    (() => {
      document.querySelector('#__sbprobe')?.remove()
      const box = document.createElement('div')
      box.id = '__sbprobe'
      box.style.cssText =
        'position:fixed;left:40px;top:120px;width:240px;height:200px;' +
        'overflow-y:scroll;z-index:99999;background:var(--color-canvas)'
      const inner = document.createElement('div')
      inner.style.cssText = 'height:2000px;background:var(--color-canvas)'
      box.appendChild(inner)
      document.body.appendChild(box)
      const r = box.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height,
               canvas: getComputedStyle(document.documentElement)
                 .getPropertyValue('--color-canvas').trim() }
    })()
  `)
  await sleep(300)

  for (const theme of ['dark', 'light']) {
    // ★ 光设 `data-theme` 是不够的。`theme/apply.ts` 把 22 个 token 写成 `<html>`
    //   的**行内样式**,行内样式压根不参与选择器优先级 —— 它比
    //   `:root[data-theme='light']` 更强。不清掉的话,属性切到 light、颜色还是深色的,
    //   探针会「两个主题都通过」但其实只测了一个。
    await cdp.eval(`
      (() => {
        const r = document.documentElement
        for (const k of [...r.style]) if (k.startsWith('--color-')) r.style.removeProperty(k)
        r.setAttribute('data-theme', ${JSON.stringify(theme)})
        return true
      })()
    `)
    await sleep(400)

    // macOS 默认是 overlay 滚动条(`AppleShowScrollBars=WhenScrolling`):
    // **静止时系统根本不绘制 thumb**,要正在滚才现身,滚完约 1s 淡出。
    // 且必须用 CDP 的 `Input.dispatchMouseEvent` 发**真实**滚轮事件 —— 页面里
    // `new WheelEvent()` 合成的那种只跑 JS 事件流,不驱动合成器去画滚动条,
    // 用它测会稳定假失败。
    await cdp.eval(`document.querySelector('#__sbprobe').scrollTop = 0; true`)
    await sleep(150)
    for (let i = 0; i < 3; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: probeRect.x + probeRect.w / 2,
        y: probeRect.y + probeRect.h / 2,
        deltaX: 0,
        deltaY: 60
      })
      await sleep(30)
    }
    // 不 sleep 太久:thumb 会淡出。这里趁它还亮着立刻截。
    await sleep(60)

    const b64 = (await cdp.shootRaw()).toString('base64')

    // 轨道列 = 容器最右侧那几 px。分两段采样,y 起点跟着 thumb 实际位置走:
    //   thumb 段 —— 滚了 180px / 2000px,thumb 大约在轨道 9% 处,取上部一小段
    //   track 段 —— 容器下半部,thumb 到不了,是纯轨道
    // 内容底色对照列取容器内部靠左的一竖条(同样的 y,排除渐变干扰)。
    const [thumbPx, trackPx, contentPx] = await cdp.eval(`
      window.__samplePng(${JSON.stringify(b64)}, ${JSON.stringify([
        { x: probeRect.x + probeRect.w - 7, y: probeRect.y + 20, w: 6, h: 24 },
        { x: probeRect.x + probeRect.w - 7, y: probeRect.y + 150, w: 6, h: 40 },
        { x: probeRect.x + 20, y: probeRect.y + 150, w: 30, h: 40 }
      ])})
    `)

    const track = mode(trackPx)
    const content = mode(contentPx)

    // 判据 1:轨道 == 内容底色 → 看不出有轨道
    check(
      `[${theme}] 轨道无背景色`,
      same(
        track.color.slice(1).match(/../g).map((h) => parseInt(h, 16)),
        content.color.slice(1).match(/../g).map((h) => parseInt(h, 16))
      ),
      `轨道 ${track.color}(${(track.ratio * 100) | 0}%) vs 内容 ${content.color}`
    )

    // 判据 2:thumb 仍然可见 —— 防止「无背景」做成了「滚动条整个不见了」。
    // ★ 这条**不能用众数**:thumb 实绘只有 4px 宽,采样窗口 6px、还含抗锯齿边,
    //   众数几乎必然是底色,那样测的是「周围有没有底色」而不是「thumb 在不在」。
    //   改问「有没有一批像素明显偏离底色」。阈值 8 是为了跳过抗锯齿的过渡像素。
    const contentRgb = content.color.slice(1).match(/../g).map((h) => parseInt(h, 16))
    const offCount = thumbPx.filter((p) => !same(p, contentRgb, 8)).length
    const farthest = thumbPx.reduce(
      (a, p) => {
        const d = p.reduce((s, v, i) => s + Math.abs(v - contentRgb[i]), 0)
        return d > a.d ? { d, p } : a
      },
      { d: -1, p: null }
    )
    check(
      `[${theme}] thumb 仍可见`,
      offCount >= 8,
      `偏离底色像素 ${offCount}/${thumbPx.length},最远 ${farthest.p ? hex(farthest.p) : '—'} vs 底色 ${content.color}`
    )
  }

  await cdp.eval(`document.documentElement.setAttribute('data-theme','dark'); document.querySelector('#__sbprobe')?.remove(); true`)

  // ── 判据 4:Dialog 的内容区 —— 截图里那条。确认它现在也吃到全局规则。
  const dialogOk = await cdp.eval(`
    (() => {
      const d = document.createElement('div')
      d.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;overflow-y:scroll'
      document.body.appendChild(d)
      const cs = getComputedStyle(d)
      const w = cs.scrollbarWidth, c = cs.scrollbarColor
      d.remove()
      return { w, c }
    })()
  `)
  check(
    '未挂 class 的容器继承全局规则',
    // `scrollbar-color` 的 computed value 里,第二个分量就是 track。
    // Chromium 把 `transparent` 序列化成 `rgba(0, 0, 0, 0)` —— 匹配字面量
    // 'transparent' 会永远失败,要认的是 alpha 为 0。
    dialogOk.w === 'thin' && /rgba\([^)]*,\s*0\)\s*$/.test(dialogOk.c.trim()),
    `scrollbar-width:${dialogOk.w} scrollbar-color:${dialogOk.c}`
  )
} catch (e) {
  console.error('探针失败:', e.message)
  failed = true
} finally {
  child?.kill('SIGKILL')
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
