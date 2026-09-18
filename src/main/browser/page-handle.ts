/*
 * Backend-neutral page behavior. Electron and Playwright provide only navigation, metadata,
 * capture, and a CDP transport; snapshot/ref/input semantics remain identical across backends.
 */
import type { BrowserCuaEvent, BrowserTabBackend, BrowserViewport } from '../../shared/domain/browser'
import { ulid } from '../../shared/util/id'
import { normalizeBrowserSnapshot } from './aria-snapshot'
import { CdpPageSession } from './cdp-session'
import { BrowserInputController } from './input'
import type {
  BrowserMouseButton,
  BrowserPageSnapshot,
  BrowserPoint,
  BrowserScreenshot
} from './runtime'
import { browserSnapshotExpression } from './snapshot-script'

export interface BrowserPageHandle {
  readonly backend: BrowserTabBackend
  readonly workspaceId: string
  readonly tabId: string
  navigate(url: string): Promise<void>
  snapshot(): Promise<BrowserPageSnapshot>
  click(ref: string, options?: { button?: BrowserMouseButton; clickCount?: number }): Promise<void>
  type(ref: string, text: string): Promise<void>
  press(keys: readonly string[], ref?: string): Promise<void>
  select(ref: string, values: readonly string[]): Promise<void>
  scroll(input: { x?: number; y?: number; scrollX: number; scrollY: number }): Promise<void>
  cuaClick(point: BrowserPoint, button?: BrowserMouseButton): Promise<void>
  cuaDrag(path: readonly BrowserPoint[], keys?: readonly string[]): Promise<void>
  screenshot(): Promise<BrowserScreenshot>
  info(): Promise<{ url: string; title: string; viewport: BrowserViewport }>
  invalidate(): void
  close(): Promise<void>
}

interface PageDelegates {
  navigate(url: string): Promise<void>
  url(): string
  title(): string | Promise<string>
  viewport(): Promise<BrowserViewport>
  screenshot(): Promise<BrowserScreenshot>
  close(): Promise<void>
}

export class CdpBrowserPage implements BrowserPageHandle {
  private readonly input: BrowserInputController

  constructor(
    readonly backend: BrowserTabBackend,
    readonly workspaceId: string,
    readonly tabId: string,
    private readonly session: CdpPageSession,
    private readonly delegates: PageDelegates,
    emit: (event: BrowserCuaEvent) => void
  ) {
    this.input = new BrowserInputController(session, delegates.viewport, (kind, point) => {
      if (backend !== 'iab') return
      emit({ workspaceId, tabId, kind, x: point.x, y: point.y, at: Date.now() })
    })
  }

  async navigate(url: string): Promise<void> {
    this.invalidate()
    await this.delegates.navigate(url)
  }

  async snapshot(): Promise<BrowserPageSnapshot> {
    const snapshotId = ulid()
    const snapshot = normalizeBrowserSnapshot(
      await this.session.evaluate<unknown>(browserSnapshotExpression(snapshotId))
    )
    this.input.setSnapshot(snapshot.snapshotId)
    return snapshot
  }

  click(ref: string, options: { button?: BrowserMouseButton; clickCount?: number } = {}): Promise<void> {
    return this.input.clickRef(ref, options.button, options.clickCount)
  }

  type(ref: string, text: string): Promise<void> {
    return this.input.typeRef(ref, text)
  }

  press(keys: readonly string[], ref?: string): Promise<void> {
    return this.input.press(keys, ref)
  }

  select(ref: string, values: readonly string[]): Promise<void> {
    return this.input.select(ref, values)
  }

  scroll(input: { x?: number; y?: number; scrollX: number; scrollY: number }): Promise<void> {
    return this.input.scroll(input)
  }

  cuaClick(point: BrowserPoint, button?: BrowserMouseButton): Promise<void> {
    return this.input.cuaClick(point, button)
  }

  cuaDrag(path: readonly BrowserPoint[], keys?: readonly string[]): Promise<void> {
    return this.input.cuaDrag(path, keys)
  }

  async screenshot(): Promise<BrowserScreenshot> {
    const screenshot = await this.delegates.screenshot()
    this.input.setScreenshotReady()
    return screenshot
  }

  async info(): Promise<{ url: string; title: string; viewport: BrowserViewport }> {
    return {
      url: this.delegates.url(),
      title: await this.delegates.title(),
      viewport: await this.delegates.viewport()
    }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  async close(): Promise<void> {
    this.invalidate()
    await Promise.allSettled([this.session.close(), this.delegates.close()])
  }
}
