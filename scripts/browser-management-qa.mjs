/**
 * 浏览器管理页的独立视觉验收：用隔离数据目录启动生产构建，在参考图尺寸下
 * 点击左侧浏览器入口并保存截图，同时断言工作区外层/内层 Tab 与工作台控件
 * 没有混入管理页。
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9341
const OUTPUT_DIR = '/tmp/nextcowork-browser-qa'
const OUTPUT_PATH = join(OUTPUT_DIR, 'implementation.png')
const VIEWPORT = { width: 1535, height: 1182 }

class Cdp {
  #socket
  #nextId = 0
  #pending = new Map()

  static async attach(url) {
    const client = new Cdp()
    client.#socket = new WebSocket(url)
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = client.#pending.get(message.id)
      if (pending === undefined) return
      client.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener('open', resolve, { once: true })
      client.#socket.addEventListener('error', reject, { once: true })
    })
    return client
  }

  send(method, params = {}) {
    const id = ++this.#nextId
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面执行失败')
    }
    return result.result.value
  }
}

async function until(label, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`超时等待：${label}`)
    await sleep(150)
  }
}

let child
let isolatedProject

try {
  await mkdir(OUTPUT_DIR, { recursive: true })
  isolatedProject = await mkdtemp(join(tmpdir(), 'nextcowork-browser-qa-'))
  const userData = join(isolatedProject, '.electron-user-data')
  const projectRoot = process.cwd()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  child = spawn(electron, [projectRoot, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: isolatedProject,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const target = await until('Electron 渲染进程', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`)
      const targets = await response.json()
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch {
      return null
    }
  })

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false
  })

  await cdp.eval(`window.nextcowork.invoke('settings:update', { theme: 'light', locale: 'zh-CN' })`)
  await until('浅色中文界面', () =>
    cdp.eval(`
      document.documentElement.dataset.theme === 'light' &&
        document.documentElement.lang === 'zh-CN'
    `)
  )

  await until('左侧浏览器入口', () =>
    cdp.eval(`
      [...document.querySelectorAll('button')].some((button) =>
        ['浏览器', 'Browser'].includes(button.textContent.trim())
      )
    `)
  )

  const clicked = await cdp.eval(`
    (() => {
      const button = [...document.querySelectorAll('button')].find((item) =>
        ['浏览器', 'Browser'].includes(item.textContent.trim())
      )
      if (!button) return false
      button.click()
      return true
    })()
  `)
  if (!clicked) throw new Error('无法点击左侧浏览器入口')

  await until('浏览器管理页与默认 Profile', () =>
    cdp.eval(`
      (() => {
        const heading = document.querySelector('h1')?.textContent.trim()
        const text = document.body.textContent
        return ['浏览器', 'Browser'].includes(heading) &&
          (text.includes('默认浏览器') || text.includes('Default browser'))
      })()
    `)
  )
  await sleep(350)

  const state = await cdp.eval(`
    (() => {
      const labels = [...document.querySelectorAll('button')]
        .map((button) => button.getAttribute('aria-label'))
        .filter(Boolean)
      return {
        viewport: { width: innerWidth, height: innerHeight },
        heading: document.querySelector('h1')?.textContent.trim(),
        hasOuterWorkspacePicker: labels.includes('打开工作区') || labels.includes('Open workspace'),
        hasBottomPanelToggle: labels.includes('底部面板') || labels.includes('Bottom panel'),
        hasRightPanelToggle: labels.includes('工作区文件') || labels.includes('Workspace files')
      }
    })()
  `)

  if (state.viewport.width !== VIEWPORT.width || state.viewport.height !== VIEWPORT.height) {
    throw new Error(`视口尺寸错误：${state.viewport.width}×${state.viewport.height}`)
  }
  if (state.hasOuterWorkspacePicker || state.hasBottomPanelToggle || state.hasRightPanelToggle) {
    throw new Error(`管理页混入工作区控件：${JSON.stringify(state)}`)
  }

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })
  await writeFile(OUTPUT_PATH, Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify({ ...state, screenshot: OUTPUT_PATH }, null, 2))
} finally {
  child?.kill('SIGTERM')
  if (isolatedProject !== undefined) {
    await rm(isolatedProject, { recursive: true, force: true })
  }
}
