import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import electron from 'electron'

const project = resolve(import.meta.dirname, '..')
const directory = await realpath(await mkdtemp(join(tmpdir(), 'nextcowork-responsiveness-')))
const label = process.argv.find((value) => value.startsWith('--label='))?.slice(8) ?? 'baseline'
const samples = Number(process.argv.find((value) => value.startsWith('--samples='))?.slice(10) ?? 20)
assert(Number.isInteger(samples) && samples > 0 && samples <= 100)
const scenario = process.argv.find((value) => value.startsWith('--scenario='))?.slice(11) ?? 'delete-inactive'
assert(['delete-inactive', 'delete-current', 'delete-current-cold', 'send', 'send-open-stream', 'stop-before-response', 'stop-stream'].includes(scenario))
const sending = ['send', 'send-open-stream', 'stop-before-response', 'stop-stream'].includes(scenario)
const stopping = scenario === 'stop-before-response' || scenario === 'stop-stream'
const deletingCurrent = scenario === 'delete-current' || scenario === 'delete-current-cold'
const attachmentCount = Number(process.argv.find((value) => value.startsWith('--attachments='))?.slice(14) ?? 0)
assert(Number.isInteger(attachmentCount) && attachmentCount >= 0 && attachmentCount <= 500)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE
delete env.ELECTRON_RENDERER_URL

let socket
let upstream
let sequence = 0
const pending = new Map()
const errors = []
let output = ''
let stage = 'launch'
const child = spawn(electron, [project, '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`], {
  cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe']
})
const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
const ready = new Promise((resolveReady, reject) => {
  const deadline = setTimeout(() => reject(new Error('Electron debugging endpoint did not start')), 30000)
  child.once('error', reject)
  child.once('exit', () => reject(new Error('Electron exited before debugging was ready')))
  const receive = (data) => {
    output += data
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]
    if (port) { clearTimeout(deadline); resolveReady(port) }
  }
  child.stdout.on('data', receive)
  child.stderr.on('data', receive)
})

function command(method, params = {}) {
  const id = ++sequence
  return new Promise((resolveCommand, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 60000)
    pending.set(id, { resolve: resolveCommand, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Renderer evaluation failed')
  return result.result.value
}

async function invoke(channel, request) {
  const result = await evaluate(`window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`)
  assert(result.ok, `${channel}: ${result.error?.message}`)
  return result.data
}

async function waitFor(expression) {
  return evaluate(`new Promise((done, fail) => {
    const deadline = performance.now() + 60000;
    const check = () => {
      if (${expression}) done();
      else if (performance.now() > deadline) fail(new Error('Renderer condition timed out'));
      else requestAnimationFrame(check);
    };
    check();
  })`)
}

async function frames() {
  await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
}

function history(prefix, toolCount) {
  const messages = []
  const message = (suffix, role, parts) => ({ id: `${prefix}-${suffix}`, role, parts, createdAt: messages.length + 1, schemaVersion: 1 })
  messages.push(message('question', 'user', [{ type: 'text', text: prefix }]))
  for (let index = 0; index < toolCount; index++) {
    const callId = `${prefix}-call-${index}`
    messages.push(message(`call-${index}`, 'assistant', [
      { type: 'text', text: `Inspected **sample-${index}.ts**.\n\n- Source verified\n- Result available` },
      { type: 'tool_call', callId, name: 'Read', input: { path: `sample-${index}.ts` } }
    ]))
    messages.push(message(`result-${index}`, 'user', [{ type: 'tool_result', callId, output: { content: 'Synthetic result' }, isError: false }]))
  }
  messages.push(message('answer', 'assistant', [{ type: 'text', text: `${prefix} complete` }]))
  return messages
}

const sessionButton = (title) => `[...document.querySelectorAll('aside button')].find(button => button.textContent.trim() === ${JSON.stringify(title)})`

async function selectSession(title) {
  await waitFor(sessionButton(title))
  await evaluate(`${sessionButton(title)}.click()`)
  await waitFor(`document.querySelector('[data-testid=thread]')?.textContent.includes(${JSON.stringify(`${title} complete`)})`)
  await frames()
}

try {
  const port = await ready
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = targets.find((entry) => entry.type === 'page')
  assert(target, 'Electron has no renderer target')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    const item = pending.get(message.id)
    if (!item) return
    clearTimeout(item.timeout)
    pending.delete(message.id)
    if (message.error) item.reject(new Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  })
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await command('Runtime.enable')
  await command('Page.enable')
  await evaluate(`new Promise((done) => {
    if (document.readyState === 'complete') done();
    else window.addEventListener('load', () => done(), { once: true });
  })`)
  const bootstrap = await invoke('app:getBootstrap')
  stage = 'bootstrap'
  assert(bootstrap.workspaces.every((workspace) => resolve(workspace.rootPath).startsWith(`${directory}/`)), 'Workspace escaped the isolated directory')
  await waitFor("document.querySelector('[data-testid=composer-input]') || document.querySelectorAll('main button').length >= 2")
  await evaluate("if (!document.querySelector('[data-testid=composer-input]')) document.querySelectorAll('main button')[1].click()")
  await waitFor("document.querySelector('[data-testid=composer-input]')")
  await invoke('settings:update', { locale: 'en-US' })
  const workspace = bootstrap.workspaces[0]
  assert(workspace)
  const toolCount = Number(process.argv.find((value) => value.startsWith('--tools='))?.slice(8) ?? 1000)
  assert(Number.isInteger(toolCount) && toolCount > 0 && toolCount <= 5000)
  const histories = []
  stage = 'seed-history'
  for (const title of ['QA history A', 'QA history B']) {
    const session = await invoke('sessions:create', { workspaceId: workspace.id, title })
    await invoke('sessions:replaceHistory', { sessionId: session.id, messages: history(title, toolCount) })
    histories.push(session)
  }
  const deletions = []
  for (let index = 0; scenario === 'delete-inactive' && index < samples; index++) {
    deletions.push(await invoke('sessions:create', { workspaceId: workspace.id, title: `QA delete ${index}` }))
  }
  if (sending) {
    stage = 'configure-model'
    let responseIndex = 0
    upstream = createServer(async (request, response) => {
      try {
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw)
        assert.equal(request.headers.authorization, 'Bearer qa-local-only')
        const requestIndex = responseIndex++
        const content = `QA reply ${requestIndex}`
        response.once('close', () => upstream.emit('qa:closed', requestIndex))
        upstream.emit('qa:request', requestIndex)
        if (scenario === 'stop-before-response') return
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: stopping ? null : 'stop' }] })}\n\n`)
        if (stopping) return
        response.write('data: [DONE]\n\n')
        if (scenario !== 'send-open-stream') response.end()
      } catch (error) {
        errors.push(String(error))
        response.destroy(error)
      }
    })
    await new Promise((done, fail) => { upstream.once('error', fail); upstream.listen(0, '127.0.0.1', done) })
    await invoke('provider:upsert', { id: 'responsiveness-qa', name: 'Responsiveness QA', protocol: 'openai-chat',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, credentialRef: '', priority: 0, enabled: true })
    await invoke('provider:setCredential', { providerId: 'responsiveness-qa', apiKey: 'qa-local-only' })
    await invoke('provider:setAliases', { providerId: 'responsiveness-qa', models: ['qa-responsiveness'] })
    const [alias] = await invoke('provider:listModels', { providerId: 'responsiveness-qa' })
    await invoke('model:update', { ...alias, contextWindow: 2000000, maxOutputTokens: 4096 })
    await invoke('workspace:update', { id: workspace.id, settings: { defaultModel: 'qa-responsiveness',
      defaultModelProviderId: 'responsiveness-qa', webSearch: false } })
    await invoke('settings:update', { defaultModel: 'qa-responsiveness', defaultModelProviderId: 'responsiveness-qa' })
    await frames()
  }
  await selectSession(histories[0].title)
  await selectSession(histories[1].title)
  if (sending) {
    stage = 'model-ready'
    await waitFor("document.querySelector('[data-testid=composer-send]')?.title === 'qa-responsiveness'")
  }
  await evaluate(`window.qaLongTasks = [];
    window.qaObserver = new PerformanceObserver(list => window.qaLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))));
    window.qaObserver.observe({ type: 'longtask', buffered: false });`)
  await command('Profiler.enable')
  await command('Profiler.start')
  const timings = []
  if (sending) {
    for (let index = 0; index < samples; index++) {
      stage = `reset-history-${index}`
      await invoke('sessions:replaceHistory', { sessionId: histories[1].id, messages: history(histories[1].title, toolCount) })
      await waitFor(`!document.querySelector('[data-testid=thread]')?.textContent.includes('QA reply')`)
      await frames()
      stage = `fill-draft-${index}`
      await evaluate("document.querySelector('[data-testid=composer-input]').focus()")
      await command('Input.insertText', { text: `QA send ${index}` })
      await frames()
      stage = `send-${index}`
      if (stopping) {
        const requested = once(upstream, 'qa:request', { signal: globalThis.AbortSignal.timeout(60000) })
        const closed = once(upstream, 'qa:closed', { signal: globalThis.AbortSignal.timeout(60000) })
        const connection = closed.then(([requestIndex]) => ({ requestIndex }), (error) => ({ error }))
        await evaluate("document.querySelector('[data-testid=composer-send]').click()")
        assert.equal((await requested)[0], index)
        if (scenario === 'stop-stream') {
          await waitFor(`document.querySelector('[data-testid=thread]')?.textContent.includes(${JSON.stringify(`QA reply ${index}`)})`)
        }
        await waitFor("document.querySelector('[data-testid=chat-status]')?.dataset.status === 'running'")
        await frames()
        stage = `stop-${index}`
        const timing = await evaluate(`new Promise((done, fail) => {
          window.qaLongTasks = [];
          const begin = performance.now();
          let previous = begin;
          let maxFrameGap = 0;
          const tick = () => {
            const now = performance.now();
            maxFrameGap = Math.max(maxFrameGap, now - previous);
            previous = now;
            if (document.querySelector('[data-testid=chat-status]')?.dataset.status === 'aborted') {
              const feedbackMs = now - begin;
              requestAnimationFrame(() => done({ feedbackMs, completeMs: performance.now() - begin, maxFrameGap, longTasks: window.qaLongTasks }));
            } else if (now - begin > 5000) fail(new Error('Stop did not complete within 5 seconds'));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          document.querySelector('[data-testid=composer-send]').click();
        })`)
        const disconnected = await connection
        assert.equal(disconnected.requestIndex, index, String(disconnected.error ?? 'Stopped request connection did not close'))
        if (scenario === 'stop-stream') {
          assert(await evaluate(`document.querySelector('[data-testid=thread]')?.textContent.includes(${JSON.stringify(`QA reply ${index}`)})`), 'Partial response was lost after stopping')
        }
        timings.push({ ...timing, requestClosed: true })
        continue
      }
      timings.push(await evaluate(`new Promise((done, fail) => {
        window.qaLongTasks = [];
        const existing = new Set(document.querySelectorAll('.agent-markdown'));
        const begin = performance.now();
        let feedbackMs;
        let previous = begin;
        let maxFrameGap = 0;
        const tick = () => {
          const now = performance.now();
          const text = document.querySelector('[data-testid=thread]')?.textContent ?? '';
          if (text.includes(${JSON.stringify(`QA send ${index}`)})) feedbackMs ??= now - begin;
          maxFrameGap = Math.max(maxFrameGap, now - previous);
          previous = now;
          if (text.includes(${JSON.stringify(`QA reply ${index}`)}) && document.querySelector('[data-testid=chat-status]')?.dataset.status === 'done') {
            requestAnimationFrame(() => done({ feedbackMs, completeMs: performance.now() - begin, maxFrameGap,
              historyMarkdownMounts: [...document.querySelectorAll('.agent-markdown')].filter(node => !existing.has(node) && (node.textContent.includes('Inspected') || node.textContent.includes('QA history B complete'))).length,
              longTasks: window.qaLongTasks }));
          } else if (now - begin > 60000) fail(new Error('Send timed out'));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        document.querySelector('[data-testid=composer-send]').click();
      })`))
    }
  }
  for (let index = 0; !sending && index < samples; index++) {
    stage = `delete-${index}`
    let replacement = histories[1]
    if (scenario === 'delete-current-cold') {
      replacement = await invoke('sessions:create', { workspaceId: workspace.id, title: `QA cold ${index}` })
      await invoke('sessions:replaceHistory', { sessionId: replacement.id, messages: history(replacement.title, toolCount) })
    }
    const session = deletingCurrent
      ? await invoke('sessions:create', { workspaceId: workspace.id, title: `QA delete ${index}` })
      : deletions[index]
    if (attachmentCount > 0) {
      await evaluate(`(async () => {
        const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
        for (let index = 0; index < ${attachmentCount}; index++) {
          const bytes = new Uint8Array(image.length + 4);
          bytes.set(image);
          new DataView(bytes.buffer).setUint32(image.length, index);
          const result = await window.nextcowork.invoke('attachment:upload', {
            scope: 'session', ownerId: ${JSON.stringify(session.id)}, displayName: 'QA image ' + index, mime: 'image/png', bytes
          });
          if (!result.ok) throw new Error(result.error.message);
        }
      })()`)
    }
    if (deletingCurrent) {
      await invoke('sessions:replaceHistory', { sessionId: session.id, messages: history(session.title, 0) })
      await selectSession(session.title)
    }
    stage = `delete-menu-${index}`
    await evaluate(`${sessionButton(session.title)}.scrollIntoView({ block: 'nearest' })`)
    await frames()
    await evaluate(`(() => {
      const button = ${sessionButton(session.title)};
      const bounds = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: bounds.left + 20, clientY: bounds.top + 10 }));
    })()`)
    await waitFor("document.querySelector('[role=menuitem]')")
    await evaluate("[...document.querySelectorAll('[role=menuitem]')].at(-1).click()")
    await waitFor("[...document.querySelectorAll('[role=menuitem]')].at(-1)?.textContent.includes('Confirm')")
    await frames()
    stage = `delete-confirm-${index}`
    timings.push(await evaluate(`new Promise((done, fail) => {
      window.qaLongTasks = [];
      const begin = performance.now();
      let feedbackMs;
      let visibleFeedbackMs;
      let previous = begin;
      let maxFrameGap = 0;
      const tick = () => {
        const now = performance.now();
        feedbackMs ??= now - begin;
        maxFrameGap = Math.max(maxFrameGap, now - previous);
        previous = now;
        const deleted = !document.querySelector('[role=menuitem]') && !${sessionButton(session.title)};
        if (deleted) visibleFeedbackMs ??= now - begin;
        if (deleted && (${!deletingCurrent} || document.querySelector('[data-testid=thread]')?.textContent.includes(${JSON.stringify(`${replacement.title} complete`)}))) {
          requestAnimationFrame(() => done({ feedbackMs, visibleFeedbackMs, completeMs: performance.now() - begin, maxFrameGap, longTasks: window.qaLongTasks }));
        } else if (now - begin > 60000) fail(new Error('Deletion timed out'));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      [...document.querySelectorAll('[role=menuitem]')].at(-1).click();
    })`))
    if (scenario === 'delete-current-cold') {
      await invoke('sessions:delete', { sessionId: replacement.id })
      await waitFor(`!${sessionButton(replacement.title)}`)
      await frames()
    }
  }
  const profile = await command('Profiler.stop')
  await writeFile(join(directory, `${label}.cpuprofile`), JSON.stringify(profile.profile))
  const screenshot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(directory, `${label}.png`), Buffer.from(screenshot.data, 'base64'))
  const sorted = timings.map((entry) => entry.maxFrameGap).sort((first, second) => first - second)
  const result = {
    label, samples, toolCount, attachmentCount, directory, versions: bootstrap.versions,
    scenario,
    maxFrameGapP50: sorted[Math.floor(sorted.length * 0.5)],
    maxFrameGapP95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    timings,
    errors
  }
  await writeFile(join(directory, `${label}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  assert.equal(errors.length, 0, 'Probe recorded runtime errors')
} catch (error) {
  console.error(error)
  console.error(`Probe stage: ${stage}`)
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      console.error(await evaluate(`({ button: document.querySelector('[data-testid=composer-send]')?.outerHTML,
        draft: document.querySelector('[data-testid=composer-input]')?.textContent,
        status: document.querySelector('[data-testid=chat-status]')?.dataset,
        tail: document.querySelector('[data-testid=thread]')?.textContent.slice(-1000) })`))
      const screenshot = await command('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(directory, `${label}-failure.png`), Buffer.from(screenshot.data, 'base64'))
    } catch (diagnosticError) { console.error(`Probe diagnostics failed: ${String(diagnosticError)}`) }
  }
  console.error(output.slice(-3000))
  console.error(`Isolated artifacts: ${directory}`)
  process.exitCode = 1
} finally {
  for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Probe closed')) }
  socket?.close()
  child.kill('SIGTERM')
  await exited
  upstream?.closeAllConnections()
  if (upstream) await new Promise((done) => upstream.close(done))
}