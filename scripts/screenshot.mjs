/**
 * 给界面评审用的截图器 —— 把打包后的应用跑起来,在几个状态上各截一张。
 *
 * 这个工程的验收标准是「像不像 `docs/images/` 里那 29 张」,而那种比较**必须看图**。
 * 描述「侧边栏 297px、面板间距 8px」谁也判断不了对不对,两张图并排放就一眼看得见。
 *
 * 复用 `e2e-probe.mjs` 那套 CDP 驱动(见该文件顶部的说明),只多做两件事:
 *   - 把**真窗口**调成 1264×1141 —— 参考截图就是这个尺寸,不对齐尺寸的并排比较
 *     是没有意义的。注意**不能用 `Emulation.setDeviceMetricsOverride`**:视口一旦
 *     大于真窗口,`captureScreenshot` 会把窗口外那块填成上一帧的残留,截出来是
 *     一张自己叠自己的图,而它看起来很像「布局重复渲染」这种 UI bug。
 *   - `Page.captureScreenshot`
 *
 * 跑法:`npm run build && node scripts/screenshot.mjs`,图落在 /tmp/nextcowork-shots/
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9334
const OUT = '/tmp/nextcowork-shots'
/** 参考截图的尺寸。并排比较的前提是同一个视口。 */
const VIEWPORT = { width: 1264, height: 1141 }

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

  async shoot(name) {
    // `captureBeyondViewport` 是这里的关键:视口被 override 成比真窗口大之后,
    // 默认的截图只画得出真窗口那一块,剩下的填上一帧的残留 ——
    // 截出来是一张自己叠自己的图,而它看起来非常像「布局重复渲染」的 UI bug。
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    })
    const path = `${OUT}/${name}.png`
    await writeFile(path, Buffer.from(data, 'base64'))
    console.log(`📸 ${path}`)
    return path
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
  await mkdir(OUT, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/nextcowork-shot-${Date.now()}`],
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

  // Electron 没有实现 CDP 的 Browser 域(`Browser.getWindowForTarget wasn't found`),
  // 真窗口的尺寸从这里改不了 —— 只能覆盖视口,再靠 `captureBeyondViewport` 让它
  // 真的重绘那么大一块(见 `shoot`)。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(400)
  const actual = await cdp.eval('({ w: innerWidth, h: innerHeight })')
  if (actual.w !== VIEWPORT.width || actual.h !== VIEWPORT.height) {
    throw new Error(`视口没调成 ${VIEWPORT.width}×${VIEWPORT.height},实际 ${actual.w}×${actual.h}`)
  }
  console.log(`视口 ${actual.w}×${actual.h}`)

  await until('对话输入框', () =>
    cdp.eval(`document.querySelector('[data-testid="composer-input"]') !== null`)
  )
  await sleep(400) // 让字体和过渡落定,否则截到半渲染的一帧
  await cdp.shoot('01-empty')

  // 打一段字但不发送 —— 这一张是给「输入区」看的:模型 pill、权限档位、发送按钮
  await cdp.eval(`
    (() => {
      const el = document.querySelector('[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, '看一下这个工程的结构')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(200)
  await cdp.shoot('02-typed')

  await cdp.eval(`document.querySelector('[data-testid="composer-send"]').click()`)

  // 生成中的那一帧 —— 状态行、思考块、工具卡片都只在这个窗口里出现
  await until('流式开始', () =>
    cdp.eval(`document.querySelector('[data-testid="chat-status"]')?.dataset.status === 'running'`)
  )
  await sleep(700)
  await cdp.shoot('03-streaming')

  await until('run 收尾', () =>
    cdp.eval(`
      (() => {
        const s = document.querySelector('[data-testid="chat-status"]')?.dataset.status
        return s !== undefined && s !== 'running'
      })()
    `)
  )
  await sleep(400)
  await cdp.shoot('04-done')

  // 侧边栏收起 —— 红绿灯要落到外层 Tab 条上,这是最容易做错的一处布局
  await cdp.eval(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === '收起侧边栏'
      )
      if (!btn) throw new Error('找不到收起侧边栏按钮')
      btn.click()
      return true
    })()
  `)
  await sleep(400)
  await cdp.shoot('05-collapsed')

  console.log(`\n✅ 截完了,共 5 张,在 ${OUT}/`)
} catch (err) {
  failed = true
  console.error(`\n❌ 截图失败:${err.message}`)
} finally {
  child?.kill('SIGTERM')
  await sleep(500)
  if (child !== null && child.exitCode === null) child.kill('SIGKILL')
}

process.exit(failed ? 1 : 0)
