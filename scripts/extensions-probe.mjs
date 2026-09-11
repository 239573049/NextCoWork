/**
 * 扩展面板探针 —— 验证「扩展」入口和它那四个 Tab。
 *
 * ⚠️ **这个脚本还没有端到端跑通过一次**。写完当场就被单实例锁挡住了(见下),
 * 所以里面的选择器和断言都只是照着源码写的,没有被真实页面证伪过。
 * 第一次跑很可能要调选择器 —— 别把它的失败直接当成被测代码的问题。
 *
 * ⚠️ **跑之前必须关掉 `/Applications/NextCoWork.app`**。`src/main/index.ts` 里
 * `app.requestSingleInstanceLock()`(第 32 行)排在 `app.setPath('userData', …)`
 * (第 69 行)**前面**,锁按 userData 路径算,于是未打包的开发实例和安装版共用
 * 同一把锁。拿不到锁的表现极具迷惑性:Electron 照常打印 `DevTools listening`,
 * 但 CDP 的 `/json` 永远是空的(窗口压根没建),进程静默退出且 exit code 是 0。
 *
 * CDP 驱动那套是从 `screenshot.mjs` 抄下来的(同一个理由:Electron 没实现 CDP 的
 * Browser 域,真窗口尺寸改不了,只能覆盖视口再靠 `captureBeyondViewport` 重绘)。
 *
 * ★ 跑在 `mkdtemp` 出来的**临时工作目录**里:主进程那句 setPath 会把命令行上的
 * `--user-data-dir` 整个忽略掉 —— 所以隔离靠的是 `cwd`,不是那个参数。
 * 不这么做会直接写进开发者自己的库。
 *
 * 跑法:`npm run build && node scripts/extensions-probe.mjs`
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9336
const OUT = '/tmp/nextcowork-extensions'
const VIEWPORT = { width: 1264, height: 900 }

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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`页面里抛了:${r.exceptionDetails.exception?.description ?? '?'}`)
    return r.result.value
  }

  async shoot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
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

/** 按可见文字点一个按钮。找不到就抛 —— 静默不点会让后面的断言错得莫名其妙。 */
const clickButton = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === ${JSON.stringify(text)})
  if (!b) throw new Error('找不到按钮:' + ${JSON.stringify(text)})
  b.click()
  return true
})()`

let child = null
let failed = false
let testProject = null
const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

try {
  await mkdir(OUT, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const projectRoot = process.cwd()
  testProject = await mkdtemp(join(tmpdir(), 'nextcowork-ext-'))

  child = spawn(electron, [projectRoot, `--remote-debugging-port=${PORT}`], {
    cwd: testProject,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (b) => {
    const s = String(b)
    if (/error|Error/.test(s)) process.stderr.write(`[main] ${s}`)
  })

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
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await sleep(500)

  // 首屏可能停在登录页 —— 走「免登录使用」进主界面。
  const needsAuth = await cdp.eval(
    `[...document.querySelectorAll('button')].some((b) => b.textContent?.includes('免登录使用'))`
  )
  if (needsAuth) {
    await cdp.eval(clickButton('免登录使用'))
    await sleep(1500)
  }

  await until('侧边栏出现', () =>
    cdp.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '扩展')`)
  )
  check('侧边栏有「扩展」入口', true)
  await cdp.shoot('00-sidebar')

  await cdp.eval(clickButton('扩展'))
  await sleep(700)

  const header = await cdp.eval(`document.querySelector('h1')?.textContent?.trim() ?? null`)
  check('点开后标题是「扩展」', header === '扩展', `实际:${header}`)

  // 四个 Tab 是 Segmented(role=radio)。逐个点过去,各截一张。
  const tabs = ['技能', '命令', '子代理', '钩子']
  const labels = await cdp.eval(
    `[...document.querySelectorAll('[role="radio"]')].map((r) => r.textContent?.trim())`
  )
  check('四个 Tab 都在', tabs.every((x) => labels.includes(x)), `实际:${JSON.stringify(labels)}`)

  // header 只能有一条 —— chromeless 没生效的话 Skills 会再画一条。
  const headerCount = await cdp.eval(`document.querySelectorAll('header').length`)
  check('Skills Tab 只有一条 header', headerCount === 1, `实际 ${headerCount} 条`)
  await cdp.shoot('01-skills')

  for (const [i, name] of tabs.entries()) {
    if (i === 0) continue
    await cdp.eval(`(() => {
      const r = [...document.querySelectorAll('[role="radio"]')].find((x) => x.textContent?.trim() === ${JSON.stringify(name)})
      if (!r) throw new Error('找不到 Tab:' + ${JSON.stringify(name)})
      r.click()
      return true
    })()`)
    await sleep(400)
    const body = await cdp.eval(`document.body.innerText`)
    check(`切到「${name}」有内容`, body.includes(name), '')
    await cdp.shoot(`0${String(i + 1)}-${['skills', 'commands', 'agents', 'hooks'][i]}`)
  }

  // 回到技能 Tab，确认 Skills 的操作按钮还在（chromeless 只该去掉返回键和标题）。
  await cdp.eval(`(() => {
    const r = [...document.querySelectorAll('[role="radio"]')].find((x) => x.textContent?.trim() === '技能')
    r.click(); return true
  })()`)
  await sleep(500)
  const skillButtons = await cdp.eval(
    `[...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean)`
  )
  check('Skills 的操作按钮仍在', skillButtons.some((b) => b.includes('刷新')), `按钮:${JSON.stringify(skillButtons.slice(0, 12))}`)

  console.log(`\n${failed ? '有断言失败' : '全部通过'} — 图在 ${OUT}/`)
} catch (error) {
  failed = true
  console.error(`探针挂了:${error.message}`)
} finally {
  child?.kill()
  if (testProject) await rm(testProject, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
