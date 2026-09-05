/** Desktop acceptance test against an isolated local HTTP provider; never uses real API keys. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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
      const message = JSON.parse(data)
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
  click(text) {
    return this.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)}); b.click(); return true })()`)
  }
  fill(selector, value) {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); return true })()`)
  }
}

async function until(label, check) {
  const end = Date.now() + 25000
  let lastError
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

const qaDir = await mkdtemp(join(tmpdir(), 'nextcowork-agent-protocol-qa-'))
const requests = []
let chatStep = 0
let responsesStep = 0
let serverError
let waitingConnectionClosed = false
let releaseFirstResponse
const firstResponseReady = new Promise((resolve) => { releaseFirstResponse = resolve })
let releaseFirstTitle
const firstTitleReady = new Promise((resolve) => { releaseFirstTitle = resolve })
let titleRequests = 0
const generatedTitle = '审批与协议续轮验证'
const reasoning = { type: 'reasoning', id: 'rs-qa', summary: [{ type: 'summary_text', text: '核对工具结果。' }], encrypted_content: 'qa-encrypted-reasoning' }
const server = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw)
    if (req.url === '/v1/messages') assert.equal(req.headers['x-api-key'], 'qa-not-a-real-api-key')
    else assert.equal(req.headers.authorization, 'Bearer qa-not-a-real-api-key')
    assert.equal(body.stream, true)
    if (req.url !== '/v1/messages') assert.equal(body.metadata, undefined)
    requests.push({ path: req.url, body })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (data) => res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    const system = body.instructions ?? body.system ?? body.messages?.find((message) => message.role === 'system')?.content
    if (JSON.stringify(system)?.includes('Generate a short conversation title from the first user message.')) {
      const titleNumber = titleRequests++
      assert.equal(body.tools?.length ?? 0, 0)
      if (titleNumber === 0) await firstTitleReady
      if (req.url === '/v1/chat/completions') {
        send({ model: body.model, choices: [{ index: 0, delta: { content: generatedTitle }, finish_reason: 'stop' }] })
        send('[DONE]')
      } else if (req.url === '/v1/responses') {
        send({ type: 'response.completed', response: { object: 'response', id: 'title-response', model: body.model, status: 'completed',
          output: [{ type: 'message', id: 'title-message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses continuation check' }] }],
          usage: { input_tokens: 20, output_tokens: 5 } } })
      } else {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        send({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 20, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Thinking preference check' } })
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
        send({ type: 'message_stop' })
      }
      res.end()
      return
    }
    if (req.url === '/v1/chat/completions') {
      const step = chatStep++
      const chunk = (delta, finish_reason = null) => ({ model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      if (step === 0) {
        await firstResponseReady
        send(chunk({ reasoning_content: '先创建测试文件，再询问用户的选择。' }))
        await delay(150)
        send(chunk({ content: '准备创建测试文件。', tool_calls: [{ index: 0, id: 'qa-write', type: 'function',
          function: { name: 'Write', arguments: '{"file_path":"agent-qa.txt","content":"verified"}' } }] }))
        send(chunk({}, 'tool_calls'))
      } else if (step === 1) {
        assert(body.messages.some((m) => m.role === 'assistant' && m.reasoning_content?.includes('先创建')))
        assert(body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'qa-write'))
        send(chunk({ reasoning_content: '文件已创建，现在需要用户选择。', tool_calls: [{ index: 0, id: 'qa-question', type: 'function',
          function: { name: 'AskUserQuestion', arguments: '{"question":"请选择测试选项","choices":["Alpha","Beta"],"allowFreeform":true}' } }] }))
        send(chunk({}, 'tool_calls'))
      } else if (step === 2) {
        assert(body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'qa-question' && m.content.includes('Beta')))
        send(chunk({ tool_calls: [{ index: 0, id: 'qa-plan', type: 'function', function: {
          name: 'RequestPlanApproval', arguments: '{"plan":"测试方案：确认协议续轮后完成验证。"}'
        } }] }, 'tool_calls'))
      } else if (step === 3) {
        assert(body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'qa-plan' && m.content.includes('"approved":true')))
        send(chunk({ content: 'CHAT QA COMPLETE' }, 'stop'))
      } else {
        send(chunk({ reasoning_content: '等待取消测试。' }))
        res.on('close', () => { waitingConnectionClosed = true })
        return
      }
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 60, completion_tokens_details: { reasoning_tokens: 20 } } })
      send('[DONE]')
    } else if (req.url === '/v1/responses') {
      const step = responsesStep++
      assert.equal(body.store, false)
      assert(body.include.includes('reasoning.encrypted_content'))
      if (step > 0) {
        assert(body.input.some((item) => item.encrypted_content === reasoning.encrypted_content))
        assert(body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'qa-echo'))
      }
      const output = step === 0 ? [reasoning, { type: 'function_call', id: 'fc-qa', call_id: 'qa-echo', name: 'echo', arguments: '{"text":"response tool result"}' }]
        : [{ type: 'message', id: 'msg-qa', role: 'assistant', content: [{ type: 'output_text', text: 'RESPONSES QA COMPLETE', annotations: [] }] }]
      send({ type: 'response.completed', response: { object: 'response', id: `resp-${step}`, model: body.model, status: 'completed', output,
        usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 20 } } } })
    } else if (req.url === '/v1/messages') {
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.equal(body.reasoning_effort, undefined)
      send({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } })
      // Some relays still send an empty thinking block. It must not leave an empty card.
      send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'empty-thinking-signature' } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'THINKING OFF VERIFIED' } })
      send({ type: 'content_block_stop', index: 1 })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      send({ type: 'message_stop' })
    } else throw new Error(`Unexpected path: ${req.url}`)
    res.end()
  } catch (error) {
    serverError = error
    res.end(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
let child
let cdp
let output = ''
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  child = spawn(electron, [process.cwd(), '--remote-debugging-port=0', `--user-data-dir=${join(qaDir, 'profile')}`], { cwd: qaDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const port = await until('debugging port', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1])
  const target = await until('renderer target', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((target) => target.type === 'page'))
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await until('preload', () => cdp.eval('typeof window.nextcowork === "object"'))
  const bootstrap = await cdp.invoke('app:getBootstrap')
  const workspace = bootstrap.workspaces[0]
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { permissionMode: 'ask', defaultThinking: 'high', webSearch: false } })
  for (const [protocol, model] of [['openai-chat', 'deepseek-qa'], ['openai-responses', 'gpt-qa'], ['anthropic', 'deepseek-v4-pro']]) {
    const id = `qa-${protocol}`
    await cdp.invoke('provider:upsert', { id, name: `QA ${protocol}`, protocol,
      baseUrl: protocol === 'anthropic' ? baseUrl.slice(0, -3) : baseUrl, credentialRef: '', priority: 0, enabled: true })
    await cdp.invoke('provider:setCredential', { providerId: id, apiKey: 'qa-not-a-real-api-key' })
    await cdp.invoke('provider:setAliases', { providerId: id, models: [model] })
    const [alias] = await cdp.invoke('provider:listModels', { providerId: id })
    if (protocol === 'anthropic') {
      assert.equal(alias.thinkingConfig.mode, 'effort')
      assert.equal(alias.capabilities.thinking, true)
      assert.deepEqual(alias.reasoningEfforts, ['none', 'low', 'high', 'max'])
      continue
    }
    await cdp.invoke('model:update', { ...alias, contextWindow: 200000, maxOutputTokens: 8192,
      capabilities: { ...alias.capabilities, tools: true, thinking: true }, thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' } })
  }
  await cdp.invoke('settings:update', { defaultModel: 'deepseek-qa', locale: 'zh-CN' })
  await until('chat model', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "deepseek-qa"'))
  await cdp.fill('[data-testid=composer-input]', '验证审批、提问和协议续轮。')
  await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
  await until('waiting status attached to the pending assistant reply', () => cdp.eval(`(() => {
    const status = document.querySelector('[data-testid=chat-status]');
    return status?.textContent.includes('正在等待回复') && !!status.closest('[data-testid=assistant-turn]')
      && !!status.closest('[data-testid=thread]');
  })()`))
  const waitingShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'chat-waiting.png'), Buffer.from(waitingShot.data, 'base64'))
  releaseFirstResponse()
  await until('permission card', () => cdp.eval('document.querySelector("[data-interaction-kind=tool_permission]") !== null'))
  assert.equal(await cdp.eval('!!document.querySelector("[data-interaction-kind=tool_permission]")?.closest("[data-testid=assistant-turn]")'), true)
  assert.equal(await stat(join(workspace.rootPath, 'agent-qa.txt')).then(() => true).catch(() => false), false)
  await cdp.eval('document.querySelector("[data-testid=thinking-block] button")?.click()')
  const permissionShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'chat-approval.png'), Buffer.from(permissionShot.data, 'base64'))
  const before = await cdp.invoke('app:getBootstrap')
  assert.equal(before.activeRuns.length, 1)
  await cdp.eval('window.qaBeforeReload = true')
  await cdp.send('Page.reload')
  await until('approval restored after reload', () => cdp.eval('window.qaBeforeReload === undefined && document.querySelector("[data-interaction-kind=tool_permission]") !== null'))
  await cdp.click('允许这一次')
  await until('question card', () => cdp.eval('document.querySelector("[data-interaction-kind=ask_user]") !== null'))
  assert.equal(await readFile(join(workspace.rootPath, 'agent-qa.txt'), 'utf8'), 'verified')
  await cdp.fill('[data-interaction-kind=ask_user] textarea', 'Beta')
  await cdp.click('提交回答')
  await until('plan card', () => cdp.eval('document.querySelector("[data-interaction-kind=plan_approval]") !== null'))
  const planShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'chat-plan.png'), Buffer.from(planShot.data, 'base64'))
  await cdp.click('批准方案')
  await until('chat done', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done" && document.body.innerText.includes("CHAT QA COMPLETE")'))
  await until('completed run process collapses', () => cdp.eval(`(() => {
    const block = document.querySelector('[data-testid=run-process-block]');
    return block?.dataset.open === 'false' && block.textContent.includes('用时');
  })()`))
  assert.equal(await cdp.eval(`(() => {
    const block = document.querySelector('[data-testid=run-process-block]');
    const answer = block?.nextElementSibling;
    return !!block && !block.textContent.includes('CHAT QA COMPLETE') && !!answer?.textContent.includes('CHAT QA COMPLETE');
  })()`), true)
  console.log('PASS: Chat SSE, reasoning_content, approval, reload recovery, file tool, question, plan review, continuation, and run summary collapse')
  assert.equal(titleRequests, 1)
  const firstSessionId = before.activeRuns[0].sessionId
  assert.equal((await cdp.invoke('sessions:get', { sessionId: firstSessionId })).session.title, '验证审批、提问和协议续轮。')
  const completedThread = await cdp.eval('document.querySelector("[data-testid=thread]").innerText')
  releaseFirstTitle()
  await until('generated title in sidebar and open tab after reload', () => cdp.eval(`document.body.innerText.split(${JSON.stringify(generatedTitle)}).length >= 3 && !![...document.querySelectorAll('[role=tab]')].find(tab => tab.title === ${JSON.stringify(generatedTitle)})`))
  assert.equal((await cdp.invoke('sessions:get', { sessionId: firstSessionId })).session.title, generatedTitle)
  assert.equal(await cdp.eval('document.querySelector("[data-testid=thread]").innerText'), completedThread)
  const titleShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'async-title-complete.png'), Buffer.from(titleShot.data, 'base64'))
  await cdp.invoke('sessions:rename', { sessionId: firstSessionId, title: '手动命名的会话' })
  await until('manual title synced', () => cdp.eval('document.body.innerText.split("手动命名的会话").length >= 3'))
  await cdp.eval('window.qaTitleReload = true')
  await cdp.send('Page.reload')
  await until('canonical title survives reload', () => cdp.eval('window.qaTitleReload === undefined && !![...document.querySelectorAll("[role=tab]")].find(tab => tab.title === "手动命名的会话")'))
  console.log('PASS: first-message title runs independently of the Agent, updates sidebar/tab after reload, and manual names persist')
  // Adjacent completed calls share a timeline group and close themselves once
  // every call has a durable result. Reopen the group to inspect the same cards.
  await until('completed run process collapses after reload', () => cdp.eval(`(() =>
    document.querySelector('[data-testid=run-process-block]')?.dataset.open === 'false'
  )()`))
  const collapsedToolsShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'tool-groups-collapsed.png'), Buffer.from(collapsedToolsShot.data, 'base64'))
  await cdp.eval(`document.querySelector('[data-testid=run-process-block] button')?.click()`)
  await until('completed tool group collapses after expanding run process', () => cdp.eval(`(() =>
    [...document.querySelectorAll('[data-testid=tool-group]')].some(group => group.dataset.collapsed === 'true')
  )()`))
  await cdp.eval(`[...document.querySelectorAll('[data-testid=tool-group][data-collapsed=true]')].forEach(button => button.click())`)
  await until('completed tool states survive reload', () => cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('[data-testid=tool-call]')];
    return cards.length === 3 && cards.every(card => card.dataset.toolStatus === 'ok');
  })()`))
  // A generic sessions:changed used to clear the tool table after completion.
  await cdp.invoke('sessions:setFavorited', { sessionId: firstSessionId, favorited: true })
  await delay(100)
  assert.deepEqual(await cdp.eval('[...document.querySelectorAll("[data-testid=tool-call]")].map(card => card.dataset.toolStatus)'), ['ok', 'ok', 'ok'])
  const saved = await cdp.invoke('sessions:get', { sessionId: firstSessionId })
  const expectedToolOutput = saved.messages.flatMap(message => message.parts).find(part => part.type === 'tool_result' && part.callId === 'qa-question').output.content
  await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('[data-testid=tool-call]')].find(card => card.querySelector('button').innerText.includes('AskUserQuestion'));
    if (card.querySelector('button').getAttribute('aria-expanded') === 'false') card.querySelector('button').click();
  })()`)
  await until('saved tool output visible when expanded', () => cdp.eval(`[...document.querySelectorAll('[data-testid=tool-call] pre')].some(block => block.textContent.includes(${JSON.stringify(expectedToolOutput)}))`))
  const restoredToolsShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'tool-results-restored.png'), Buffer.from(restoredToolsShot.data, 'base64'))
  console.log('PASS: completed tool states and expanded results survive renderer reload and session metadata refresh')

  await cdp.invoke('settings:update', { defaultModel: 'gpt-qa', locale: 'en-US' })
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { defaultModel: 'gpt-qa' } })
  await until('English locale', () => cdp.eval('document.documentElement.lang === "en-US"'))
  await cdp.click('New chat')
  await until('Responses model', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "gpt-qa"'))
  await cdp.fill('[data-testid=composer-input]', 'Verify Responses tool continuation.')
  await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
  await until('Responses done', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done" && document.body.innerText.includes("RESPONSES QA COMPLETE")'))
  await until('Responses title', () => cdp.eval('!![...document.querySelectorAll("[role=tab]")].find(tab => tab.title === "Responses continuation check")'))
  const responsesShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'responses-complete.png'), Buffer.from(responsesShot.data, 'base64'))
  console.log('PASS: Responses, encrypted reasoning replay, tool output and English UI')

  await cdp.invoke('settings:update', { defaultModel: 'deepseek-qa' })
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { defaultModel: 'deepseek-qa' } })
  await cdp.click('New chat')
  await until('cancel model', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "deepseek-qa"'))
  await cdp.fill('[data-testid=composer-input]', 'Verify stopping a live stream.')
  await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
  await until('thinking stream', () => cdp.eval('document.body.innerText.includes("等待取消测试")'))
  await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
  await until('aborted', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "aborted"'))
  await until('upstream connection closed', () => waitingConnectionClosed)
  assert.equal(serverError, undefined)
  console.log('PASS: stop closes the upstream connection and preserves partial thinking')

  await cdp.invoke('settings:update', { defaultModel: 'deepseek-v4-pro' })
  await cdp.invoke('workspace:update', { id: workspace.id, settings: { defaultModel: 'deepseek-v4-pro', defaultThinking: 'off' } })
  await cdp.click('New chat')
  await until('catalogue model selected', () => cdp.eval('document.querySelector("[data-testid=composer-send]")?.title === "deepseek-v4-pro"'))
  await cdp.fill('[data-testid=composer-input]', 'Verify that thinking is disabled.')
  await cdp.eval('document.querySelector("[data-testid=composer-send]").click()')
  await until('thinking off response', () => cdp.eval('document.querySelector("[data-testid=chat-status]")?.dataset.status === "done" && document.body.innerText.includes("THINKING OFF VERIFIED")'))
  await until('Anthropic title', () => cdp.eval('!![...document.querySelectorAll("[role=tab]")].find(tab => tab.title === "Thinking preference check")'))
  assert.equal(await cdp.eval('document.querySelector("[data-testid=thinking-block]") === null'), true)
  assert.equal(await cdp.eval('!!document.querySelector("[data-testid=chat-status]")?.closest("[data-testid=assistant-turn]")'), true)
  const offShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(qaDir, 'thinking-off-complete.png'), Buffer.from(offShot.data, 'base64'))
  assert.equal(serverError, undefined)
  console.log('PASS: explicit Off reaches the Anthropic relay with inherited metadata, empty thinking stays hidden, and status follows the reply')
  assert.equal(titleRequests, 4)
  console.log(JSON.stringify({ requests: requests.length, titleRequests, screenshots: ['chat-waiting.png', 'chat-approval.png', 'chat-plan.png', 'async-title-complete.png', 'tool-groups-collapsed.png', 'tool-results-restored.png', 'responses-complete.png', 'thinking-off-complete.png'].map((name) => join(qaDir, name)), isolatedData: qaDir }, null, 2))
} catch (error) {
  console.error(error)
  console.error(`QA artifacts: ${qaDir}`)
  if (cdp) console.error(await cdp.eval('document.body.innerText').catch(() => 'Renderer unavailable'))
  console.error(output.slice(-7000))
  process.exitCode = 1
} finally {
  releaseFirstResponse()
  releaseFirstTitle()
  cdp?.ws.close()
  child?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
