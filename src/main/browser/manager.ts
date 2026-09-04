import type { BrowserChange, BrowserProfile, BrowserTab } from '../../shared/domain/browser'
import { ulid } from '../../shared/util/id'
import { store } from '../state/store'

const PROFILES_KEY = 'browser.profiles'
const DEFAULT_PROFILE_ID = 'default'

export interface BrowserOpenInput {
  workspaceId: string
  url: string
  title?: string
  source: 'user' | 'agent'
  ownerRunId?: string
  profileId?: string
  openRightPanel?: boolean
}

export interface BrowserManagerListener {
  (change: BrowserChange): void
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('浏览器只支持完整的 http:// 或 https:// 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('浏览器只支持 http:// 或 https:// 地址')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('浏览器地址不能包含用户名或密码')
  }
  return parsed.href
}

/**
 * 进程内浏览器会话目录。它不持有 Electron BrowserWindow，因此 Agent 工具
 * 和渲染层可以共享同一份可验证状态，而不会把 webContents 泄露给工具层。
 */
class BrowserManager {
  private readonly tabs = new Map<string, BrowserTab>()
  private profiles: BrowserProfile[] | null = null
  private listener: BrowserManagerListener | null = null

  setListener(listener: BrowserManagerListener | null): void {
    this.listener = listener
  }

  listProfiles(): BrowserProfile[] {
    this.ensureProfiles()
    return this.profiles!.map((profile) => ({ ...profile, domains: [...profile.domains] }))
  }

  createProfile(name: string, domains: readonly string[] = [], startUrl?: string): BrowserProfile {
    this.ensureProfiles()
    const cleanName = name.trim()
    if (cleanName === '') throw new Error('Profile 名称不能为空')
    if (cleanName.length > 80) throw new Error('Profile 名称不能超过 80 个字符')
    const cleanStartUrl = startUrl?.trim() ?? ''
    let normalizedStartUrl: string | undefined
    if (cleanStartUrl !== '') {
      const parsed = new URL(cleanStartUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('默认打开 URL 只支持 http:// 或 https:// 地址')
      if (parsed.username !== '' || parsed.password !== '') throw new Error('默认打开 URL 不能包含用户名或密码')
      normalizedStartUrl = parsed.href
    }
    const profile: BrowserProfile = {
      id: ulid(),
      name: cleanName,
      isDefault: false,
      domains: [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))].slice(0, 30),
      ...(normalizedStartUrl === undefined ? {} : { startUrl: normalizedStartUrl }),
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    }
    this.profiles = [...this.profiles!, profile]
    this.persistProfiles()
    return { ...profile, domains: [...profile.domains] }
  }

  deleteProfile(id: string): void {
    this.ensureProfiles()
    const profile = this.profiles!.find((item) => item.id === id)
    if (profile === undefined) throw new Error('Profile 不存在')
    if (profile.isDefault || profile.id === DEFAULT_PROFILE_ID) throw new Error('默认浏览器不能删除')
    this.profiles = this.profiles!.filter((item) => item.id !== id)
    const affectedWorkspaces = new Set<string>()
    for (const [tabId, tab] of this.tabs) {
      if (tab.profileId !== id) continue
      this.tabs.delete(tabId)
      affectedWorkspaces.add(tab.workspaceId)
    }
    this.persistProfiles()
    for (const workspaceId of affectedWorkspaces) this.emit(workspaceId)
  }

  list(workspaceId: string): BrowserTab[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): BrowserTab | undefined {
    return this.tabs.get(id)
  }

  open(input: BrowserOpenInput): BrowserTab {
    if (input.profileId !== undefined && !this.listProfiles().some((profile) => profile.id === input.profileId)) {
      throw new Error('指定的浏览器 Profile 不存在')
    }
    const now = Date.now()
    const url = normalizeUrl(input.url)
    if (input.profileId !== undefined) {
      this.ensureProfiles()
      this.profiles = this.profiles!.map((profile) =>
        profile.id === input.profileId ? { ...profile, lastUsedAt: now } : profile
      )
      this.persistProfiles()
    }
    const tab: BrowserTab = {
      id: ulid(),
      workspaceId: input.workspaceId,
      ...(input.ownerRunId === undefined ? {} : { ownerRunId: input.ownerRunId }),
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      source: input.source,
      url,
      title: input.title?.trim() || new URL(url).hostname,
      status: 'loading',
      createdAt: now,
      updatedAt: now
    }
    this.tabs.set(tab.id, tab)
    this.emit(tab.workspaceId, input.openRightPanel === true)
    return tab
  }

  navigate(id: string, url: string, actorRunId?: string): BrowserTab {
    const tab = this.requireOwned(id, actorRunId)
    const next: BrowserTab = {
      ...tab,
      url: normalizeUrl(url),
      status: 'loading',
      updatedAt: Date.now()
    }
    this.tabs.set(id, next)
    this.emit(next.workspaceId)
    return next
  }

  update(id: string, patch: { url?: string; title?: string; status?: BrowserTab['status'] }, actorRunId?: string): BrowserTab {
    const tab = this.requireOwned(id, actorRunId)
    const next: BrowserTab = {
      ...tab,
      ...(patch.url === undefined ? {} : { url: normalizeUrl(patch.url) }),
      ...(patch.title === undefined ? {} : { title: patch.title.trim() || tab.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: Date.now()
    }
    this.tabs.set(id, next)
    this.emit(next.workspaceId)
    return next
  }

  close(id: string, actorRunId?: string): void {
    const tab = this.requireOwned(id, actorRunId)
    this.tabs.delete(id)
    this.emit(tab.workspaceId)
  }

  closeWorkspace(workspaceId: string): void {
    let changed = false
    for (const [id, tab] of this.tabs) {
      if (tab.workspaceId === workspaceId) {
        this.tabs.delete(id)
        changed = true
      }
    }
    if (changed) this.emit(workspaceId)
  }

  private requireOwned(id: string, actorRunId?: string): BrowserTab {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`浏览器标签不存在: ${id}`)
    if (actorRunId !== undefined && (tab.source !== 'agent' || tab.ownerRunId !== actorRunId)) {
      throw new Error('只能操作当前 Agent 打开的浏览器标签')
    }
    return tab
  }

  private emit(workspaceId: string, rightPanelOpen = false): void {
    this.listener?.({ workspaceId, tabs: this.list(workspaceId), ...(rightPanelOpen ? { rightPanelOpen: true } : {}) })
  }

  private ensureProfiles(): void {
    if (this.profiles !== null) return
    const fallback: BrowserProfile = {
      id: DEFAULT_PROFILE_ID,
      name: 'Default browser',
      isDefault: true,
      domains: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    }
    try {
      const raw = store.getKv<unknown>(PROFILES_KEY, null)
      if (Array.isArray(raw)) {
        const valid = raw.filter((item): item is BrowserProfile => {
          if (typeof item !== 'object' || item === null) return false
          const value = item as Record<string, unknown>
          return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.isDefault === 'boolean' && Array.isArray(value.domains)
        })
        if (valid.some((item) => item.isDefault && item.id === DEFAULT_PROFILE_ID)) {
          this.profiles = valid.map((item) => ({ ...item, domains: item.domains.filter((domain): domain is string => typeof domain === 'string') }))
          return
        }
      }
    } catch {
      // The in-memory fallback is useful for headless tool tests before SQLite opens.
    }
    this.profiles = [fallback]
    this.persistProfiles()
  }

  private persistProfiles(): void {
    try {
      store.setKv(PROFILES_KEY, this.profiles)
    } catch {
      // Ignore persistence errors; browser sessions remain usable for this run.
    }
  }
}

export const browserManager = new BrowserManager()

export function setBrowserChangeListener(listener: BrowserManagerListener | null): void {
  browserManager.setListener(listener)
}
