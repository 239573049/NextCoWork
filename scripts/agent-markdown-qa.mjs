/** Desktop Markdown acceptance with an isolated local provider and retained screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'

class Cdp {
  id = 0
  pending = new Map()
  errors = []
  networkErrors = []
  static async connect(url) {
    const cdp = new Cdp()
    cdp.ws = new WebSocket(url)
    cdp.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') cdp.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
      if (message.method === 'Network.loadingFailed') cdp.networkErrors.push(message.params)
      const item = cdp.pending.get(message.id)
      if (!item) return
      cdp.pending.delete(message.id)
      if (message.error) item.reject(new Error(JSON.stringify(message.error)))
      else item.resolve(message.result)
    })
    await new Promise((resolve, reject) => {
      cdp.ws.addEventListener('open', resolve, { once: true })
      cdp.ws.addEventListener('error', reject, { once: true })
    })
    return cdp
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Renderer exception')
    return result.result.value
  }
  async invoke(channel, request) {
    const result = await this.eval(`window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`)
    if (!result.ok) throw new Error(`${channel}: ${result.error.message}`)
    return result.data
  }
  click(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()` ) }
  fill(selector, value) {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  }
}

async function until(label, check) {
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

const qaDir = await realpath(await mkdtemp(join(tmpdir(), 'nextcowork-agent-markdown-qa-')))
const screenshots = []
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="120"><rect width="500" height="120" rx="16" fill="#e8eee8"/><circle cx="60" cy="60" r="25" fill="#2d4739"/><text x="105" y="70" font-family="sans-serif" font-size="24" fill="#2d4739">Agent workspace preview</text></svg>'
let imageRequests = 0
let step = 0
let serverError
let releaseCode
let releaseDiagram
const codeReady = new Promise((resolve) => { releaseCode = resolve })
const diagramReady = new Promise((resolve) => { releaseDiagram = resolve })
let baseUrl
const first = [
  '## Gateway 架构', '',
  '这是一个 **.NET 10** 工作区：管理控制面和独立网关数据面共享配置，Agent 负责连接与执行。', '',
  '| 工程 | 角色 | 状态 |', '| :--- | :--- | ---: |',
  '| `src/FastGateway` | 控制面 API + 数据面 | 就绪 |', '| `src/TunnelClient` | 隧道 Agent | 就绪 |',
  '| `src/Core` | 实体与 Stream 抽象 | 就绪 |', '| `src/Certes` | ACME 客户端 | 待检查 |', '',
  '### 执行路径', '', '1. 读取工作区配置。', '2. 建立隧道。', '   - 检查权限。', '   - 注册可用工具。', '',
  '> 完成后返回结果，并在这条回复下面显示执行状态。', '',
  '```typescript', 'const state: string = "ready"',
].join('\n') + '\n'
const middle = [
  'const message = "' + 'Agent output stays inside this conversation. '.repeat(5) + '"',
  'console.log(state, message)', '```', '',
  '### 预算与数据流', '', '行内公式 $E = mc^2$，块公式：', '',
  '$$', '\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}', '$$', '',
  '```mermaid', 'flowchart LR', '  User[用户] --> Agent[Agent]', '  Agent --> Tools[工具]', '  Tools --> Reply[回复]',
].join('\n') + '\n'
const tail = () => [
  '```', '', '### 验证清单', '', '- [x] Markdown 与流式回复', '- [x] 代码块与图表', '- [ ] 下一轮计划', '',
  '[查看 Gateway.cs](src/Gateway.cs) · [回到架构](#gateway-架构)', '',
  '![本地工作区图片](preview.svg)', '', `![外部图片](${baseUrl}/preview.svg)`, '',
  '这是一条带注释的结果[^note]。', '', '[^note]: 重载历史消息后仍使用相同的 Markdown 组件。', '',
  '```mermaid', 'this is not a valid diagram', '```', '',
  '```mermaid', 'flowchart LR', `  Pixel@{ img: "${baseUrl}/preview.svg" }`, '```', '',
  '[禁止脚本](javascript:alert%281%29)', '', '<script>window.markdownAttack = true</script>',
].join('\n')

const server = createServer(async (req, res) => {
  if (req.url === '/preview.svg') {
    imageRequests++
    assert.equal(req.headers.referer, undefined)
    res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(image); return
  }
  try {
    let raw = ''
    for await (const data of req) raw += data
    const body = JSON.parse(raw)
    assert.equal(req.headers.authorization, 'Bearer qa-markdown-local')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (JSON.stringify(body.messages?.find((message) => message.role === 'system')?.content).includes('Generate a short conversation title')) {
      send({ content: 'Markdown 组件验证' }, 'stop')
    } else if (step++ === 0) {
      send({ reasoning_content: '### 核对内容\n\n- **表格**与列表\n- 代码、公式和文件引用' })
      send({ content: first })
      await codeReady
      send({ content: middle })
      await diagramReady
      send({ content: tail() }, 'stop')
    } else if (step === 2) {
      send({ tool_calls: [{ index: 0, id: 'markdown-plan', type: 'function', function: { name: 'RequestPlanApproval',
        arguments: JSON.stringify({ plan: '## 下一步计划\n\n- [x] 完成共享渲染\n- [ ] 验证审批\n\n| 项目 | 结果 |\n| --- | --- |\n| Markdown | **通过** |' }) } }] }, 'tool_calls')
    } else {
      send({ content: '**验证完成**：计划已确认。' }, 'stop')
    }
    res.end('data: [DONE]\n\n')
  } catch (error) { serverError = error; res.destroy(error) }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
baseUrl = `http://127.0.0.1:${server.address().port}`
let child
let cdp
let output = ''

async function shot(name, selector, top = false) {
  if (selector) await cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`)
  if (top) await cdp.eval('document.querySelector("[data-testid=thread]").scrollTop = 0')
  await delay(180)
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const path = join(qaDir, name)
  await writeFile(path, Buffer.from(result.data, 'base64'))
  screenshots.push(path)
}

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [process.cwd(), '--remote-debugging-port=0', `--user-data-dir=${join(qaDir, 'profile')}`], { cwd: qaDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let port
  await until('debugging port', () => (port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]))
  let target
  await until('renderer target', async () => (target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === 'page')))
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 920, deviceScaleFactor: 1, mobile: false })
  await until('preload', () => cdp.eval('typeof window.nextcowork === "object"'))
  await until('initial shell', () => cdp.eval('!!document.querySelector("[data-testid=composer-input]")'))
  const { workspaces } = await cdp.invoke('app:getBootstrap')
  const workspace = workspaces[0]
  assert(!relative(qaDir, workspace.rootPath).startsWith('..'))
  await mkdir(join(workspace.rootPath, 'src'), { recursive: true })
  await writeFile(join(workspace.rootPath, 'src/Gateway.cs'), 'public sealed class Gateway { }\n')
  await writeFile(join(workspace.rootPath, 'preview.svg'), image)
  await writeFile(join(workspace.rootPath, 'README.md'), '# Shared Markdown\n\n**Preview** uses the same component.\n\n```ts\nconst shared = true\n```')
  await cdp.invoke('provider:upsert', { id: 'markdown-qa', name: 'Markdown QA', protocol: 'openai-chat', baseUrl: `${baseUrl}/v1`, credentialRef: '', priority: 0, enabled: true })
  await cdp.invoke('provider:setCredential', { providerId: 'markdown-qa', apiKey: 'qa-markdown-local' })
  await cdp.invoke('provider:setAliases', { providerId: 'markdown-qa', models: ['deepseek-markdown-qa'] })
  const [alias] = await cdp.invoke('provider:listModels', { providerId: 'markdown-qa' })
  await cdp.invoke('model:update', { ...alias, contextWindow: 200000, maxOutputTokens: 8192, capabilities: { ...alias.capabilities, tools: true, thinking: true }, thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' } })
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { permissionMode: 'ask', defaultModel: 'deepseek-markdown-qa', defaultThinking: 'high', webSearch: false } })
  await cdp.invoke('settings:update', { defaultModel: 'deepseek-markdown-qa', locale: 'zh-CN', theme: 'light' })
  await until('model', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "deepseek-markdown-qa"'))
  await cdp.fill('[data-testid=composer-input]', '请介绍 Gateway 架构，并展示表格、代码和图表。')
  await cdp.click('[data-testid=composer-send]')
  await until('live Markdown', () => cdp.eval('!!document.querySelector(".markdown-code-source") && !!document.querySelector("[data-testid=thinking-block] strong")'))
  assert.equal(await cdp.eval('document.querySelectorAll(".agent-markdown table tr").length'), 5)
  await cdp.eval('window.qaCodeNode = document.querySelector(".markdown-code-block"); window.qaCodeNode.querySelector("button[aria-pressed]").click()')
  await until('wrap enabled', () => cdp.eval('!!window.qaCodeNode.querySelector("pre[data-wrap]")'))
  await shot('01-streaming-markdown.png', '.markdown-code-block')
  releaseCode()
  await until('pending Mermaid', () => cdp.eval('!!document.querySelector("[data-language=mermaid][data-streaming=true]")'))
  assert.equal(await cdp.eval('window.qaCodeNode === document.querySelector(".markdown-code-block") && !!window.qaCodeNode.querySelector("pre[data-wrap]")'), true)
  // Reading an earlier part must not be pulled back down when the stream grows.
  await cdp.eval('document.querySelector("[data-testid=thread]").scrollTop = 0')
  await delay(150)
  releaseDiagram()
  await until('complete Markdown', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done"'))
  assert.equal(await cdp.eval('window.qaCodeNode === document.querySelector(".markdown-code-block") && !!window.qaCodeNode.querySelector("pre[data-wrap]")'), true)
  await until('highlight and math', () => cdp.eval('!!document.querySelector(".tok-keyword") && !!document.querySelector(".katex-display")'))
  await until('diagram and fallback', () => cdp.eval('document.querySelector(".markdown-diagram img")?.naturalWidth > 0 && document.body.textContent.includes("暂时无法绘制图表")'))
  assert.equal(await cdp.eval('document.querySelector("[data-testid=thread]").scrollTop < 10'), true)
  assert.equal(await cdp.eval('window.markdownAttack === undefined'), true)
  assert.equal(imageRequests, 0)
  await shot('02-tables-and-lists-light.png', null, true)
  await shot('03-code-math-diagram-light.png', '.katex-display')
  await cdp.eval('[...document.querySelectorAll(".markdown-code-views button")].find(b => b.textContent === "源码").click()')
  await until('diagram source', () => cdp.eval('!!document.querySelector("[data-language=mermaid] .markdown-code-source")'))
  await cdp.eval('[...document.querySelectorAll(".markdown-code-views button")].find(b => b.textContent === "图表").click()')
  await until('diagram restored', () => cdp.eval('document.querySelector(".markdown-diagram img")?.naturalWidth > 0'))
  await cdp.eval('document.querySelector(".markdown-image-placeholder")?.scrollIntoView({block:"center"}); [...document.querySelectorAll(".markdown-image-placeholder button")].find(b => b.textContent === "加载图片").click()')
  await until('external image only after click', () => imageRequests === 1)
  await until('loaded images', () => cdp.eval('[...document.querySelectorAll(".agent-markdown img")].filter(img => img.naturalWidth > 0).length >= 3'))
  await shot('04-images-and-footnotes.png', '.footnotes')
  assert.equal(await cdp.eval('!!document.querySelector("[data-testid=chat-status]").closest("[data-testid=assistant-turn]")'), true)
  const anchor = await cdp.eval('document.querySelector(".agent-markdown a[href*=gateway]").getAttribute("href")')
  assert.equal(await cdp.eval(`!!document.getElementById(${JSON.stringify(anchor.slice(1))})`), true)
  await cdp.click('.agent-markdown a[href*=gateway]')
  await until('heading anchor', () => cdp.eval('document.querySelector("[data-testid=thread]").scrollTop < 230'))
  await cdp.eval('window.qaReload = true')
  await cdp.send('Page.reload')
  await until('history Markdown', () => cdp.eval('window.qaReload === undefined && !!document.querySelector(".agent-markdown table")'))
  assert.equal(imageRequests, 1)
  await cdp.eval('[...document.querySelectorAll(".agent-markdown a")].find(a => a.textContent === "查看 Gateway.cs").click()')
  await until('workspace file opened', () => cdp.eval('document.querySelector("[data-testid=document-view]")?.getAttribute("aria-label") === "src/Gateway.cs"'))
  await cdp.eval('[...document.querySelectorAll("[role=tab]")].find(tab => tab.title === "Markdown 组件验证").click()')
  await until('chat restored', () => cdp.eval('!!document.querySelector(".agent-markdown table")'))
  await cdp.invoke('settings:update', { theme: 'dark', locale: 'en-US' })
  await until('English controls', () => cdp.eval('document.querySelector(".markdown-copy")?.textContent.includes("Copy code")'))
  await until('dark diagram', () => cdp.eval('document.querySelector(".markdown-diagram img")?.naturalWidth > 0'))
  await shot('05-code-math-diagram-dark.png', '.katex-display')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 790, height: 880, deviceScaleFactor: 1, mobile: false })
  await delay(250)
  assert.equal(await cdp.eval('document.querySelector("[data-testid=thread]").scrollWidth <= document.querySelector("[data-testid=thread]").clientWidth + 1'), true)
  await shot('06-narrow-layout.png', '.markdown-code-block')
  await cdp.fill('[data-testid=composer-input]', 'Review the next plan.')
  await cdp.click('[data-testid=composer-send]')
  await until('Markdown plan', () => cdp.eval('!!document.querySelector("[data-interaction-kind=plan_approval] table")'))
  await shot('07-markdown-plan.png', '[data-interaction-kind=plan_approval]')
  await cdp.click('[data-interaction-kind=plan_approval] button[type=submit]')
  await until('approved and done', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done" && document.body.textContent.includes("计划已确认")'))
  assert.equal(serverError, undefined)
  assert.deepEqual(cdp.errors, [])
  console.log('PASS: live/history Markdown, thinking, stable code controls, tables, highlighting, math, Mermaid/fallback, images, anchors, file navigation, narrow layout, locales, plan approval and scroll ownership')
  console.log(JSON.stringify({ screenshots, isolatedData: qaDir, imageRequests }, null, 2))
} catch (error) {
  console.error(error)
  console.error(`QA artifacts: ${qaDir}`)
  if (cdp) console.error(await cdp.eval('document.body.innerText').catch(() => 'Renderer unavailable'))
  if (cdp?.networkErrors.length) console.error(JSON.stringify(cdp.networkErrors, null, 2))
  console.error(output.slice(-5000))
  process.exitCode = 1
} finally {
  releaseCode()
  releaseDiagram()
  cdp?.ws.close()
  child?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
