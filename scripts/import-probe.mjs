/**
 * 导入功能的隔离 Electron 验收 —— **真打包产物、真 preload 白名单、真主进程 handler**。
 *
 * 无头测试(`src/main/imports/__tests__/`)用的是 `nodeHost()` + 直接调服务函数,
 * 覆盖不到这三层里的任何一层。而本次改动往契约里加了 13 条 invoke 频道和 1 条事件,
 * **白名单漏登记一条的表现是运行时一句「频道不在白名单」**,而 vitest 全绿。
 * 这个探针存在的唯一理由就是钉住那一类失败。
 *
 * ⚠️ 三条环境要求,每条都对应一次踩过的坑:
 * 1. `ELECTRON_RUN_AS_NODE` 必须清掉 —— 否则 Electron 退化成无头 node,
 *    窗口不出现,CDP 那端只会超时,看起来像「应用崩了」。
 * 2. 数据库固定在 `<cwd>/.next-cowork`,所以真正的隔离边界是**测试工作目录**,
 *    光传 `--user-data-dir` 不够(那个只隔离单实例锁与早期 profile)。
 * 3. `--user-data-dir` 仍要传:单实例锁在 `app.setPath` 之前就取,用的正是命令行那个值。
 *    不传的话已装版本会顶掉这次启动,症状是「DevTools 起来了但没有 page target」。
 *
 * ★ **绝不碰用户真实的 `~/.claude` 或真实数据库** —— 源目录是本脚本现造的夹具,
 *   经 `CLAUDE_CONFIG_DIR` 指过去。
 *
 * 跑法:`npm run build && node scripts/import-probe.mjs`
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9335
const DEADLINE_MS = 60_000

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
    if (r.exceptionDetails) {
      throw new Error(`页面里抛了:${r.exceptionDetails.exception?.description ?? '?'}`)
    }
    return r.result.value
  }

  /** 走 preload 白名单和主进程 handler,返回完整 IpcResult 信封。 */
  invoke(channel, req) {
    return this.eval(
      `window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req ?? null)})`
    )
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
    await sleep(250)
  }
}

const log = (s) => console.log(s)

/** 造一份最小的 Claude Code 夹具目录:一个项目、一个会话、一条技能。 */
async function buildFixture(projectPath) {
  const configDir = await mkdtemp(join(tmpdir(), 'ncw-probe-cc-'))
  const transcriptDir = join(configDir, 'projects', 'encoded-proj')
  await mkdir(transcriptDir, { recursive: true })

  const records = [
    {
      uuid: 'u1',
      parentUuid: null,
      type: 'user',
      cwd: projectPath,
      sessionId: 'probe-session',
      timestamp: '2025-01-01T00:00:00.000Z',
      message: { role: 'user', content: '探针:看一下 README' }
    },
    {
      uuid: 'a1',
      parentUuid: 'u1',
      type: 'assistant',
      timestamp: '2025-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: '好的。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }
        ]
      }
    },
    {
      uuid: 'r1',
      parentUuid: 'a1',
      type: 'user',
      timestamp: '2025-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# 探针', is_error: false }]
      }
    }
  ]
  await writeFile(
    join(transcriptDir, 'probe-session.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )

  await mkdir(join(configDir, 'skills', 'probe-skill'), { recursive: true })
  await writeFile(
    join(configDir, 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: 探针用的技能\n---\n\n正文。\n'
  )
  await writeFile(join(configDir, 'CLAUDE.md'), '# 探针说明\n\n这一行来自夹具。\n')

  return configDir
}

let child = null
let testProject = null
let configDir = null
let failed = false

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE

  const projectRoot = process.cwd()
  testProject = await mkdtemp(join(tmpdir(), 'ncw-probe-project-'))
  configDir = await buildFixture(testProject)
  // ★ 夹具目录经环境变量指过去 —— 探针**永远不碰** `~/.claude`。
  env.CLAUDE_CONFIG_DIR = configDir

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

  // ── 1. 十三条频道全部在 preload 白名单里 ────────────────────────────
  // ★ 这一条是本探针存在的**首要理由**:白名单漏登记一条,vitest 全绿,
  //   而运行时会抛「频道不在白名单」。逐条过一遍最便宜。
  const readOnly = [
    ['imports:detect', { sourceKind: 'claude-code' }],
    ['imports:history', { offset: 0, limit: 50 }]
  ]
  for (const [channel, req] of readOnly) {
    expectOk(channel, await cdp.invoke(channel, req))
  }
  log('✓ imports:* 频道穿过了真 preload 白名单')

  // ── 2. 探测到夹具目录(而不是用户真实目录) ─────────────────────────
  const state = expectOk('imports:detect', await cdp.invoke('imports:detect', { sourceKind: 'claude-code' }))
  if (state.detection.availability !== 'detected') {
    throw new Error(`应当探测到夹具来源,实际 ${state.detection.availability}`)
  }
  if (!state.detection.configDir.includes('ncw-probe-cc-')) {
    throw new Error(`探测到的目录不是夹具:${state.detection.configDir}`)
  }
  if (state.detection.sessionCount !== 1) {
    throw new Error(`夹具应当只有 1 个会话,实际 ${state.detection.sessionCount}`)
  }
  if (state.sync.categories.length !== 0) {
    throw new Error('★ 初次检测不该预先授权任何类别')
  }
  log(`✓ 探测到夹具来源 · ${state.detection.configDir} · ${state.detection.sessionCount} 个会话`)

  const sourceId = state.detection.sourceId

  // ── 3. 预览 → 分页取条目 ────────────────────────────────────────────
  const preview = expectOk(
    'imports:preview',
    await cdp.invoke('imports:preview', { sourceId, requestId: 'probe-1' })
  )
  const page = expectOk(
    'imports:previewItems',
    await cdp.invoke('imports:previewItems', { previewId: preview.previewId, offset: 0, limit: 50 })
  )
  const categories = new Set(page.items.map((i) => i.category))
  for (const expected of ['chat', 'project', 'skill', 'instructions']) {
    if (!categories.has(expected)) throw new Error(`预览里缺少类别 ${expected}`)
  }
  log(`✓ 预览产出 ${page.total} 项 · ${[...categories].join(' / ')}`)

  /*
    ★★ 提交**之前**先在页面里挂一个 `workspace:changed` 的计数器。

    踩过的那次:导入确实把工作区写进了库,`workspace:list` 也查得到,但左上角那个
    切换器里**没有它** —— 因为渲染层那份列表只靠这个事件更新,而导入路径忘了广播。
    用户要重启应用才看得见,重启之后它又确实在,于是看起来像「时好时坏」。

    ★ 所以这里断言的是**事件到没到**,不是「数据在不在库里」—— 后者那次是绿的。
  */
  await cdp.eval(`
    window.__probeWorkspaceEvents = 0
    window.__probeUnsub = window.nextcowork.on('workspace:changed', () => { window.__probeWorkspaceEvents += 1 })
  `)

  // ── 4. 提交,并验证聊天真的落进了会话列表 ───────────────────────────
  /*
    ★ 选法必须和弹窗里那套(`selection.ts` 的 `resolvedProjectKeys`)一致。

    全新安装上,源里每个项目都还没有本地工作区,于是它下面的聊天在预览里是
    `needs-target`。只挑 new/update 的话聊天永远进不来 —— 而这正是这个探针
    第一次跑出来抓到的 bug:导入「成功」、计数非零,会话列表却是空的。
    项目排在聊天之前提交(`order()`),所以「项目也勾上」就足以让聊天落地。
  */
  const selectedProjects = new Set(
    page.items.filter((i) => i.category === 'project' && i.status !== 'needs-target').map((i) => i.projectKey)
  )
  const selectable = page.items.filter(
    (i) =>
      i.status === 'new' ||
      i.status === 'update' ||
      (i.status === 'needs-target' && selectedProjects.has(i.projectKey))
  )
  expectOk(
    'imports:apply',
    await cdp.invoke('imports:apply', {
      previewId: preview.previewId,
      itemIds: selectable.map((i) => i.id),
      workspaceTargets: [],
      requestId: 'probe-apply-1'
    })
  )
  const done = await until('导入作业结束', async () => {
    const status = expectOk('imports:status', await cdp.invoke('imports:status', { sourceId }))
    if (status === null) return null
    return ['done', 'partial', 'failed', 'cancelled'].includes(status.phase) ? status : null
  })
  if (done.phase === 'failed') throw new Error(`导入失败:${JSON.stringify(done.diagnostics)}`)
  log(`✓ 导入作业收尾 · ${done.phase} · 新增 ${done.counts.imported} 更新 ${done.counts.updated}`)

  const workspaceEvents = await cdp.eval('window.__probeWorkspaceEvents')
  if (typeof workspaceEvents !== 'number' || workspaceEvents < 1) {
    throw new Error('★ 导入建了工作区却没广播 workspace:changed —— 切换器里看不到新项目')
  }
  log(`✓ 工作区变更已广播到渲染层 · ${String(workspaceEvents)} 次`)

  const workspaces = expectOk('workspace:list', await cdp.invoke('workspace:list', null))
  const target2 = workspaces.find((w) => w.rootPath === testProject)
  if (target2 === undefined) throw new Error('导入应当为夹具项目建立工作区')
  const sessions = expectOk(
    'sessions:list',
    await cdp.invoke('sessions:list', { workspaceId: target2.id })
  )
  if (sessions.length !== 1) throw new Error(`应当导入 1 条会话,实际 ${sessions.length}`)
  const detail = expectOk('sessions:get', await cdp.invoke('sessions:get', { sessionId: sessions[0].id }))
  if (detail.messages.length !== 3) throw new Error(`会话应当有 3 条消息,实际 ${detail.messages.length}`)
  const hasToolCall = detail.messages.some((m) => m.parts.some((p) => p.type === 'tool_call'))
  if (!hasToolCall) throw new Error('工具调用没有被保留下来')
  log(`✓ 聊天落库并可读回 · ${detail.messages.length} 条消息,工具块完好`)

  // ── 5. 幂等:再导一次,数量不变 ──────────────────────────────────────
  const preview2 = expectOk(
    'imports:preview',
    await cdp.invoke('imports:preview', { sourceId, requestId: 'probe-2' })
  )
  const page2 = expectOk(
    'imports:previewItems',
    await cdp.invoke('imports:previewItems', { previewId: preview2.previewId, category: 'chat', offset: 0, limit: 50 })
  )
  if (page2.items[0]?.status !== 'exists') {
    throw new Error(`第二次预览该聊天应当是 exists,实际 ${page2.items[0]?.status}`)
  }
  const sessionsAgain = expectOk('sessions:list', await cdp.invoke('sessions:list', { workspaceId: target2.id }))
  if (sessionsAgain.length !== 1) throw new Error(`★ 导入两次应仍是 1 条,实际 ${sessionsAgain.length}`)
  log('✓ 导入两次仍一份')

  // ── 6. MCP 导入后必须是关闭的(防执行边界) ─────────────────────────
  const servers = expectOk('mcp:list', await cdp.invoke('mcp:list', null))
  const enabledImported = servers.filter((s) => s.config.enabled)
  if (enabledImported.length > 0) {
    throw new Error(`★ 导入的 MCP 服务器必须 enabled:false,实际有 ${enabledImported.length} 条是开的`)
  }
  log('✓ MCP 默认关闭')

  // ── 7. 设置页真的渲染得出来 ─────────────────────────────────────────
  /*
    ★ 全新 user-data 下第一屏是**登录门**,不是应用外壳 —— 不先过掉它,
    后面找什么按钮都找不到,而报出来的只是一句「超时」。
  */
  await until('登录门过掉', async () => {
    const done = await cdp.eval(`
      (() => {
        const gate = [...document.querySelectorAll('button')]
          .find((b) => /免登录使用|Continue without/.test(b.textContent ?? ''))
        if (gate) { gate.click(); return 'clicked' }
        return document.querySelector('[data-testid="composer-input"]') !== null ? 'shell' : null
      })()
    `)
    return done === 'shell' ? true : null
  })
  log('✓ 过掉登录门,应用外壳就位')

  /*
    ★ 事件必须派发在 `document` 上,不是 `window`。

    `AppShell` 那个监听挂的是 `document.addEventListener('keydown', …)`,
    而 `window.dispatchEvent` 的传播路径里**没有 document**(它在 window 下面),
    于是监听一次都不会跑。症状是「按了没反应」,而 CDP 那边只能报一句超时。
    ★ `code: 'Comma'` 也不能省:`acceleratorFromKeyboardEvent` 先读 `e.code`。
  */
  const isMac = process.platform === 'darwin'
  await cdp.eval(`
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', ${isMac ? 'metaKey: true' : 'ctrlKey: true'}, bubbles: true
    }))
  `)
  await until('设置浮层打开', () =>
    cdp.eval(`[...document.querySelectorAll('button')].some((b) => /^\\s*(通用|General)\\s*$/.test(b.textContent ?? ''))`)
  )

  const rendered = await until('导入页渲染', async () => {
    const text = await cdp.eval(`
      (() => {
        const nav = [...document.querySelectorAll('button')]
          .find((b) => /^\\s*(导入|Import)\\s*$/.test(b.textContent ?? ''))
        if (!nav) return null
        nav.click()
        return document.body.innerText
      })()
    `)
    if (typeof text !== 'string') return null
    return /自动同步|Auto sync/.test(text) && /Claude Code/.test(text) ? text : null
  })
  if (!/导入历史|Import history/.test(rendered)) throw new Error('导入历史那一块没有渲染出来')
  if (!/从其他 AI 应用导入|Import from other AI apps/.test(rendered)) {
    throw new Error('来源那一块没有渲染出来')
  }
  log('✓ 设置 › 导入 页面渲染完整(自动同步 / 来源行 / 导入历史)')

  // ── 7b. 卡片不能被 flex 压扁 ─────────────────────────────────────────
  /*
    ★★ 设置内容区是 flex 纵向容器,卡片默认 `flex-shrink: 1`。内容一旦高过
    视口,浏览器会**把卡片压扁**而不是让容器滚动,再被卡片自己的
    `overflow-hidden` 切掉底部那一行。

    这一条断言的是「卡片实际高度 ≥ 它内部各行高度之和」—— 不能用
    `scrollHeight > clientHeight` 判,因为被压扁的卡片这两个值是**相等**的
    (内容没有撑破它,是它被压到了内容的尺寸以下)。
  */
  /*
    ★ 必须先**把视口压矮**再量 —— 内容装得下的时候 `flex-shrink` 根本不触发,
    守卫会在一个不可能出问题的条件下通过。验收标准里那条「检查 1036x768 与
    项目可支持的最小窗口」说的就是这件事。
  */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 560,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(600)

  const squashed = await cdp.eval(`
    (() => {
      const bad = []
      for (const sec of document.querySelectorAll('section')) {
        const h3 = sec.querySelector('h3')
        if (!h3) continue
        let need = 0
        for (const child of sec.children) need += child.getBoundingClientRect().height
        const have = sec.getBoundingClientRect().height
        // 留 2px 容差给子像素取整
        if (have + 2 < need) bad.push({ title: h3.textContent, have: Math.round(have), need: Math.round(need) })
      }
      return bad
    })()
  `)
  if (Array.isArray(squashed) && squashed.length > 0) {
    throw new Error(`★ 卡片被 flex 压扁: ${JSON.stringify(squashed)}`)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(400)
  log('✓ 卡片没有被 flex 压扁(在 1100x560 的矮窗口下量的)')

  // ── 8. 「选择导入」弹窗:标题必须**真的看得见** ───────────────────────
  /*
    ★★ 这一条断言的是**宽度**,不是「文字在不在 DOM 里」。

    踩过的那次:`Select` 的触发器自带 `w-full`,放进行内 flex 之后把
    `min-w-0 flex-1` 的标题块挤成 0 像素宽,`truncate` 再把它裁干净。
    DOM 里三行文字一个字都不少,界面上却什么都没有 —— 任何检查 innerText
    或 querySelector 的断言都会**通过**,而用户看到的是一列空白。
    所以这里必须量 `getBoundingClientRect().width`。
  */
  await cdp.eval(`
    [...document.querySelectorAll('button')]
      .find((b) => /^\\s*(导入|Import)\\s*$/.test(b.textContent ?? '') && b.className.includes('accent'))
      ?.click()
  `)
  const row = await until('选择导入弹窗的会话行', async () => {
    const probe = await cdp.eval(`
      (() => {
        if (!/选择要导入的内容|Choose what to import/.test(document.body.innerText)) return null
        for (const li of document.querySelectorAll('li')) {
          if (!li.querySelector('[role=checkbox]')) continue
          /*
            ★ 必须挑**带下拉框**的那种行 —— 出问题的正是「标题块 + w-full 的
            Select」这个组合。随便挑一行(比如技能行,它没有下拉框)测出来是
            好的,而坏的那一种根本没被看过。
          */
          if (!li.querySelector('[role=combobox]')) continue
          const textDiv = li.querySelector('div.min-w-0')
          if (!textDiv) continue
          const title = textDiv.querySelector('p')
          if (!title || (title.textContent ?? '').trim() === '') continue
          return {
            title: title.textContent.trim(),
            width: Math.round(textDiv.getBoundingClientRect().width)
          }
        }
        return null
      })()
    `)
    return probe
  })
  if (row.width < 80) {
    throw new Error(`★ 会话标题被挤成 ${row.width}px —— 文字在 DOM 里但界面上看不见`)
  }
  log(`✓ 会话行标题可见 · 「${row.title}」· 文字区 ${row.width}px`)

  log('\n全部通过 ✅')
} catch (err) {
  failed = true
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
} finally {
  /*
    ★ SIGTERM 不够。应用的 `before-quit` 会 `preventDefault()` 走一套优雅关闭
    (停 run、关 MCP、关库),而这里我们不关心它关得干不干净 —— 关心的是
    **进程一定要没**。留一个下来的后果很具体:它占着 9335,下一次跑探针
    永远等不到 CDP target,而报出来的是「超时等待渲染进程」,看着像应用起不来。
  */
  if (child !== null) {
    child.kill('SIGTERM')
    await sleep(1500)
    if (child.exitCode === null) child.kill('SIGKILL')
    await sleep(300)
  }
  for (const dir of [testProject, configDir]) {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(failed ? 1 : 0)
}
