import type { BrowserChange, BrowserCuaEvent, BrowserProfile, BrowserTab } from '../../../shared/domain/browser'
import { invoke, on } from './ipc'

export function listBrowserTabs(workspaceId: string): Promise<BrowserTab[]> {
  return invoke('browser:list', { workspaceId })
}

export function openBrowserTab(
  workspaceId: string,
  url: string,
  title?: string,
  profileId?: string,
  clientTabId?: string
): Promise<BrowserTab> {
  return invoke('browser:open', {
    workspaceId,
    url,
    ...(title === undefined ? {} : { title }),
    ...(profileId === undefined ? {} : { profileId }),
    ...(clientTabId === undefined ? {} : { clientTabId })
  })
}

export function navigateBrowserTab(workspaceId: string, tabId: string, url: string): Promise<BrowserTab> {
  return invoke('browser:navigate', { workspaceId, tabId, url })
}

export function closeBrowserTab(workspaceId: string, tabId: string): Promise<void> {
  return invoke('browser:close', { workspaceId, tabId })
}

export function bindBrowserView(workspaceId: string, tabId: string, webContentsId: number): Promise<void> {
  return invoke('browser:bind', { workspaceId, tabId, webContentsId })
}

export function onBrowserCua(listener: (event: BrowserCuaEvent) => void): () => void {
  return on('browser:cua', listener)
}

export function onBrowserChanged(listener: (change: BrowserChange) => void): () => void {
  return on('browser:changed', listener)
}

export function listBrowserProfiles(): Promise<BrowserProfile[]> {
  return invoke('browser:profiles', undefined)
}

export function createBrowserProfile(input: { name: string; domains?: string[]; startUrl?: string }): Promise<BrowserProfile> {
  return invoke('browser:createProfile', input)
}

export function deleteBrowserProfile(id: string): Promise<void> {
  return invoke('browser:deleteProfile', { id })
}

export function exportBrowserCookies(workspaceId: string, profileId: string): Promise<boolean> {
  return invoke('browser:exportCookies', { workspaceId, profileId })
}

export function importBrowserCookies(workspaceId: string, profileId: string): Promise<number | null> {
  return invoke('browser:importCookies', { workspaceId, profileId })
}

export function clearBrowserProfileState(workspaceId: string, profileId: string): Promise<void> {
  return invoke('browser:clearProfileState', { workspaceId, profileId })
}
