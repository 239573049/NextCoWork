/** Desktop regression for catalogue -> binding -> composer -> wire metadata. Uses an isolated local provider. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'

class Cdp {
  id = 0
  pending = new Map()
  static async connect(url) {
    const cdp = new Cdp()
    cdp.ws = new WebSocket(url)
    cdp.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data), item = cdp.pending.get(message.id)
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
  click(text) {
    return this.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Button unavailable'); b.click() })()`)
  }
  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(qaDir, name), Buffer.from(shot.data, 'base64'))
  }
}
async function until(label, check) {
  const deadline = Date.now() + 25000
  let lastError
  while (Date.now() < deadline) {
    try { if (await check()) return } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Timed out: ${label}; ${lastError?.message ?? ''}`)
}

const qaDir = await mkdtemp(join(tmpdir(), 'nextcowork-model-sync-qa-'))
const requests = []
let expectedEffort = 'max', serverError, child, cdp, output = ''
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      assert.equal(req.url, '/v1/models')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }, { id: 'plain-qa' }] }))
      return
    }
    let raw = ''
    for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw)
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer qa-not-a-real-key')
    const system = body.messages?.find((message) => message.role === 'system')?.content
    const isTitle = JSON.stringify(system)?.includes('Generate a short conversation title')
    if (!isTitle) {
      assert.equal(body.reasoning_effort, expectedEffort)
      assert.deepEqual(body.thinking, { type: 'enabled' })
      requests.push(body)
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: isTitle ? '模型同步检查' : 'CATALOG SYNC VERIFIED' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    serverError = error
    res.end(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  child = spawn(electron, [process.cwd(), '--remote-debugging-port=0', `--user-data-dir=${join(qaDir, 'profile')}`],
    { cwd: qaDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let port, target
  await until('debugging port', () => (port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]))
  await until('renderer target', async () => (target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')))
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await until('preload', () => cdp.eval('typeof window.nextcowork === "object"'))
  const { workspaces: [workspace] } = await cdp.invoke('app:getBootstrap')
  await cdp.invoke('provider:upsert', { id: 'qa', name: 'Model Sync QA', protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialRef: '', priority: 0, enabled: true })
  await cdp.invoke('provider:setCredential', { providerId: 'qa', apiKey: 'qa-not-a-real-key' })
  const fetched = await cdp.invoke('provider:fetchModels', { providerId: 'qa' })
  const imported = await cdp.invoke('provider:setAliases', { providerId: 'qa', models: fetched.map((model) => model.id) })
  const glm = imported.find((model) => model.upstreamModel === 'glm-5.3-flash')
  const plain = imported.find((model) => model.upstreamModel === 'plain-qa')
  assert.deepEqual(glm.reasoningEfforts, ['low', 'high', 'max'])
  assert.equal(glm.thinkingConfig.defaultEffort, 'max')
  await cdp.invoke('model:update', { ...plain, thinkingConfig: { mode: 'unsupported', defaultEnabled: false } })
  await cdp.invoke('settings:update', { locale: 'zh-CN', defaultModel: glm.alias })
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { defaultModel: glm.alias, defaultThinking: 'medium', webSearch: false } })
  await cdp.click('新建对话')
  await until('model selected', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "glm-5.3-flash"'))
  const openThinking = async () => {
    await cdp.eval('document.querySelector("button[aria-label=模型]").click()')
    await until('model config item', () => cdp.eval('[...document.querySelectorAll("[role=menuitem]")].some(b => b.innerText.includes("模型配置"))'))
    await cdp.eval('[...document.querySelectorAll("[role=menuitem]")].find(b => b.innerText.includes("模型配置")).click()')
    await until('thinking choices', () => cdp.eval('document.body.innerText.includes("返回提供商")'))
  }
  const choices = () => cdp.eval('[...document.querySelectorAll("[role=menu] button[role=menuitem]")].map(b => b.innerText.trim()).filter(t => t !== "返回提供商")')
  const send = async () => {
    const before = requests.length
    await cdp.eval(`(() => { const e = document.querySelector('[data-testid=composer-input]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, '检查模型同步');
      e.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
    await until('request received', () => requests.length > before)
    await until('reply complete', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done"'))
  }
  await openThinking()
  assert.deepEqual(await choices(), ['自动', '低', '高', '最高'])
  assert.equal(await cdp.eval('document.body.innerText.includes("模型默认：最高")'), true)
  await cdp.screenshot('catalog-thinking-options.png')
  await cdp.click('自动')
  await send()

  // Edit the catalogue while the menu is open: no reload or reselection.
  await openThinking()
  await cdp.invoke('modelCatalog:upsert', {
    id: glm.upstreamModel, displayName: glm.displayName, manufacturerId: 'zhipu', manufacturerLabel: '智谱 GLM',
    modality: glm.modality, capabilities: glm.capabilities, contextWindow: glm.contextWindow, maxOutputTokens: glm.maxOutputTokens,
    overrideBuiltin: true, thinkingConfig: { ...glm.thinkingConfig, defaultEffort: 'high' }, reasoningEfforts: ['low', 'high']
  })
  await until('live catalogue update', async () => JSON.stringify(await choices()) === JSON.stringify(['自动', '低', '高']))
  assert.equal(await cdp.eval('document.body.innerText.includes("模型默认：高")'), true)
  await cdp.screenshot('catalog-thinking-live.png')
  await cdp.click('低')
  expectedEffort = 'low'
  await send()
  const latestGlm = (await cdp.invoke('provider:listModels', { providerId: 'qa' })).find((model) => model.alias === glm.alias)
  await cdp.invoke('model:update', { ...latestGlm,
    thinkingConfig: { ...latestGlm.thinkingConfig, defaultEffort: 'low' }, reasoningEfforts: ['low'] })
  const resynced = await cdp.invoke('provider:setAliases', { providerId: 'qa', models: [glm.alias, 'plain-qa'] })
  assert.deepEqual(resynced.find((model) => model.alias === glm.alias).reasoningEfforts, ['low'])
  await openThinking()
  assert.deepEqual(await choices(), ['自动', '低'])
  await cdp.click('返回提供商')
  await cdp.eval('[...document.querySelectorAll("[role=menuitem]")].find(b => b.innerText.includes("Model Sync QA")).click()')
  await until('model submenu', () => cdp.eval('[...document.querySelectorAll("button")].some(b => b.innerText.trim() === "plain-qa")'))
  await cdp.click('plain-qa')
  await cdp.eval('document.querySelector("button[aria-label=模型]").click()')
  await until('unsupported controls', () => cdp.eval('[...document.querySelectorAll("[role=menuitem]")].some(b => b.disabled && b.innerText.includes("此模型不支持思考设置"))'))
  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await cdp.eval('document.querySelector("button[aria-label=设置]").click()')
  await until('settings', () => cdp.eval('document.querySelector("[role=dialog]") !== null'))
  await cdp.click('模型')
  await until('provider model rows', () => cdp.eval('[...document.querySelectorAll("li")].some(row => row.innerText.includes("glm-5.3-flash") && row.querySelector("button[aria-label=配置推理能力]"))'))
  await cdp.eval('[...document.querySelectorAll("li")].find(row => row.innerText.includes("glm-5.3-flash") && row.querySelector("button[aria-label=配置推理能力]")).querySelector("button[aria-label=配置推理能力]").click()')
  await until('reasoning dialog', () => cdp.eval('[...document.querySelectorAll("input")].some(input => input.value === "reasoning_effort")'))
  const dialogValues = await cdp.eval(`(() => { const dialog = [...document.querySelectorAll('[role=dialog]')].at(-1);
    return { mode: dialog.querySelector('select')?.value,
      efforts: [...dialog.querySelectorAll('input[type=checkbox]')].filter(input => input.checked).map(input => input.parentElement.textContent.trim()) } })()`)
  assert.equal(dialogValues.mode, 'effort')
  assert.deepEqual(dialogValues.efforts, ['low'])
  await cdp.screenshot('provider-reasoning-dialog.png')
  // Exercise the actual save handler: it must retain the effort parameter path.
  await cdp.eval('[...document.querySelectorAll("[role=dialog]")].at(-1).querySelectorAll("button").forEach(b => { if (b.innerText.trim() === "保存") b.click() })')
  await until('reasoning save completed', () => cdp.eval('![...document.querySelectorAll("[role=dialog]")].some(dialog => dialog.innerText.includes("支持的思考强度"))'))
  const savedGlm = (await cdp.invoke('provider:listModels', { providerId: 'qa' })).find((model) => model.alias === glm.alias)
  assert.equal(savedGlm.thinkingConfig.parameterPath, 'reasoning_effort')
  assert.deepEqual(savedGlm.reasoningEfforts, ['low'])
  assert.equal(serverError, undefined)
  console.log(JSON.stringify({ result: 'PASS', requests: requests.length, checks: [
    'provider discovery and catalogue inheritance', 'declared efforts and defaults', 'live catalogue changes',
    'actual request efforts', 'provider overrides survive resync', 'model switching clears unsupported choices',
    'provider reasoning dialog displays and saves inherited fields'
  ], artifacts: qaDir }, null, 2))
} catch (error) {
  console.error(error)
  console.error(`QA artifacts: ${qaDir}`)
  if (cdp) {
    await cdp.screenshot('failure.png').catch(() => {})
    console.error(await cdp.eval('document.body.innerText').catch(() => 'Renderer unavailable'))
  }
  console.error(output.slice(-3000))
  process.exitCode = 1
} finally {
  cdp?.ws.close()
  child?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
