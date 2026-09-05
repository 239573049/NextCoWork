/**
 * 端到端冒烟:**真的把应用跑起来,真的点一下「发送」,真的看文字有没有滚出来。**
 *
 * 到这一步为止,整条链路的每一段都有无头测试撑着 —— 但**没有一次是在 Electron 里跑的**。
 * 无头测试用的是 `nodeHost()` + `FakeWebContents`;真跑起来时换成 `electronHost()` +
 * 真 `webContents`、真 preload 白名单、真 contextBridge、真打包产物。
 * 那几层没有任何一个 vitest 覆盖得到,而它们恰恰是「dev 好好的、打包后崩」的常客。
 *
 * 做法是经 CDP 驱动渲染层,而不是靠人去点:
 *   1. 用 `--remote-debugging-port` 起打包后的应用
 *   2. `GET /json` 找到渲染进程的 target
 *   3. WebSocket 上发 `Runtime.evaluate`,在页面里点按钮、读 DOM
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` 必须清掉,否则 Electron 退化成一个无头 node,
 * 窗口不会出现,而 CDP 那一端只会超时 —— 那种失败看起来像「应用崩了」。
 *
 * 跑法:`npm run build && node scripts/e2e-probe.mjs`
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9333
const DEADLINE_MS = 60_000

/** 一个只够用的 CDP 客户端 —— 引一个库不值当,协议本身就是「发一个 id,等同一个 id」 */
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

  /** 在页面里跑一段 JS,把返回值搬回来。`awaitPromise` 让 async 表达式也能用。 */
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

  /** 走 preload 白名单和主进程 handler，返回完整 IpcResult 信封。 */
  invoke(channel, req) {
    return this.eval(
      `window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req ?? null)})`
    )
  }
}

function expectInvokeOk(channel, result) {
  if (result?.ok === true) return result.data
  const detail = result?.error?.message ?? JSON.stringify(result)
  throw new Error(`${channel} 失败:${detail}`)
}

/**
 * 轮询到条件成立,或超时。
 *
 * `bail` 是**快速失败**通道:run 报错时页面上已经写着 `code: message` 了,
 * 干等满 60 秒再报一句「超时」等于把现成的诊断信息扔掉 ——
 * 「no_healthy_provider」和「等不到文字」是两个完全不同的排查方向。
 */
async function until(label, fn, { timeoutMs = DEADLINE_MS, bail = null } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    if (bail !== null) {
      const b = await bail()
      if (b) throw new Error(`「${label}」等不到了 —— 页面已经报错:${b}`)
    }
    last = await fn()
    if (last !== null && last !== undefined && last !== false) return last
    if (Date.now() > deadline) throw new Error(`超时等待「${label}」,最后一次拿到 ${JSON.stringify(last)}`)
    await sleep(250)
  }
}

const log = (s) => console.log(s)
let child = null
let failed = false
let testProject = null

try {
  // ── 起应用 ────────────────────────────────────────────────────────
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  // 数据库固定在 `<cwd>/.next-cowork`，所以真正的隔离边界必须是测试
  // 工作目录。`--user-data-dir` 仍保留，用来在应用重设 userData 之前隔离
  // Electron 的单实例锁与早期 profile 状态。
  const projectRoot = process.cwd()
  testProject = await mkdtemp(join(tmpdir(), 'nextcowork-e2e-project-'))
  const userData = join(testProject, '.electron-user-data')

  child = spawn(
    electron,
    [projectRoot, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: testProject, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const mainOut = []
  child.stdout.on('data', (b) => mainOut.push(String(b)))
  child.stderr.on('data', (b) => mainOut.push(String(b)))
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`⚠️ 主进程提前退出,code=${code}\n${mainOut.join('')}`)
    }
  })

  // ── 找到渲染进程的 CDP target ──────────────────────────────────────
  const target = await until('渲染进程 CDP target', async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await r.json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      return null // 端口还没开,继续等
    }
  })
  log(`✓ 窗口起来了 · ${target.title || target.url}`)

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // ── 1. 握手 + preload 桥 ──────────────────────────────────────────
  await until('contextBridge 注入', () => cdp.eval('typeof window.nextcowork').then((t) => t === 'object'))
  log('✓ contextBridge 到位(sandbox:true 下 preload 单文件打包是通的)')

  // 生产的新安装不再默认种入 demo.invalid。E2E 自己经正式 IPC 建一条隔离的
  // 演示供应商，既保留“真实打包产物完整跑一轮”的覆盖，也不改变用户默认配置。
  const demoProviderId = 'e2e-demo'
  const demoModel = 'demo-model'
  expectInvokeOk(
    'provider:upsert',
    await cdp.invoke('provider:upsert', {
      id: demoProviderId,
      name: 'E2E demo provider',
      protocol: 'anthropic',
      baseUrl: 'https://demo.invalid',
      credentialRef: 'ignored-by-main-process',
      priority: 0,
      enabled: true
    })
  )
  expectInvokeOk(
    'provider:setCredential',
    await cdp.invoke('provider:setCredential', {
      providerId: demoProviderId,
      apiKey: 'sk-demo-not-a-real-key'
    })
  )
  expectInvokeOk(
    'provider:setAliases',
    await cdp.invoke('provider:setAliases', { providerId: demoProviderId, models: [demoModel] })
  )
  expectInvokeOk(
    'settings:update',
    await cdp.invoke('settings:update', { defaultModel: demoModel })
  )
  log('✓ E2E 演示供应商经正式 IPC 显式建立（不进入生产默认数据）')

  // ── 2. 首屏真的落到了对话页 ────────────────────────────────────────
  // 这一条钉住三件事:`initRuntime` 在 `registerIpc` 之前(否则 bootstrap 里没有
  // 默认工作区和默认模型)、外壳替播种出来的工作区开了外层 Tab、内层 Tab 起了对话页。
  // 少任何一环,首屏就是「打开一个工作区开始」,而输入框压根不存在。
  await until('对话输入框', () =>
    cdp.eval(`document.querySelector('[data-testid="composer-input"]') !== null`)
  )
  log('✓ 首屏直达对话页(默认工作区 → 外层 Tab → 内层对话 Tab)')

  // 发送按钮的 title 就是**生效模型**。空模型时它是「还没有可用的模型」,
  // 于是 settings:update 的广播有没有真的抵达渲染层，在这一个属性上看得见。
  const alias = await until('生效模型', () =>
    cdp.eval(`document.querySelector('[data-testid="composer-send"]')?.title ?? null`)
  )
  if (alias !== demoModel) throw new Error(`E2E 模型没有生效:${alias}`)
  log(`✓ 设置广播切换了生效模型 · ${alias}`)

  // ── 3. ★ 打字 + 点发送 ────────────────────────────────────────────
  // textarea 是受控的,直接改 `.value` React 看不见(它自己的 value tracker 会
  // 认为没变过)。走原型上的 setter 再派发 input 事件,才是 React 眼里的一次输入。
  await cdp.eval(`
    (() => {
      const el = document.querySelector('[data-testid="composer-input"]')
      if (!el) throw new Error('找不到输入框')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, '看一下这个工程的结构')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await cdp.eval(`
    (() => {
      const send = document.querySelector('[data-testid="composer-send"]')
      if (!send) throw new Error('找不到发送按钮')
      if (send.disabled) throw new Error('发送按钮是灰的 —— 草稿没进 React,或者没有可用模型')
      send.click()
      return true
    })()
  `)
  log('✓ 输入进了 React 受控 state,点了发送')

  // ── 4. 文字真的流出来了 ───────────────────────────────────────────
  // 转录里的错误块渲染成 `code: message`,一出现就别等了
  const errorInDom = () =>
    cdp.eval(`
      (() => {
        const el = [...document.querySelectorAll('[data-testid="thread"] p')].find((p) =>
          /^(auth|rate_limit|context_length|network|aborted|tool_failed|provider|no_healthy_provider|unknown):/.test(p.innerText.trim())
        )
        return el ? el.innerText.trim() : null
      })()
    `)

  await until(
    '流式文字',
    () =>
      cdp.eval(`
      (() => {
        const el = document.querySelector('[data-testid="thread"]')
        if (!el) return null
        return el.innerText.includes('演示值:text') ? el.innerText : null
      })()
    `),
    { bail: errorInDom }
  )
  log('✓ 流式文字到了渲染层,且工具结果回填进了第二轮回复')

  // ── 5. 收尾状态:done + 用量 + seq ─────────────────────────────────
  // ★ 读的是 StatusLine 上的 data-* 属性,不是那句会改的中文文案。
  const summary = await until(
    'run 收尾',
    () =>
      cdp.eval(`
      (() => {
        const el = document.querySelector('[data-testid="chat-status"]')
        if (!el) return null
        const status = el.dataset.status
        if (status === 'running') return null
        return {
          status,
          seq: Number(el.dataset.seq),
          model: el.dataset.model,
          queued: Number(el.dataset.queued),
          tools: [...document.querySelectorAll('[data-testid="tool-call"]')].map(
            (t) => t.dataset.toolStatus
          )
        }
      })()
    `),
    { bail: errorInDom }
  )
  if (summary.status !== 'done') throw new Error(`run 没有正常收尾:${summary.status}`)
  if (summary.seq < 1) throw new Error(`seq 没有推进:${summary.seq}`)
  log(`✓ run 收尾 · status=${summary.status} · seq=${summary.seq} · 队列=${summary.queued}`)

  // 工具那一圈:encode → 假网络 → decode → session → tool → 再 encode
  if (summary.tools.length === 0) throw new Error('转录里没有工具调用卡片')
  if (!summary.tools.every((s) => s === 'ok')) {
    throw new Error(`工具没有全部成功:${JSON.stringify(summary.tools)}`)
  }
  log(`✓ 工具调用 ${summary.tools.length} 个,全部 ok`)

  // 状态行上的 model 来自真实 SSE 的 `message_start.model`。这里钉住请求编码、
  // demo.invalid 拦截和响应解码使用的是刚才显式配置的模型，而不是内置默认项。
  if (summary.model !== demoModel) {
    throw new Error(`状态行上的模型不对:${summary.model}`)
  }
  log(`✓ 显式配置模型贯穿请求与响应 · ${summary.model}`)

  log('\n✅ 端到端通过 —— 打包产物里点一下发送,真的能看到文字滚出来。')
} catch (err) {
  failed = true
  console.error(`\n❌ 端到端失败:${err.message}`)
} finally {
  child?.kill('SIGTERM')
  await sleep(500)
  if (child !== null && child.exitCode === null) child.kill('SIGKILL')
  if (testProject !== null) await rm(testProject, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
