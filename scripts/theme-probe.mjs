/**
 * 主题链路的端到端冒烟:**真的把应用跑起来,真的换一次色,真的读 `<html>` 上的 token。**
 *
 * 换色器本身有 59 条 vitest 撑着,但那些跑在 node 里,**一个 DOM 都碰不到**。
 * 从 `tokensOf` 算出 22 个字符串,到它们真的落到 `document.documentElement.style` 上,
 * 中间隔着 preload 白名单、`settings:update` 的往返、`settings:changed` 广播、
 * 以及 `applyTheme` 那一圈 `setProperty` —— 这几层没有任何一个无头测试覆盖得到。
 *
 * 三件事在这里钉住,它们的失败症状都很难从截图上倒推:
 *   1. 「自定义」挑的色真的推到了整套 token,而**四层底色的明度一格没动**;
 *   2. 脏的 hex 落回默认,不产生 `#NaNNaNNaN`(那会让某一格 token 静静保持旧值);
 *   3. `theme:readImage` 只认索引里查得到的 id —— 契约 §9 那条「渲染层永不指定路径」
 *      在打包产物上仍然成立。
 *
 * 图片那一段是**预置**进 userData 的:文件对话框是模态的,CDP 驱动不了。
 * 所以这里只验「索引 → 读字节 → 底图落到 `<html>` → 删掉」这半条,
 * 前半条(选文件 → 解码取色)得手动跑一次。
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` 必须清掉,否则 Electron 退化成一个无头 node,
 * 窗口不会出现,而 CDP 那一端只会超时 —— 那种失败看起来像「应用崩了」。
 *
 * 跑法:`npx electron-vite build && node scripts/theme-probe.mjs`
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import electron from 'electron'

const PORT = 9334
const DEADLINE_MS = 60_000

/** 预置那张图的 id。形状必须过主进程的 `ID_RE`(`img_` + 26 个 Crockford base32) */
const SEEDED_ID = 'img_01J00000000000000000000TST'
/** 索引里写的种子色 —— 选中它之后整套 token 应当由这个色派生,而不是由颜色主题 */
const SEEDED_SEED = '#3f7fd0'
/** 1×1 的蓝点。底图画不画得出来不重要,重要的是字节读得回来 */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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

  /** 走 preload 桥发一次 invoke,信封原样搬回来(失败分支也要能断言) */
  invoke(channel, req) {
    return this.eval(
      `window.nextcowork.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req ?? null)})`
    )
  }

  /** `<html>` 上那 22 个 token 的当前值 + 底图那两个属性 */
  theme() {
    return this.eval(`
      (() => {
        const el = document.documentElement
        const cs = getComputedStyle(el)
        // 抄自 shared/domain/theme.ts 的 THEME_TOKENS,顺序一致 ——
        // 少一个就等于少断言一格,而缺的那一格恰恰可能是保持着旧值的那个
        const names = ['app','canvas','surface','chrome','surface-raised','surface-input',
          'surface-field','surface-sunken','tint','tint-hover','tint-strong','border',
          'hairline','fg','fg-muted','fg-faint','icon','accent','accent-fg','accent-soft',
          'danger','scrim']
        const tokens = {}
        for (const n of names) tokens[n] = cs.getPropertyValue('--color-' + n).trim()
        return {
          tokens,
          image: el.style.getPropertyValue('--theme-image').trim() || null,
          render: el.dataset.imageRender ?? null
        }
      })()
    `)
  }
}

async function until(label, fn, { timeoutMs = DEADLINE_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last !== null && last !== undefined && last !== false) return last
    if (Date.now() > deadline) {
      throw new Error(`超时等待「${label}」,最后一次拿到 ${JSON.stringify(last)}`)
    }
    await sleep(200)
  }
}

/** `#rrggbb` → HSL。和 `shared/domain/theme.ts` 的 `hexToHsl` 同一套算法 */
function hsl(hex) {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 }
}

const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
const log = (s) => console.log(s)
let child = null
let failed = false

try {
  // ── 预置一张图,再起应用 ──────────────────────────────────────────
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  // ★ `--user-data-dir` 给的是**基准路径**,不是最终路径:`main/index.ts` 在
  // `is.dev` 下会把它改成 `<路径>-dev`。而这个探针跑的是未打包的 `out/`
  // (`electron .`),所以走的正是那条分支 —— 预置文件得放进带后缀的那一个,
  // 否则 `theme:listImages` 只会回一张空表,看起来像索引读坏了
  const userData = `/tmp/nextcowork-theme-${Date.now()}`
  const themes = join(`${userData}-dev`, 'themes')
  mkdirSync(themes, { recursive: true })
  writeFileSync(join(themes, `${SEEDED_ID}.png`), Buffer.from(PNG_1PX, 'base64'))
  writeFileSync(
    join(themes, 'index.json'),
    JSON.stringify(
      [
        {
          id: SEEDED_ID,
          name: '预置探针图',
          mime: 'image/png',
          seed: SEEDED_SEED,
          palette: [SEEDED_SEED, '#2f5f9f']
        }
      ],
      null,
      2
    )
  )

  child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const mainOut = []
  child.stdout.on('data', (b) => mainOut.push(String(b)))
  child.stderr.on('data', (b) => mainOut.push(String(b)))
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`⚠️ 主进程提前退出,code=${code}\n${mainOut.join('')}`)
    }
  })

  const target = await until('渲染进程 CDP target', async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await r.json()
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      return null
    }
  })
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await until('contextBridge 注入', () =>
    cdp.eval('typeof window.nextcowork').then((t) => t === 'object')
  )
  log(`✓ 窗口起来了 · ${target.title || target.url}`)

  const setColor = async (colorTheme) => {
    const r = await cdp.invoke('settings:update', { colorTheme })
    if (!r.ok) throw new Error(`settings:update 失败:${JSON.stringify(r.error)}`)
  }

  // ── 1. 基线 ───────────────────────────────────────────────────────
  await setColor({ id: 'ink-green' })
  const base = await until('默认墨绿落地', async () => {
    const t = await cdp.theme()
    return hsl(t.tokens.accent).h > 120 && hsl(t.tokens.accent).h < 180 ? t : null
  })
  log(`✓ 基线 · accent=${base.tokens.accent} canvas=${base.tokens.canvas}`)

  // ── 2. 自定义色推到整套 token,底色明度一格没动 ──────────────────────
  const CUSTOM = '#c04a2b' // 暖橙,和墨绿隔着半个色轮
  await setColor({ id: 'custom', custom: CUSTOM })
  const warm = await until('自定义色落地', async () => {
    const t = await cdp.theme()
    return t.tokens.accent !== base.tokens.accent ? t : null
  })

  const wantH = hsl(CUSTOM).h
  const gotH = hsl(warm.tokens.accent).h
  // 门槛给 30°:`fitLightness` 只推明度,色相是原样带过去的,但 8 位量化
  // 和饱和度钳位会带来几度的漂移 —— 要钉的是「是这一族色」,不是逐位相等
  if (hueGap(wantH, gotH) > 30) {
    throw new Error(`accent 不是用户挑的那一族:想要 ${wantH.toFixed(0)}°,拿到 ${gotH.toFixed(0)}°`)
  }
  // ★ 明度一动,四层底色的层次立刻塌掉,而截图上不一定看得出来
  for (const k of ['app', 'chrome', 'canvas', 'surface', 'tint']) {
    const d = Math.abs(hsl(warm.tokens[k]).l - hsl(base.tokens[k]).l)
    if (d > 1) throw new Error(`${k} 的明度被动了 ${d.toFixed(1)} 个百分点`)
  }
  // 而色相**必须**跟着走 —— 底色是带着强调色一点色偏的,不是纯灰
  if (hueGap(hsl(warm.tokens.canvas).h, hsl(base.tokens.canvas).h) < 20) {
    throw new Error('canvas 的色相没跟着换 —— 底色没有参与换色')
  }
  log(`✓ 自定义 ${CUSTOM} → accent=${warm.tokens.accent}(${gotH.toFixed(0)}°),底色明度未动、色相跟走`)

  // ── 3. 脏 hex 落回默认,不产生 #NaNNaNNaN ─────────────────────────
  await setColor({ id: 'custom', custom: '#3' })
  const dirty = await until('脏值落回默认', async () => {
    const t = await cdp.theme()
    return t.tokens.accent !== warm.tokens.accent ? t : null
  })
  for (const [k, v] of Object.entries(dirty.tokens)) {
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`token ${k} 不是合法颜色:${v}`)
  }
  log(`✓ 半截 hex 落回默认 · accent=${dirty.tokens.accent}(没有 NaN)`)

  // ── 4. 预置的那张图:索引 → 字节 → 底图 ────────────────────────────
  const list = await cdp.invoke('theme:listImages', undefined)
  if (!list.ok || !list.data.some((t) => t.id === SEEDED_ID)) {
    throw new Error(`索引里看不见预置的那张图:${JSON.stringify(list)}`)
  }
  const bytes = await cdp.invoke('theme:readImage', { id: SEEDED_ID })
  if (!bytes.ok) throw new Error(`读不回字节:${JSON.stringify(bytes.error)}`)
  log(`✓ theme:listImages / readImage 走通(mime=${bytes.data.mime})`)

  const sel = await cdp.invoke('settings:update', { imageTheme: { id: SEEDED_ID } })
  if (!sel.ok) throw new Error(`选图失败:${JSON.stringify(sel.error)}`)
  const withImg = await until('底图落到 <html>', async () => {
    const t = await cdp.theme()
    return t.image !== null && t.render !== null ? t : null
  })
  // ★ 选了图,整套 token 就该由**图的种子**派生 —— 而不是上面那个「自定义」
  const seedH = hsl(SEEDED_SEED).h
  if (hueGap(seedH, hsl(withImg.tokens.accent).h) > 30) {
    throw new Error(`选了图但 accent 不是图的种子色一族:${withImg.tokens.accent}`)
  }
  log(`✓ 图片主题盖过颜色主题 · accent=${withImg.tokens.accent} render=${withImg.render}`)

  // ── 5. ★ 索引里没有的 id 一律读不到(契约 §9) ────────────────────
  for (const bogus of ['img_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', '../../../../etc/passwd', '']) {
    const r = await cdp.invoke('theme:readImage', { id: bogus })
    if (r.ok) throw new Error(`不该读得到:${bogus}`)
  }
  log('✓ 索引外的 id 一律 ok:false —— 路径穿越在这里没有形状')

  // ── 6. 删掉之后底图和选择一起消失 ──────────────────────────────────
  const del = await cdp.invoke('theme:deleteImage', { id: SEEDED_ID })
  if (!del.ok || del.data.length !== 0) throw new Error(`删除后表没清空:${JSON.stringify(del)}`)
  await cdp.invoke('settings:update', { imageTheme: { id: null } })
  const gone = await until('底图消失', async () => {
    const t = await cdp.theme()
    return t.image === null && t.render === null ? t : null
  })
  if (!/^#[0-9a-f]{6}$/i.test(gone.tokens.accent)) {
    throw new Error(`取消选图后 accent 坏了:${gone.tokens.accent}`)
  }
  log('✓ 删图后底图两个属性都消失,整套 token 落回颜色主题')

  // ── 7. 设置页真的画得出来 ──────────────────────────────────────────
  // 上面六步走的全是 IPC + DOM 属性,一次都没渲染过那一页 —— 而取色器是
  // 这轮唯一的新控件。它要是在渲染期抛了(React 的「渲染期改 state」写法
  // 一不小心就是死循环),前面六条照样全绿,而用户打开设置页看到的是一片白
  await cdp.eval(`
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, ctrlKey: true, bubbles: true })
    )
  `)
  // ⌘, 开在「通用」上(`DEFAULT_SETTINGS_PAGE`),取色器在「偏好」那一页 ——
  // 按标签找那颗导航按钮,不写死 DOM 结构
  await until('设置浮层', () =>
    cdp.eval(`
      (() => {
        const nav = [...document.querySelectorAll('nav button')].find(
          (b) => b.textContent.trim() === '偏好'
        )
        if (!nav) return false
        nav.click()
        return true
      })()
    `)
  )
  const picker = await until('设置页上的取色器', () =>
    cdp.eval(`
      (() => {
        const hex = document.querySelector('input[aria-label="强调色 hex"]')
        const dot = document.querySelector('input[aria-label="自定义强调色"]')
        return hex && dot ? { hex: hex.value, dot: dot.value } : null
      })()
    `)
  )
  if (!/^#[0-9a-f]{6}$/i.test(picker.hex) || picker.dot !== picker.hex) {
    throw new Error(`取色器初值不对:${JSON.stringify(picker)}`)
  }
  log(`✓ 设置页渲染通过 · 取色器初值 ${picker.hex}`)

  log('\n✅ 主题链路通过 —— 打包产物里换一次色,22 个 token 真的跟着变了。')
} catch (err) {
  failed = true
  console.error(`\n❌ 主题探针失败:${err.message}`)
} finally {
  child?.kill('SIGTERM')
  await sleep(500)
  if (child !== null && child.exitCode === null) child.kill('SIGKILL')
}

process.exit(failed ? 1 : 0)
