/**
 * Segmented 滑动指示器的验收探针。
 *
 * 「切换有移动效果」这件事**看静态截图是验不了的** —— 起点和终点两张图,和没有
 * 动画时截出来一模一样。所以这里不截图,而是在切换后按毫秒采样指示器的
 * `transform`,看它有没有经过中间位置。
 *
 * 判据三条,缺一不可:
 *   1. 采样序列里出现过**既不等于起点也不等于终点**的 x —— 真的在滑,不是瞬移;
 *   2. 单调朝终点走 —— 不是先弹回去再过来那种坏缓动;
 *   3. 最终精确落在目标按钮的 offsetLeft/offsetWidth 上 —— 滑对了地方。
 *
 * 复用 screenshot.mjs 的 CDP 驱动。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9336

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

let child = null
let failed = false

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/nextcowork-seg-${Date.now()}`],
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

  // 打开设置 → 通用页(那里有「应用|Agent|任务」三路 Segmented)
  await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.getAttribute('aria-label') === '设置'
      )
      if (!b) throw new Error('找不到设置按钮')
      b.click()
      return true
    })()
  `)
  await sleep(600)

  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('button,li,a')].find(
        (x) => x.textContent.trim() === '通用'
      )
      if (!el) throw new Error('找不到「通用」导航项')
      el.click()
      return true
    })()
  `)
  await sleep(600)

  // 定位那个 radiogroup 和它的指示器
  const setup = await cdp.eval(`
    (() => {
      const g = [...document.querySelectorAll('[role="radiogroup"]')].find(
        (x) => [...x.querySelectorAll('[role="radio"]')].some((b) => b.textContent.trim() === 'Agent')
      )
      if (!g) throw new Error('找不到 应用|Agent|任务 分段控件')
      window.__seg = g
      const ind = g.querySelector('[aria-hidden="true"]')
      if (!ind) throw new Error('没有渲染出指示器元素 —— 滑动效果没生效')
      window.__ind = ind
      const btns = [...g.querySelectorAll('[role="radio"]')]
      return {
        labels: btns.map((b) => b.textContent.trim()),
        checked: btns.findIndex((b) => b.getAttribute('aria-checked') === 'true'),
        geo: btns.map((b) => ({ left: b.offsetLeft, width: b.offsetWidth })),
        transition: getComputedStyle(ind).transitionProperty,
        duration: getComputedStyle(ind).transitionDuration
      }
    })()
  `)
  console.log('分段项:', setup.labels.join(' | '))
  console.log('当前选中:', setup.labels[setup.checked])
  console.log('指示器过渡:', setup.transition, setup.duration)

  const readX = `
    (() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(window.__ind).transform)
      return { x: Math.round(m.m41 * 100) / 100, w: Math.round(window.__ind.getBoundingClientRect().width * 100) / 100 }
    })()
  `
  const start = await cdp.eval(readX)
  console.log(`\n起点 x=${start.x} w=${start.w}`)

  // 点「任务」(跨两格,位移最大,最容易看出有没有中间态),然后密集采样
  const samples = await cdp.eval(`
    (async () => {
      const btns = [...window.__seg.querySelectorAll('[role="radio"]')]
      const target = btns.find((b) => b.textContent.trim() === '任务')
      const out = []
      const read = () => {
        const m = new DOMMatrixReadOnly(getComputedStyle(window.__ind).transform)
        return Math.round(m.m41 * 100) / 100
      }
      target.click()
      const t0 = performance.now()
      // 采到 400ms,覆盖 200ms 的过渡 + 余量
      while (performance.now() - t0 < 400) {
        await new Promise((r) => requestAnimationFrame(r))
        out.push({ t: Math.round(performance.now() - t0), x: read() })
      }
      return out
    })()
  `)

  const end = await cdp.eval(readX)
  const want = await cdp.eval(`
    (() => {
      const b = [...window.__seg.querySelectorAll('[role="radio"]')].find(
        (x) => x.textContent.trim() === '任务'
      )
      return { left: b.offsetLeft, width: b.offsetWidth, checked: b.getAttribute('aria-checked') }
    })()
  `)

  const xs = samples.map((s) => s.x)
  const mids = xs.filter((x) => x !== start.x && x !== end.x)
  console.log(`终点 x=${end.x} w=${end.w}`)
  console.log(`目标按钮 offsetLeft=${want.left} offsetWidth=${want.width} aria-checked=${want.checked}`)
  console.log(`\n采样 ${samples.length} 帧,中间位置 ${mids.length} 帧`)
  console.log('轨迹:', samples.filter((_, i) => i % 3 === 0).map((s) => `${s.t}ms:${s.x}`).join('  '))

  // ── 补测:宽度不等的两项之间切换 ──
  // 上面「应用」→「任务」两个标签都是两个中文字,宽度相同,`width` 过渡等于没测。
  // 「Agent」比它们宽,切到它才能验证指示器会不会跟着变宽 —— 中文/英文标签混排
  // 导致的宽度不一,正是不能用 `1/N` 百分比推位置的原因。
  const wide = await cdp.eval(`
    (async () => {
      const btns = [...window.__seg.querySelectorAll('[role="radio"]')]
      const target = btns.find((b) => b.textContent.trim() === 'Agent')
      const before = window.__ind.getBoundingClientRect().width
      const out = []
      target.click()
      const t0 = performance.now()
      while (performance.now() - t0 < 400) {
        await new Promise((r) => requestAnimationFrame(r))
        out.push(Math.round(window.__ind.getBoundingClientRect().width * 100) / 100)
      }
      return {
        before: Math.round(before * 100) / 100,
        after: out[out.length - 1],
        want: target.offsetWidth,
        mids: out.filter((w) => Math.abs(w - before) > 0.5 && Math.abs(w - out[out.length - 1]) > 0.5).length
      }
    })()
  `)
  console.log(`\n宽度过渡:${wide.before} → ${wide.after}(目标 ${wide.want},中间态 ${wide.mids} 帧)`)

  const checks = []
  checks.push(['指示器元素存在', true])
  checks.push(['宽度确实不同(这项才有意义)', Math.abs(wide.want - wide.before) > 1])
  checks.push(['宽度平滑过渡而非跳变', wide.mids >= 3])
  checks.push(['宽度终值对齐目标按钮', Math.abs(wide.after - wide.want) < 1])
  checks.push(['经过中间位置(真的在滑,不是瞬移)', mids.length >= 3])
  const forward = end.x > start.x
  const monotonic = xs.every((x, i) => i === 0 || (forward ? x >= xs[i - 1] - 0.5 : x <= xs[i - 1] + 0.5))
  checks.push(['单调朝终点推进(无回弹)', monotonic])
  checks.push(['终点对齐目标按钮 left', Math.abs(end.x - want.left) < 1])
  checks.push(['终点对齐目标按钮 width', Math.abs(end.w - want.width) < 1])
  checks.push(['aria-checked 跟着切', want.checked === 'true'])

  console.log()
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`)
    if (!ok) failed = true
  }
} catch (err) {
  console.error('❌ 探针失败:', err.message)
  failed = true
} finally {
  child?.kill()
  await sleep(300)
  process.exit(failed ? 1 : 0)
}
