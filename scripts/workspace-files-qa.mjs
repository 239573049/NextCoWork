/**
 * Production Electron acceptance for workspace previews, editing, and file management.
 * Run after `npm run build`: node scripts/workspace-files-qa.mjs
 * Every fixture and Electron profile lives below one retained mkdtemp directory.
 * Only this script's Electron child is terminated; fixtures/screenshots remain for review.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { clearTimeout, setTimeout } from 'node:timers'
import electron from 'electron'

const VIEWPORT = { width: 1535, height: 1024 }
const MOD = process.platform === 'darwin' ? 4 : 2
const checks = []
const screenshots = []
const trashedFixtures = []
const processOutput = []
let child
let cdp
let isolatedProject
let workspaceRoot
let outputDirectory
let currentStep = 'launch'

class Cdp {
  #socket
  #nextId = 0
  #pending = new Map()
  closed = false
  exceptions = []

  static async attach(url) {
    const client = new Cdp()
    client.#socket = new WebSocket(url)
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') client.exceptions.push(message.params)
      const pending = client.#pending.get(message.id)
      if (!pending) return
      client.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    client.#socket.addEventListener('close', () => {
      client.closed = true
      for (const pending of client.#pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('CDP target closed'))
      }
      client.#pending.clear()
    })
    await new Promise((resolveOpen, reject) => {
      client.#socket.addEventListener('open', resolveOpen, { once: true })
      client.#socket.addEventListener('error', reject, { once: true })
    })
    return client
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP target is closed'))
    const id = ++this.#nextId
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20_000)
      this.#pending.set(id, { resolve: resolveSend, reject, timer })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Page execution failed')
    return result.result.value
  }

  async invoke(channel, request) {
    const result = await this.eval(`window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request ?? null)})`)
    if (!result?.ok) throw new Error(`${channel}: ${JSON.stringify(result?.error)}`)
    return result.data
  }

  close() { this.#socket.close() }
}

async function until(label, probe, timeoutMs = 20_000, allowExited = false) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!allowExited && child && child.exitCode !== null) throw new Error(`Electron exited during ${label}: ${child.exitCode}`)
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await sleep(100)
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const port = server.address().port
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

function ensureInside(parent, candidate) {
  const rel = relative(parent, candidate)
  assert(rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), `Refusing path outside isolated fixture root: ${candidate}`)
  return candidate
}

async function fixture(path, content) {
  const destination = ensureInside(workspaceRoot, resolve(workspaceRoot, path))
  await mkdir(dirname(destination), { recursive: true })
  ensureInside(isolatedProject, await realpath(dirname(destination)))
  await writeFile(destination, content)
}

async function disk(path) {
  return readFile(ensureInside(workspaceRoot, resolve(workspaceRoot, path)), 'utf8')
}

async function exists(path) {
  try { await stat(ensureInside(workspaceRoot, resolve(workspaceRoot, path))); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

const documentSelector = '[data-testid="document-view"]'
const treeRow = (path) => `[role="treeitem"][title=${JSON.stringify(path)}]`
const dialogSelector = '[role="dialog"]'

async function click(selector) {
  await until(`click ${selector}`, () => cdp.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element || element.disabled) return false
    element.scrollIntoView({ block: 'nearest' })
    element.click()
    return true
  })()`))
}

async function clickText(text, scope = 'body') {
  await until(`button ${text}`, () => cdp.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)})
    const element = [...(root?.querySelectorAll('button') ?? [])].find((button) => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled)
    if (!element) return false
    element.click()
    return true
  })()`))
}

async function press(key, code, modifiers = 0, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode })
}

async function replaceInput(selector, text) {
  await until(`input ${selector}`, () => cdp.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input || input.disabled) return false
    input.focus()
    return true
  })()`))
  await press('a', 'KeyA', MOD, 65)
  await cdp.send('Input.insertText', { text })
}

async function replaceEditor(text) {
  await replaceInput(`${documentSelector} .cm-content[contenteditable="true"]`, text)
  await until('editor changed', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('未保存') || document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('Unsaved changes')`))
}

async function openFile(path) {
  await click(treeRow(path))
  await until(`document ${path}`, () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.getAttribute('aria-label') === ${JSON.stringify(path)} && !document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('加载中…')`))
}

async function rowPresent(path) { return cdp.eval(`document.querySelector(${JSON.stringify(treeRow(path))}) !== null`) }

async function screenshot(name) {
  await sleep(250)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const path = ensureInside(isolatedProject, join(outputDirectory, `${name}.png`))
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  screenshots.push(path)
  return path
}

async function step(name, fn) {
  currentStep = name
  await fn()
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function rootMenu(action) {
  await until('file toolbar', () => cdp.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => ['更多操作', 'More actions', '新建文件', 'New file'].includes(element.getAttribute('aria-label')) && element.hasAttribute('aria-haspopup'))
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`))
  await clickText(action, '[role="menu"]')
}

async function itemMenu(path, action) {
  await click(`${treeRow(path)} button[aria-haspopup="menu"]`)
  await clickText(action, '[role="menu"]')
}

async function submitDialog(value, label) {
  if (value !== null) await replaceInput(`${dialogSelector} input`, value)
  await clickText(label, dialogSelector)
}

async function waitDialogClosed() {
  await until('dialog closed', () => cdp.eval(`document.querySelector('[role="dialog"]') === null`))
}

try {
  await stat(join(process.cwd(), 'out/main/index.js'))
  isolatedProject = await realpath(await mkdtemp(join(tmpdir(), 'nextcowork-files-qa-')))
  outputDirectory = join(isolatedProject, 'qa-output')
  await mkdir(outputDirectory)
  console.log(`QA_DIRECTORY=${isolatedProject}`)
  const port = await freePort()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_RENDERER_URL
  child = spawn(electron, [process.cwd(), `--remote-debugging-port=${port}`, `--user-data-dir=${join(isolatedProject, '.electron-user-data')}`], {
    cwd: isolatedProject, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => processOutput.push(String(chunk)))
  child.stderr.on('data', (chunk) => processOutput.push(String(chunk)))

  const target = await until('Electron renderer', async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch { return null }
  })
  cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })
  await until('preload bridge', () => cdp.eval('typeof window.nextcowork === "object"'))
  const bootstrap = await cdp.invoke('app:getBootstrap')
  assert(bootstrap.workspaces.length > 0, 'Expected an isolated default workspace')
  const workspace = bootstrap.workspaces[0]
  workspaceRoot = ensureInside(isolatedProject, await realpath(workspace.rootPath))
  console.log(`FIXTURE_WORKSPACE=${workspaceRoot}`)

  const originalMarkdown = '# Workspace preview QA\n\nA **bold** note, *emphasis*, and `inline code`.\n\n- Preview images\n- Edit and save files\n\n| Feature | Status |\n| --- | --- |\n| Markdown | Ready |\n| Code editor | Ready |\n\n```typescript\nconst answer: number = 42\nconsole.log(answer)\n```\n\n![QA preview](./preview.svg)\n\n[Open notes](./notes.txt)\n'
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="140"><rect width="480" height="140" rx="18" fill="#d9e9df"/><circle cx="68" cy="70" r="34" fill="#2d6a4f"/><path d="m51 70 12 12 22-26" fill="none" stroke="white" stroke-width="7"/><text x="124" y="80" fill="#244b38" font-family="sans-serif" font-size="28">Workspace preview</text></svg>'
  const originalCode = 'export type GreetingProps = { name: string }\n\nexport function Greeting({ name }: GreetingProps) {\n  return <h1>Hello, {name}</h1>\n}\n'
  await fixture('preview.md', originalMarkdown)
  await fixture('preview.svg', svg)
  await fixture('greeting.tsx', originalCode)
  await fixture('notes.txt', 'Plain text fixture\nSecond line\n')
  await fixture('opaque.bin', Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x00, 0x90]))
  await fixture('utf16.txt', Buffer.from([0xff, 0xfe, 0x41, 0x00]))
  await fixture('too-large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 65))
  await fixture('archive/.keep', '')
  await cdp.invoke('settings:update', { theme: 'light', locale: 'zh-CN' })
  await until('Chinese light theme', () => cdp.eval('document.documentElement.lang === "zh-CN" && document.documentElement.dataset.theme === "light"'))
  await until('workspace shell', () => cdp.eval('document.querySelector("button[aria-label=工作区文件]") !== null'))
  if (!(await cdp.eval('document.querySelector("button[aria-label=更多操作], button[aria-label=新建文件]") !== null'))) {
    await click('button[aria-label="工作区文件"]')
  } else if (!(await rowPresent('preview.md'))) {
    await rootMenu('刷新')
  }
  await until('fixture file tree', () => rowPresent('preview.md'))

  await step('Markdown headings, list, table, code, links, and relative image render', async () => {
    await openFile('preview.md')
    await until('Markdown features', () => cdp.eval(`(() => {
      const preview = document.querySelector('.markdown-preview')
      const image = preview?.querySelector('img')
      return preview?.querySelector('h1')?.textContent === 'Workspace preview QA' && preview.querySelector('ul li') && preview.querySelectorAll('table tr').length === 3 && preview.querySelector('.markdown-code-source .tok-keyword') && preview.querySelector('a') && image?.complete && image.naturalWidth > 0
    })()`))
    await screenshot('01-markdown-preview-zh')
  })

  const savedMarkdown = `${originalMarkdown}\n## Saved from the built-in editor\n`
  await step('Markdown source editing and save update the file on disk', async () => {
    await clickText('源码模式', documentSelector)
    await replaceEditor(savedMarkdown)
    await screenshot('02-markdown-source-unsaved-zh')
    await clickText('保存', documentSelector)
    await until('Markdown disk save', async () => (await disk('preview.md')) === savedMarkdown)
    await until('saved status', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('已保存')`))
    await clickText('渲染预览', documentSelector)
    await until('saved Markdown heading', () => cdp.eval(`document.querySelector('.markdown-preview')?.textContent.includes('Saved from the built-in editor')`))
  })

  await step('Relative Markdown links open workspace files', async () => {
    await click('.markdown-preview a')
    await until('linked text document', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.getAttribute('aria-label') === 'notes.txt' && !!document.querySelector('.cm-content')`))
  })

  await step('Code syntax highlighting, line numbers, editing, and keyboard save', async () => {
    await openFile('greeting.tsx')
    await until('code highlighting and line numbers', () => cdp.eval(`document.querySelectorAll('.cm-line span').length > 3 && document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length > 2`))
    const edited = originalCode.replace('Hello,', 'Welcome,')
    await replaceEditor(edited)
    await press('s', 'KeyS', MOD, 83)
    await until('code disk save', async () => (await disk('greeting.tsx')) === edited)
    await screenshot('03-code-editor-zh')
  })

  await step('Unsaved drafts survive file switching and close cancellation', async () => {
    await openFile('preview.md')
    await clickText('源码模式', documentSelector)
    await replaceEditor(`${savedMarkdown}\nDraft that must survive switching\n`)
    await openFile('notes.txt')
    await openFile('preview.md')
    assert(await cdp.eval(`document.querySelector('.cm-content')?.textContent.includes('Draft that must survive switching')`))
    await click('button[aria-label="关闭 preview.md"]')
    await until('unsaved confirmation', () => cdp.eval(`document.querySelector('[role="dialog"]')?.textContent.includes('有未保存的修改')`))
    await screenshot('04-unsaved-confirmation-zh')
    await clickText('取消', dialogSelector)
    await waitDialogClosed()
    assert(await cdp.eval(`document.querySelector('.cm-content')?.textContent.includes('Draft that must survive switching')`))
    assert.equal(await disk('preview.md'), savedMarkdown)
    await click('button[aria-label="关闭 preview.md"]')
    await clickText('放弃修改', dialogSelector)
    await until('discarded tab closed', () => cdp.eval(`document.querySelector('button[aria-label="关闭 preview.md"]') === null`))
    await openFile('preview.md')
    assert.equal(await disk('preview.md'), savedMarkdown)
    assert(!(await cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('Draft that must survive switching')`)))
  })

  await step('Image preview and binary, encoding, and size fallbacks', async () => {
    await openFile('preview.svg')
    await until('image preview loaded', () => cdp.eval(`(() => { const image = document.querySelector(${JSON.stringify(`${documentSelector} img`)}); return image?.complete && image.naturalWidth > 0 })()`))
    await screenshot('05-image-preview-zh')
    await openFile('opaque.bin')
    await until('binary fallback', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('二进制')`))
    await screenshot('06-binary-fallback-zh')
    await openFile('utf16.txt')
    await until('encoding fallback', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('不是有效的 UTF-8')`))
    await openFile('too-large.txt')
    await until('size fallback', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('文件过大')`))
  })

  await step('Create folder and file through the file toolbar and row menu', async () => {
    await rootMenu('新建文件夹')
    await submitDialog('created-folder', '创建')
    await waitDialogClosed()
    await until('created folder refreshed', () => rowPresent('created-folder'))
    assert(await exists('created-folder'))
    await itemMenu('created-folder', '新建文件')
    await submitDialog('draft.md', '创建')
    await waitDialogClosed()
    await until('new file opened', () => cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.getAttribute('aria-label') === 'created-folder/draft.md'`))
    await clickText('源码模式', documentSelector)
    await replaceEditor('# Created from the file menu\n')
    await clickText('保存', documentSelector)
    await until('new file saved', async () => (await disk('created-folder/draft.md')) === '# Created from the file menu\n')
    await click(treeRow('created-folder'))
    await until('new child visible', () => rowPresent('created-folder/draft.md'))
  })

  await step('Rename updates the file tree and open document tab', async () => {
    await itemMenu('created-folder/draft.md', '重命名')
    await submitDialog('renamed.md', '重命名')
    await waitDialogClosed()
    await until('renamed item refreshed', () => rowPresent('created-folder/renamed.md'))
    assert(!(await exists('created-folder/draft.md')))
    assert(await exists('created-folder/renamed.md'))
    assert(await cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.getAttribute('aria-label') === 'created-folder/renamed.md'`))
  })

  await step('Copy and move use full workspace-relative destinations', async () => {
    await itemMenu('created-folder/renamed.md', '复制到…')
    await submitDialog('archive/copied.md', '复制')
    await waitDialogClosed()
    assert.equal(await disk('archive/copied.md'), '# Created from the file menu\n')
    await itemMenu('created-folder/renamed.md', '移动到…')
    await submitDialog('archive/moved.md', '移动')
    await waitDialogClosed()
    await until('source removed from tree', async () => !(await rowPresent('created-folder/renamed.md')))
    assert(!(await exists('created-folder/renamed.md')))
    assert(await exists('archive/moved.md'))
    await click(treeRow('archive'))
    await until('moved destination refreshed', () => rowPresent('archive/moved.md'))
    assert(await rowPresent('archive/copied.md'))
    assert(await cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.getAttribute('aria-label') === 'archive/moved.md'`))
    await screenshot('07-file-management-zh')
  })

  await step('Existing destinations show an error without overwriting data', async () => {
    await itemMenu('archive/moved.md', '复制到…')
    await submitDialog('archive/copied.md', '复制')
    await until('existing target error', () => cdp.eval(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('目标名称已存在')`))
    assert.equal(await disk('archive/copied.md'), '# Created from the file menu\n')
    await clickText('取消', dialogSelector)
    await waitDialogClosed()
  })

  await step('Delete requires confirmation, supports cancellation, and refreshes automatically', async () => {
    await itemMenu('archive/copied.md', '移入回收站')
    await until('Trash confirmation', () => cdp.eval(`document.querySelector('[role="dialog"]')?.textContent.includes('可从回收站恢复')`))
    await screenshot('08-delete-confirmation-zh')
    await clickText('取消', dialogSelector)
    await waitDialogClosed()
    assert(await exists('archive/copied.md'))
    await itemMenu('archive/copied.md', '移入回收站')
    await submitDialog(null, '移入回收站')
    await waitDialogClosed()
    await until('deleted item removed', async () => !(await rowPresent('archive/copied.md')) && !(await exists('archive/copied.md')))
    trashedFixtures.push({ path: join(workspaceRoot, 'archive/copied.md'), recovery: 'System Trash; test fixture only, no user project files affected.' })
  })

  await step('External modification conflict preserves the disk file and local draft', async () => {
    await openFile('notes.txt')
    await replaceEditor('Unsaved local edit\n')
    await fixture('notes.txt', 'External edit kept on disk\n')
    await clickText('保存', documentSelector)
    await until('save conflict', () => cdp.eval(`document.querySelector(${JSON.stringify(`${documentSelector} [role="alert"]`)})?.textContent.includes('文件已被其他程序修改')`))
    assert.equal(await disk('notes.txt'), 'External edit kept on disk\n')
    assert(await cdp.eval(`document.querySelector('.cm-content')?.textContent.includes('Unsaved local edit')`))
    await click(`${documentSelector} button[aria-label="重新读取文件"]`)
    await clickText('放弃修改', dialogSelector)
    await waitDialogClosed()
    await until('external content reloaded', () => cdp.eval(`document.querySelector('.cm-content')?.textContent.includes('External edit kept on disk')`))
  })

  await step('English locale updates document controls, editor labels, and file operations', async () => {
    await cdp.invoke('settings:update', { locale: 'en-US' })
    await until('English locale', () => cdp.eval('document.documentElement.lang === "en-US"'))
    await openFile('preview.md')
    await clickText('Source', documentSelector)
    assert(await cdp.eval(`document.querySelector('.cm-content')?.getAttribute('aria-label')?.includes('preview.md')`))
    assert(await cdp.eval(`document.querySelector(${JSON.stringify(documentSelector)})?.textContent.includes('Saved')`))
    await screenshot('09-editor-en')
    await itemMenu('archive/moved.md', 'Rename')
    await until('English dialog', () => cdp.eval(`document.querySelector('[role="dialog"] input')?.getAttribute('aria-label') === 'Name'`))
    await screenshot('10-file-dialog-en')
    await clickText('Cancel', dialogSelector)
    await waitDialogClosed()
    await clickText('Rendered preview', documentSelector)
    await screenshot('11-markdown-preview-en')
  })

  await step('Window close cancellation preserves drafts, then save and continue closes the window', async () => {
    await openFile('notes.txt')
    const closingContent = 'Saved before closing the application window\n'
    await replaceEditor(closingContent)
    // Return the CDP evaluation result before destruction can invalidate its target.
    await cdp.eval('setTimeout(() => window.close(), 50); true')
    await until('window close confirmation', () => cdp.eval(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') === 'Unsaved changes'`))
    await screenshot('12-window-close-confirmation-en')
    await clickText('Cancel', dialogSelector)
    await waitDialogClosed()
    assert(await cdp.eval(`document.querySelector('.cm-content')?.textContent.includes('Saved before closing the application window')`))
    assert.equal(await disk('notes.txt'), 'External edit kept on disk\n')
    await cdp.eval('setTimeout(() => window.close(), 50); true')
    await until('second window close confirmation', () => cdp.eval(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') === 'Unsaved changes'`))
    assert(await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent.trim() === 'Save and continue' && !item.disabled)
      if (!button) return false
      setTimeout(() => button.click(), 50)
      return true
    })()`))
    await until('window-close save on disk', async () => (await disk('notes.txt')) === closingContent, 20_000, true)
    await until('closed renderer target', async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        return !targets.some((item) => item.id === target.id)
      } catch {
        return child.exitCode !== null
      }
    }, 20_000, true)
  })

  assert.equal(cdp.exceptions.length, 0, `Uncaught renderer errors: ${JSON.stringify(cdp.exceptions)}`)
  await writeFile(join(outputDirectory, 'report.json'), JSON.stringify({ ok: true, checks, screenshots, isolatedProject, workspaceRoot, trashedFixtures, exceptions: cdp.exceptions }, null, 2))
  console.log(JSON.stringify({ ok: true, checks: checks.length, report: join(outputDirectory, 'report.json'), screenshots, isolatedProject, workspaceRoot, trashedFixtures }, null, 2))
} catch (error) {
  process.exitCode = 1
  let body
  if (cdp && !cdp.closed) {
    try { await screenshot('failure') } catch { /* Preserve the original failure. */ }
    try { body = await cdp.eval('document.body.innerText') } catch { /* The renderer may have exited. */ }
  }
  const failure = { ok: false, currentStep, error: String(error.stack ?? error), checks, screenshots, isolatedProject, workspaceRoot, trashedFixtures, body, exceptions: cdp?.exceptions }
  if (outputDirectory) await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(failure, null, 2))
  console.error(JSON.stringify(failure, null, 2))
} finally {
  cdp?.close()
  if (child && child.exitCode === null) child.kill('SIGTERM')
  if (outputDirectory) await writeFile(join(outputDirectory, 'electron.log'), processOutput.join(''))
}
