/*
 * Production binding registry between BrowserTab ids and live page runtimes.
 *
 * BrowserManager remains pure data. This is the only browser module allowed to retain Electron
 * WebContents or Playwright Page objects. IPC-provided webContents ids are accepted only after
 * type, workspace, profile, and session-partition checks; otherwise a renderer could point an
 * Agent tool at an unrelated window.
 */
import { app, nativeImage, session, webContents, type WebContents } from 'electron'
import { browserPartition, type BrowserCuaEvent, type BrowserTab, type BrowserViewport } from '../../shared/domain/browser'
import { browserManager } from './manager'
import { CdpPageSession, type CdpTransport } from './cdp-session'
import { HeadlessBrowserHost } from './headless'
import { CdpBrowserPage, type BrowserPageHandle } from './page-handle'
import {
  installBrowserAutomationBridge,
  type BrowserAutomationBridge,
  type BrowserMouseButton,
  type BrowserPoint,
  type BrowserScreenshot
} from './runtime'

type BrowserLogger = ConstructorParameters<typeof HeadlessBrowserHost>[1]

interface BoundPage {
  handle: BrowserPageHandle
  attachedAt: number
  webContentsId?: number
}

interface Waiter {
  resolve(): void
  reject(err: Error): void
  cleanup(): void
}

function electronTransport(contents: WebContents): CdpTransport {
  return {
    send: (method, params) => contents.debugger.sendCommand(method, params),
    close: async () => {
      if (contents.isDestroyed() || !contents.debugger.isAttached()) return
      contents.debugger.detach()
    }
  }
}

function validateViewport(value: unknown): BrowserViewport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The browser returned an invalid viewport.')
  }
  const raw = value as Record<string, unknown>
  if (
    typeof raw.width !== 'number' ||
    typeof raw.height !== 'number' ||
    !Number.isFinite(raw.width) ||
    !Number.isFinite(raw.height)
  ) {
    throw new Error('The browser returned an invalid viewport.')
  }
  return { width: Math.max(0, Math.round(raw.width)), height: Math.max(0, Math.round(raw.height)) }
}

const MAX_SCREENSHOT_SIDE = 1600
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

function normalizeScreenshot(raw: BrowserScreenshot): BrowserScreenshot {
  let image = nativeImage.createFromBuffer(Buffer.from(raw.data))
  if (image.isEmpty()) throw new Error('The browser returned an invalid screenshot.')
  const viewportMax = Math.max(raw.viewport.width, raw.viewport.height)
  const scale = viewportMax > MAX_SCREENSHOT_SIDE ? MAX_SCREENSHOT_SIDE / viewportMax : 1
  const target = {
    width: Math.max(1, Math.round(raw.viewport.width * scale)),
    height: Math.max(1, Math.round(raw.viewport.height * scale))
  }
  const size = image.getSize()
  if (size.width !== target.width || size.height !== target.height) {
    image = image.resize({ ...target, quality: 'good' })
  }
  let data = new Uint8Array(image.toPNG())
  let mimeType: BrowserScreenshot['mimeType'] = 'image/png'
  while (data.byteLength > MAX_SCREENSHOT_BYTES) {
    data = new Uint8Array(image.toJPEG(80))
    mimeType = 'image/jpeg'
    if (data.byteLength <= MAX_SCREENSHOT_BYTES) break
    const current = image.getSize()
    if (current.width <= 320 || current.height <= 240) {
      throw new Error('The browser screenshot exceeds the 8 MiB tool-output budget.')
    }
    image = image.resize({
      width: Math.max(1, Math.round(current.width * 0.75)),
      height: Math.max(1, Math.round(current.height * 0.75)),
      quality: 'good'
    })
  }
  return { data, mimeType, ...image.getSize(), viewport: raw.viewport }
}

function cdpAttachError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase().includes('debugger') || message.toLowerCase().includes('attached')) {
    return new Error('Browser automation cannot attach while another debugger is active. Close DevTools for this page and retry.')
  }
  return err instanceof Error ? err : new Error(message)
}

export class BrowserBindings implements BrowserAutomationBridge {
  private readonly pages = new Map<string, BoundPage>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly failures = new Map<string, Error>()
  private readonly headless: HeadlessBrowserHost
  private cuaListener: ((event: BrowserCuaEvent) => void) | null = null

  constructor(userDataPath: string, private readonly logger: BrowserLogger) {
    this.headless = new HeadlessBrowserHost(userDataPath, logger)
  }

  async bindIab(input: {
    workspaceId: string
    tabId: string
    webContentsId: number
  }): Promise<BrowserViewport> {
    const tab = browserManager.get(input.tabId)
    if (tab === undefined || tab.workspaceId !== input.workspaceId) {
      throw new Error('浏览器标签不存在或不属于当前工作区')
    }
    if (tab.backend !== 'iab') throw new Error('无头浏览器标签不能绑定到内嵌 webview')
    const contents = webContents.fromId(input.webContentsId)
    if (contents === undefined || contents.isDestroyed() || contents.getType() !== 'webview') {
      throw new Error('浏览器 webview 已失效')
    }
    const expectedSession = session.fromPartition(browserPartition(input.workspaceId, tab.profileId))
    if (contents.session !== expectedSession) throw new Error('浏览器 webview 的会话分区不匹配')
    const current = this.pages.get(tab.id)
    this.failures.delete(tab.id)
    if (current?.webContentsId === input.webContentsId) {
      const info = await current.handle.info()
      return info.viewport
    }
    if (current !== undefined) await this.release(tab.id)
    try {
      contents.debugger.attach('1.3')
    } catch (err) {
      const failure = cdpAttachError(err)
      this.failures.set(tab.id, failure)
      this.rejectWaiters(tab.id, failure)
      throw failure
    }
    const cdp = new CdpPageSession(electronTransport(contents))
    const viewport = async (): Promise<BrowserViewport> => validateViewport(
      await cdp.evaluate<unknown>('({ width: globalThis.innerWidth, height: globalThis.innerHeight })')
    )
    const handle = new CdpBrowserPage(
      'iab',
      input.workspaceId,
      input.tabId,
      cdp,
      {
        navigate: async (url) => contents.loadURL(url),
        url: () => contents.getURL(),
        title: () => contents.getTitle(),
        viewport,
        screenshot: async () => {
          const [image, cssViewport] = await Promise.all([contents.capturePage(), viewport()])
          const size = image.getSize()
          return {
            data: new Uint8Array(image.toPNG()),
            mimeType: 'image/png',
            ...size,
            viewport: cssViewport
          }
        },
        // BrowserManager removes the tab; Electron owns destruction of the matching <webview>.
        close: async () => {}
      },
      (event) => this.cuaListener?.(event)
    )
    const entry: BoundPage = {
      handle,
      attachedAt: Date.now(),
      webContentsId: input.webContentsId
    }
    this.pages.set(tab.id, entry)
    const invalidate = (): void => handle.invalidate()
    const gone = (): void => this.dropIfCurrent(tab.id, entry)
    contents.on('did-start-navigation', invalidate)
    contents.on('did-navigate-in-page', invalidate)
    contents.once('destroyed', gone)
    contents.once('render-process-gone', gone)
    try {
      const size = await viewport()
      browserManager.update(tab.id, { viewport: size })
      this.resolveWaiters(tab.id)
      return size
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err))
      await this.release(tab.id)
      this.failures.set(tab.id, failure)
      this.rejectWaiters(tab.id, failure)
      throw failure
    }
  }

  async openHeadless(input: {
    workspaceId: string
    tabId: string
    profileId?: string
    url: string
    signal: AbortSignal
  }): Promise<BrowserViewport> {
    const tab = browserManager.get(input.tabId)
    if (tab === undefined || tab.workspaceId !== input.workspaceId || tab.backend !== 'headless') {
      throw new Error('Headless browser tab does not exist or belongs to another workspace.')
    }
    this.failures.delete(input.tabId)
    const existing = this.pages.get(input.tabId)
    if (existing !== undefined) await this.release(input.tabId)
    let entry: BoundPage | null = null
    const handle = await this.headless.createPage(
      input,
      (event) => this.cuaListener?.(event),
      () => {
        if (entry !== null) this.dropIfCurrent(input.tabId, entry)
      }
    )
    entry = { handle, attachedAt: Date.now() }
    this.pages.set(input.tabId, entry)
    const info = await handle.info()
    browserManager.update(input.tabId, {
      url: info.url,
      title: info.title,
      status: 'ready',
      viewport: info.viewport
    })
    this.resolveWaiters(input.tabId)
    return info.viewport
  }

  waitFor(tabId: string, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
    if (this.pages.has(tabId)) return Promise.resolve()
    const failure = this.failures.get(tabId)
    if (failure !== undefined) return Promise.reject(failure)
    if (signal.aborted) return Promise.reject(new Error('Browser attachment was aborted.'))
    return new Promise<void>((resolve, reject) => {
      const set = this.waiters.get(tabId) ?? new Set<Waiter>()
      const state: { timer?: ReturnType<typeof setTimeout> } = {}
      const cleanup = (): void => {
        if (state.timer !== undefined) clearTimeout(state.timer)
        signal.removeEventListener('abort', onAbort)
        set.delete(waiter)
        if (set.size === 0) this.waiters.delete(tabId)
      }
      const waiter: Waiter = {
        resolve: () => { cleanup(); resolve() },
        reject: (err) => { cleanup(); reject(err) },
        cleanup
      }
      const onAbort = (): void => waiter.reject(new Error('Browser attachment was aborted.'))
      state.timer = setTimeout(() => waiter.reject(new Error('The embedded browser did not attach within 10 seconds. Keep the browser panel open and retry.')), timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      set.add(waiter)
      this.waiters.set(tabId, set)
    })
  }

  info(tabId: string): { bound: boolean; backend: BrowserTab['backend']; viewport?: BrowserViewport } | undefined {
    const tab = browserManager.get(tabId)
    if (tab === undefined) return undefined
    return {
      bound: this.pages.has(tabId),
      backend: tab.backend,
      ...(tab.viewport === undefined ? {} : { viewport: tab.viewport })
    }
  }

  async navigate(tabId: string, url: string): Promise<void> {
    await this.requirePage(tabId).navigate(url)
    const info = await this.requirePage(tabId).info()
    browserManager.update(tabId, { url: info.url, title: info.title, status: 'ready', viewport: info.viewport })
  }

  async snapshot(tabId: string) {
    const snapshot = await this.requirePage(tabId).snapshot()
    browserManager.update(tabId, {
      url: snapshot.url,
      title: snapshot.title,
      status: 'ready',
      viewport: snapshot.viewport
    })
    return snapshot
  }

  click(tabId: string, ref: string, options?: { button?: BrowserMouseButton; clickCount?: number }): Promise<void> {
    return this.requirePage(tabId).click(ref, options)
  }

  type(tabId: string, ref: string, text: string): Promise<void> {
    return this.requirePage(tabId).type(ref, text)
  }

  press(tabId: string, keys: readonly string[], ref?: string): Promise<void> {
    return this.requirePage(tabId).press(keys, ref)
  }

  select(tabId: string, ref: string, values: readonly string[]): Promise<void> {
    return this.requirePage(tabId).select(ref, values)
  }

  scroll(tabId: string, input: { x?: number; y?: number; scrollX: number; scrollY: number }): Promise<void> {
    return this.requirePage(tabId).scroll(input)
  }

  cuaClick(tabId: string, point: BrowserPoint, button?: BrowserMouseButton): Promise<void> {
    return this.requirePage(tabId).cuaClick(point, button)
  }

  cuaDrag(tabId: string, path: readonly BrowserPoint[], keys?: readonly string[]): Promise<void> {
    return this.requirePage(tabId).cuaDrag(path, keys)
  }

  async screenshot(tabId: string): Promise<BrowserScreenshot> {
    return normalizeScreenshot(await this.requirePage(tabId).screenshot())
  }

  async release(tabId: string): Promise<void> {
    const entry = this.pages.get(tabId)
    this.failures.delete(tabId)
    if (entry === undefined) return
    this.pages.delete(tabId)
    await entry.handle.close()
  }

  async clearProfile(profileId: string, workspaceId?: string): Promise<void> {
    const matchingTabs = [...this.pages.keys()]
      .map((tabId) => browserManager.get(tabId))
      .filter((tab): tab is BrowserTab =>
        tab !== undefined &&
        tab.backend === 'headless' &&
        tab.profileId === profileId &&
        (workspaceId === undefined || tab.workspaceId === workspaceId)
      )
    await Promise.allSettled(matchingTabs.map((tab) => this.release(tab.id)))
    for (const tab of matchingTabs) {
      if (browserManager.get(tab.id) !== undefined) browserManager.close(tab.id)
    }
    await this.headless.clearProfile(profileId, workspaceId)
  }

  reconcile(workspaceId: string, tabs: readonly BrowserTab[]): void {
    const live = new Set(tabs.map((tab) => tab.id))
    for (const [tabId, entry] of this.pages) {
      if (entry.handle.workspaceId !== workspaceId || live.has(tabId)) continue
      void this.release(tabId).catch((err: unknown) => this.logger.warn('[browser] failed to release page', err))
    }
  }

  setCuaListener(listener: ((event: BrowserCuaEvent) => void) | null): void {
    this.cuaListener = listener
  }

  async shutdown(): Promise<void> {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error('Browser runtime is shutting down.'))
    }
    const handles = [...this.pages.values()].map((entry) => entry.handle)
    this.pages.clear()
    await Promise.allSettled(handles.map((handle) => handle.close()))
    await this.headless.shutdown()
  }

  private requirePage(tabId: string): BrowserPageHandle {
    const page = this.pages.get(tabId)?.handle
    if (page === undefined) throw new Error('The browser page is not attached. Open its browser view and retry.')
    return page
  }

  private dropIfCurrent(tabId: string, entry: BoundPage): void {
    if (this.pages.get(tabId) !== entry) return
    this.pages.delete(tabId)
    if (browserManager.get(tabId) !== undefined) browserManager.update(tabId, { status: 'error' })
  }

  private resolveWaiters(tabId: string): void {
    for (const waiter of [...(this.waiters.get(tabId) ?? [])]) waiter.resolve()
  }

  private rejectWaiters(tabId: string, err: Error): void {
    for (const waiter of [...(this.waiters.get(tabId) ?? [])]) waiter.reject(err)
  }
}

let productionBindings: BrowserBindings | null = null

export function installProductionBrowserBindings(logger: BrowserLogger): BrowserBindings {
  if (productionBindings !== null) return productionBindings
  productionBindings = new BrowserBindings(app.getPath('userData'), logger)
  installBrowserAutomationBridge(productionBindings)
  return productionBindings
}
