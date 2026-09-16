/**
 * 全局搜索面板(SearchPalette)的隔离 Electron 验收 —— 真打包产物、真 preload、
 * 真 IPC handler,不是无头单测。
 *
 * 覆盖:侧边栏「搜索」把面板打开 → 输入关键词命中 conversations:searchAll →
 * 结果里带 <mark> 高亮 → 点结果真的跳到对应会话 → Esc / 点遮罩能关掉。
 *
 * 跑法:npm run build && node scripts/search-probe.mjs
 *
 * 环境要求(抄自 import-probe.mjs,同样的三个坑):
 * 1. ELECTRON_RUN_AS_NODE 必须清掉。
 * 2. --user-data-dir 必须传(数据根 + 单实例锁)。
 * 3. cwd 指向一个空临时目录 —— bootstrap 会拿它当默认工作区,不用走原生
 *    workspace:pick 对话框。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9336
const DEADLINE_MS = 30_000
const KEYWORD = '斑马线彩虹探针关键词'

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

  invoke(channel, req) {
    return this.eval(`window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req ?? null)})`)
  }
}

function expectOk(channel, result) {
  if (result?.ok === true) return result.data
  throw new Error(`${channel} 失败:${result?.error?.message ?? JSON.stringify(result)}`)
}

async function until(label, fn, timeoutMs = DEADLINE_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last !== null && last !== undefined && last !== false) return last
    if (Date.now() > deadline) throw new Error(`超时等待「${label}」,最后拿到 ${JSON.stringify(last)}`)
    await sleep(200)
  }
}

const log = (s) => console.log(s)

let child = null
let isolatedProject = null
let failed = false

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_RENDERER_URL

  const projectRoot = process.cwd()
  isolatedProject = await mkdtemp(join(tmpdir(), 'ncw-search-probe-'))
  const userData = join(isolatedProject, '.electron-user-data')

  child = spawn(
    electron,
    [projectRoot, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: isolatedProject, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const mainOut = []
  child.stdout.on('data', (b) => mainOut.push(String(b)))
  child.stderr.on('data', (b) => mainOut.push(String(b)))
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`⚠️ 主进程提前退出,code=${code}\n${mainOut.join('')}`)
  })

  const target = await until('渲染进程 CDP target', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      return null
    }
  })
  log(`✓ 窗口起来了 · ${target.title || target.url}`)

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await until('contextBridge 注入', () => cdp.eval('typeof window.nextcowork').then((t) => t === 'object'))

  // ── 过登录门 ──────────────────────────────────────────────────────
  await until('登录门过掉', async () => {
    const done = await cdp.eval(`
      (() => {
        const gate = [...document.querySelectorAll('button')]
          .find((b) => /免登录使用|Continue without/.test(b.textContent ?? ''))
        if (gate) { gate.click(); return 'clicked' }
        return document.querySelector('nav') !== null ? 'shell' : null
      })()
    `)
    return done === 'shell' ? true : null
  })
  log('✓ 过掉登录门,应用外壳就位')

  // ── 用 IPC 直接灌两条会话:一条带关键词,一条不带 ──────────────────────
  const bootstrap = expectOk('app:getBootstrap', await cdp.invoke('app:getBootstrap'))
  if (!Array.isArray(bootstrap.workspaces) || bootstrap.workspaces.length === 0) {
    throw new Error('期望隔离的 cwd 带出一个默认工作区')
  }
  const workspaceId = bootstrap.workspaces[0].id
  log(`✓ 默认工作区就位 · ${workspaceId}`)

  const sessionA = expectOk(
    'sessions:create',
    await cdp.invoke('sessions:create', { workspaceId, title: '探针命中会话' })
  )
  const sessionB = expectOk(
    'sessions:create',
    await cdp.invoke('sessions:create', { workspaceId, title: '探针不该命中的会话' })
  )
  const now = Date.now()
  expectOk(
    'sessions:replaceHistory',
    await cdp.invoke('sessions:replaceHistory', {
      sessionId: sessionA.id,
      messages: [
        {
          id: 'probe-msg-a',
          role: 'user',
          parts: [{ type: 'text', text: `这是一段测试文本,里面藏着 ${KEYWORD} 这个关键词。` }],
          createdAt: now,
          schemaVersion: 1
        }
      ]
    })
  )
  expectOk(
    'sessions:replaceHistory',
    await cdp.invoke('sessions:replaceHistory', {
      sessionId: sessionB.id,
      messages: [
        {
          id: 'probe-msg-b',
          role: 'user',
          parts: [{ type: 'text', text: '完全无关的另一段内容,不含探针词。' }],
          createdAt: now,
          schemaVersion: 1
        }
      ]
    })
  )
  log('✓ 灌入两条会话(一条带关键词,一条不带)')

  // ── 侧边栏「搜索」按钮把面板打开 ────────────────────────────────────
  await until('点击侧边栏搜索', () =>
    cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('nav button')]
          .find((b) => (b.textContent ?? '').trim() === '搜索')
        if (!btn) return false
        btn.click()
        return true
      })()
    `)
  )
  await until('搜索面板打开', () =>
    cdp.eval(`document.querySelector('[role="dialog"][aria-label="搜索"]') !== null`)
  )
  log('✓ 点击侧边栏「搜索」,面板弹出来了')

  // ── 输入关键词 ───────────────────────────────────────────────────
  await cdp.eval(`
    (() => {
      const input = document.querySelector('[role="dialog"][aria-label="搜索"] input')
      input.focus()
    })()
  `)
  // 用原生 value setter + input 事件,而不是直接改 .value —— React 的受控输入
  // 只认原生 setter 触发的事件,直接赋值不会走 onValueChange。
  await cdp.eval(`
    (() => {
      const input = document.querySelector('[role="dialog"][aria-label="搜索"] input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(KEYWORD)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)

  const hitText = await until('搜索结果命中', async () => {
    const text = await cdp.eval(`
      (() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="搜索"]')
        const marks = [...dialog.querySelectorAll('mark')].map((m) => m.textContent)
        const titles = [...dialog.querySelectorAll('[cmdk-item]')].map((el) => el.textContent)
        return JSON.stringify({ marks, titles })
      })()
    `)
    const parsed = JSON.parse(text)
    return parsed.titles.length > 0 ? parsed : null
  })
  log(`✓ 搜索命中:${hitText.titles.join(' | ')}`)
  if (!hitText.titles.some((t) => t.includes('探针命中会话'))) {
    throw new Error(`结果里没有找到应该命中的会话标题,实际:${JSON.stringify(hitText.titles)}`)
  }
  if (hitText.titles.some((t) => t.includes('不该命中'))) {
    throw new Error(`不该命中的会话也出现在结果里:${JSON.stringify(hitText.titles)}`)
  }
  if (hitText.marks.length === 0 || !hitText.marks.some((m) => KEYWORD.includes(m) || m.includes(KEYWORD.slice(0, 2)))) {
    throw new Error(`片段里没有 <mark> 高亮:${JSON.stringify(hitText.marks)}`)
  }
  log('✓ 命中的是正确会话,且摘要里带 <mark> 高亮,没有误伤无关会话')

  // ── 点击结果,应当跳转到那段会话并关闭面板 ───────────────────────────
  await cdp.eval(`
    (() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="搜索"]')
      const item = [...dialog.querySelectorAll('[cmdk-item]')]
        .find((el) => el.textContent.includes('探针命中会话'))
      item.click()
    })()
  `)
  await until('面板关闭且跳转到目标会话', () =>
    cdp.eval(`
      document.querySelector('[role="dialog"][aria-label="搜索"]') === null &&
      window.location.hash.includes(${JSON.stringify(sessionA.id)})
    `)
  )
  log('✓ 点击结果后面板关闭,地址栏落到了目标会话')

  // ── Esc 能关掉面板 ───────────────────────────────────────────────
  await until('再次打开搜索面板', () =>
    cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('nav button')]
          .find((b) => (b.textContent ?? '').trim() === '搜索')
        if (!btn) return false
        btn.click()
        return document.querySelector('[role="dialog"][aria-label="搜索"]') !== null
      })()
    `)
  )
  await cdp.eval(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  `)
  await until('Esc 关闭面板', () => cdp.eval(`document.querySelector('[role="dialog"][aria-label="搜索"]') === null`))
  log('✓ Esc 能关掉搜索面板')

  log('\n全部通过 ✅')
} catch (err) {
  failed = true
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
} finally {
  if (child !== null) {
    child.kill('SIGTERM')
    await sleep(1500)
    if (child.exitCode === null) child.kill('SIGKILL')
    await sleep(300)
  }
  if (isolatedProject !== null) await rm(isolatedProject, { recursive: true, force: true }).catch(() => {})
  process.exit(failed ? 1 : 0)
}
