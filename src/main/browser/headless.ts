/*
 * CLI-style managed headless Chromium backend.
 *
 * Profiles are persistent Playwright contexts under Electron's userData root, keyed by the same
 * workspace/Profile pair as IAB partitions. The browser binary is resolved from the managed
 * Playwright cache first, then Chrome/Edge channels; only an explicit headless open may download
 * Chromium into that cache.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { BrowserContext, BrowserType, CDPSession, Page } from 'playwright-core'
import type { BrowserCuaEvent } from '../../shared/domain/browser'
import { CdpPageSession, type CdpTransport } from './cdp-session'
import { CdpBrowserPage, type BrowserPageHandle } from './page-handle'

interface HeadlessLogger {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

interface ContextEntry {
  context: BrowserContext
  pages: Set<Page>
}

type Chromium = BrowserType<unknown>

const requireFromHere = createRequire(import.meta.url)
const HEADLESS_VIEWPORT = { width: 1280, height: 720 }
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

function contextKey(workspaceId: string, profileId?: string): string {
  return `${encodeURIComponent(workspaceId)}--${encodeURIComponent(profileId ?? 'default')}`
}

function cdpTransport(session: CDPSession): CdpTransport {
  const raw = session as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>
    detach(): Promise<void>
  }
  return {
    send: (method, params) => raw.send(method, params),
    close: () => raw.detach()
  }
}

function abortError(): Error {
  const err = new Error('Browser launch was aborted.')
  err.name = 'AbortError'
  return err
}

export class HeadlessBrowserHost {
  private chromium: Chromium | null = null
  private installPromise: Promise<void> | null = null
  private readonly contexts = new Map<string, ContextEntry>()

  constructor(
    private readonly userDataPath: string,
    private readonly logger: HeadlessLogger
  ) {}

  async createPage(
    input: {
      workspaceId: string
      tabId: string
      profileId?: string
      url: string
      signal: AbortSignal
    },
    emit: (event: BrowserCuaEvent) => void,
    onGone: () => void
  ): Promise<BrowserPageHandle> {
    if (input.signal.aborted) throw abortError()
    const entry = await this.contextFor(input.workspaceId, input.profileId, input.signal)
    const page = await entry.context.newPage()
    for (const orphan of entry.context.pages()) {
      if (orphan !== page && !entry.pages.has(orphan)) await orphan.close()
    }
    entry.pages.add(page)
    let gone = false
    const markGone = (): void => {
      if (gone) return
      gone = true
      entry.pages.delete(page)
      onGone()
    }
    page.once('close', markGone)
    page.once('crash', markGone)
    const rawSession = await entry.context.newCDPSession(page)
    const cdp = new CdpPageSession(cdpTransport(rawSession))
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) cdp.invalidateContext()
    })
    const handle = new CdpBrowserPage(
      'headless',
      input.workspaceId,
      input.tabId,
      cdp,
      {
        navigate: async (url) => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        },
        url: () => page.url(),
        title: () => page.title(),
        viewport: async () => page.viewportSize() ?? HEADLESS_VIEWPORT,
        screenshot: async () => {
          const viewport = page.viewportSize() ?? HEADLESS_VIEWPORT
          const data = await page.screenshot({ type: 'png', animations: 'disabled' })
          return { data: new Uint8Array(data), mimeType: 'image/png', ...viewport, viewport }
        },
        close: async () => {
          if (!page.isClosed()) await page.close()
          markGone()
        }
      },
      emit
    )
    try {
      await handle.navigate(input.url)
      return handle
    } catch (err) {
      await handle.close()
      throw err
    }
  }

  async clearProfile(profileId: string, workspaceId?: string): Promise<void> {
    const suffix = `--${encodeURIComponent(profileId)}`
    const exactKey = workspaceId === undefined ? undefined : contextKey(workspaceId, profileId)
    const matches = (key: string): boolean => exactKey === undefined ? key.endsWith(suffix) : key === exactKey
    const matching = [...this.contexts.entries()].filter(([key]) => matches(key))
    for (const [key] of matching) this.contexts.delete(key)
    await Promise.allSettled(matching.map(([, entry]) => entry.context.close()))
    const profilesRoot = join(this.userDataPath, 'headless-profiles')
    if (!existsSync(profilesRoot)) return
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && matches(entry.name)) {
        rmSync(join(profilesRoot, entry.name), { recursive: true, force: true })
      }
    }
  }

  async shutdown(): Promise<void> {
    const contexts = [...this.contexts.values()].map((entry) => entry.context)
    this.contexts.clear()
    await Promise.allSettled(contexts.map((context) => context.close()))
  }

  private async contextFor(workspaceId: string, profileId: string | undefined, signal: AbortSignal): Promise<ContextEntry> {
    const key = contextKey(workspaceId, profileId)
    const existing = this.contexts.get(key)
    if (existing !== undefined) return existing
    const chromium = await this.chromiumType()
    const userDataDir = join(this.userDataPath, 'headless-profiles', key)
    mkdirSync(userDataDir, { recursive: true })
    const context = await this.launchPersistentContext(chromium, userDataDir, signal)
    const entry: ContextEntry = { context, pages: new Set() }
    context.once('close', () => {
      if (this.contexts.get(key) === entry) this.contexts.delete(key)
    })
    this.contexts.set(key, entry)
    return entry
  }

  private async chromiumType(): Promise<Chromium> {
    if (this.chromium !== null) return this.chromium
    const browsersPath = join(this.userDataPath, 'headless-browsers')
    mkdirSync(browsersPath, { recursive: true })
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
    const module = await import('playwright-core')
    this.chromium = module.chromium as Chromium
    return this.chromium
  }

  private async launchPersistentContext(
    chromium: Chromium,
    userDataDir: string,
    signal: AbortSignal
  ): Promise<BrowserContext> {
    const common = { headless: true, viewport: HEADLESS_VIEWPORT }
    const managedExecutable = chromium.executablePath()
    if (existsSync(managedExecutable)) {
      return chromium.launchPersistentContext(userDataDir, { ...common, executablePath: managedExecutable })
    }
    for (const channel of ['chrome', 'msedge'] as const) {
      try {
        return await chromium.launchPersistentContext(userDataDir, { ...common, channel })
      } catch (err) {
        this.logger.debug(`[browser] headless ${channel} unavailable`, err)
      }
    }
    await this.installChromium(signal)
    if (!existsSync(chromium.executablePath())) {
      throw new Error('Managed Chromium installation completed without an executable.')
    }
    return chromium.launchPersistentContext(userDataDir, {
      ...common,
      executablePath: chromium.executablePath()
    })
  }

  private installChromium(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.installPromise === null) {
      // The download is process-global. One cancelled run stops waiting but must not kill the
      // shared installer underneath other runs that joined the same promise.
      this.installPromise = this.runInstaller().finally(() => {
        this.installPromise = null
      })
    }
    const shared = this.installPromise
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      void shared.then(
        () => { signal.removeEventListener('abort', onAbort); resolve() },
        (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err) }
      )
    })
  }

  private runInstaller(): Promise<void> {
    const packagePath = requireFromHere.resolve('playwright-core/package.json')
    const cliPath = join(dirname(packagePath), 'cli.js')
    const browsersPath = join(this.userDataPath, 'headless-browsers')
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: process.versions.electron === undefined ? undefined : '1',
          PLAYWRIGHT_BROWSERS_PATH: browsersPath
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Managed Chromium download timed out after 10 minutes.'))
      }, INSTALL_TIMEOUT_MS)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000)
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else {
          this.logger.warn('[browser] managed Chromium installation failed', stderr)
          reject(new Error(`Unable to install managed Chromium${stderr === '' ? '.' : `: ${stderr.trim()}`}`))
        }
      })
    })
  }
}
