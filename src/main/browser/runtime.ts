/*
 * BrowserAutomationBridge is the kernel-safe port to the Electron/Playwright page runtime.
 *
 * ★ This file must stay free of `electron` and `playwright-core` imports. Browser tools run in
 * plain Node tests; pulling either runtime through this edge would make importing the tool
 * registry require a graphical Electron process. `bindings.ts` installs the production bridge.
 */
import type {
  BrowserCuaEvent,
  BrowserTab,
  BrowserTabBackend,
  BrowserViewport
} from '../../shared/domain/browser'

export type BrowserMouseButton = 'left' | 'right' | 'middle'

export interface BrowserPoint {
  x: number
  y: number
}

export interface BrowserPageSnapshot {
  tree: string
  title: string
  url: string
  snapshotId: string
  viewport: BrowserViewport
  truncated: boolean
}

export interface BrowserScreenshot {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  viewport: BrowserViewport
}

export interface BrowserRuntimeTabInfo {
  bound: boolean
  backend: BrowserTabBackend
  viewport?: BrowserViewport
}

export interface BrowserAutomationBridge {
  bindIab(input: {
    workspaceId: string
    tabId: string
    webContentsId: number
  }): Promise<BrowserViewport>
  openHeadless(input: {
    workspaceId: string
    tabId: string
    profileId?: string
    url: string
    signal: AbortSignal
  }): Promise<BrowserViewport>
  waitFor(tabId: string, signal: AbortSignal, timeoutMs?: number): Promise<void>
  info(tabId: string): BrowserRuntimeTabInfo | undefined
  navigate(tabId: string, url: string): Promise<void>
  snapshot(tabId: string): Promise<BrowserPageSnapshot>
  click(tabId: string, ref: string, options?: {
    button?: BrowserMouseButton
    clickCount?: number
  }): Promise<void>
  type(tabId: string, ref: string, text: string): Promise<void>
  press(tabId: string, keys: readonly string[], ref?: string): Promise<void>
  select(tabId: string, ref: string, values: readonly string[]): Promise<void>
  scroll(tabId: string, input: {
    x?: number
    y?: number
    scrollX: number
    scrollY: number
  }): Promise<void>
  cuaClick(tabId: string, point: BrowserPoint, button?: BrowserMouseButton): Promise<void>
  cuaDrag(tabId: string, path: readonly BrowserPoint[], keys?: readonly string[]): Promise<void>
  screenshot(tabId: string): Promise<BrowserScreenshot>
  release(tabId: string): Promise<void>
  clearProfile(profileId: string, workspaceId?: string): Promise<void>
  reconcile(workspaceId: string, tabs: readonly BrowserTab[]): void
  setCuaListener(listener: ((event: BrowserCuaEvent) => void) | null): void
  shutdown(): Promise<void>
}

let installed: BrowserAutomationBridge | null = null

export function installBrowserAutomationBridge(bridge: BrowserAutomationBridge | null): void {
  installed = bridge
}

export function getBrowserAutomationBridge(): BrowserAutomationBridge {
  if (installed === null) {
    throw new Error('Browser automation runtime is unavailable in this process.')
  }
  return installed
}
