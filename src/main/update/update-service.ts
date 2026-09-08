import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, UpdateProgress, UpdateState } from '../../shared/domain/update'
import { windows } from '../window/registry'

const FEED_URL = 'https://nextco.work/api/client/updates/feed/stable/'

function currentVersion(): string {
  return typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function platformSupported(): boolean {
  return (process.platform === 'win32' && process.arch === 'x64') ||
    (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')) ||
    (process.platform === 'linux' && process.arch === 'x64')
}

function asUpdateInfo(raw: Record<string, unknown>): UpdateInfo {
  if (typeof raw.version !== 'string' || raw.version.length === 0) throw new Error('invalid-metadata')
  return {
    version: raw.version,
    releaseDate: typeof raw.releaseDate === 'string' ? raw.releaseDate : undefined,
    releaseNotes: typeof raw.releaseNotes === 'string' ? raw.releaseNotes : undefined,
    mandatory: raw.mandatory === true,
    minimumSupportedVersion: typeof raw.minimumSupportedVersion === 'string' ? raw.minimumSupportedVersion : undefined,
    graceUntil: typeof raw.graceUntil === 'string' ? raw.graceUntil : undefined
  }
}

class UpdateService {
  private state: UpdateState = { state: 'idle', currentVersion: currentVersion() }
  private configured = false
  private operation: Promise<UpdateState> | null = null

  configure(): void {
    if (this.configured) return
    this.configured = true
    if (!app) return
    this.state = app.isPackaged
      ? { state: 'idle', currentVersion: currentVersion() }
      : { state: 'disabled', currentVersion: currentVersion() }
    if (!app.isPackaged || !platformSupported()) {
      if (app.isPackaged) this.publish({ state: 'error', currentVersion: currentVersion(), code: 'unsupported-platform' })
      return
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL })
    autoUpdater.on('checking-for-update', () => this.publish({ state: 'checking', currentVersion: currentVersion() }))
    autoUpdater.on('update-available', (raw) => {
      try {
        this.publish({ state: 'available', currentVersion: currentVersion(), update: asUpdateInfo(raw as unknown as Record<string, unknown>) })
      } catch {
        this.publish({ state: 'error', currentVersion: currentVersion(), code: 'invalid-metadata' })
      }
    })
    autoUpdater.on('update-not-available', () => this.publish({ state: 'up-to-date', currentVersion: currentVersion() }))
    autoUpdater.on('download-progress', (progress) => {
      const previous = this.state
      if (!('update' in previous)) return
      const p: UpdateProgress = {
        percent: Math.max(0, Math.min(100, progress.percent)),
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      this.publish({ state: 'downloading', currentVersion: currentVersion(), update: previous.update, progress: p })
    })
    autoUpdater.on('update-downloaded', (raw) => {
      try {
        this.publish({ state: 'downloaded', currentVersion: currentVersion(), update: asUpdateInfo(raw as unknown as Record<string, unknown>) })
      } catch {
        this.publish({ state: 'error', currentVersion: currentVersion(), code: 'invalid-metadata' })
      }
    })
    autoUpdater.on('error', (error) => {
      const text = error instanceof Error ? error.message.toLowerCase() : ''
      const code = text.includes('checksum') || text.includes('sha') ? 'checksum-mismatch' :
        text.includes('download') ? 'download-failed' : 'network'
      this.publish({ state: 'error', currentVersion: currentVersion(), code })
    })
  }

  getState(): UpdateState {
    return this.state
  }

  /** Main-process guard used by Agent IPC; Renderer cannot bypass mandatory updates. */
  canStartNewRuns(): boolean {
    if (this.state.state !== 'available' && this.state.state !== 'downloading' && this.state.state !== 'downloaded') return true
    const update = this.state.update
    if (!update.mandatory || !update.minimumSupportedVersion) return true
    if (update.graceUntil && Date.parse(update.graceUntil) > Date.now()) return true
    return compareVersions(currentVersion(), update.minimumSupportedVersion) >= 0
  }

  async check(): Promise<UpdateState> {
    this.configure()
    if (!app.isPackaged) return this.state
    if (!platformSupported()) return this.state
    if (this.operation) return this.operation
    this.operation = autoUpdater.checkForUpdates()
      .then(() => this.state)
      .catch(() => {
        this.publish({ state: 'error', currentVersion: currentVersion(), code: 'network' })
        return this.state
      })
      .finally(() => { this.operation = null })
    return this.operation
  }

  async download(): Promise<UpdateState> {
    this.configure()
    if (!app.isPackaged) return this.state
    if (!platformSupported()) return this.state
    if (this.operation) return this.operation
    this.operation = autoUpdater.downloadUpdate()
      .then(() => this.state)
      .catch(() => {
        this.publish({ state: 'error', currentVersion: currentVersion(), code: 'download-failed' })
        return this.state
      })
      .finally(() => { this.operation = null })
    return this.operation
  }

  install(): void {
    this.configure()
    if (!app.isPackaged || this.state.state !== 'downloaded') return
    this.publish({ state: 'installing', currentVersion: currentVersion(), update: this.state.update })
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch {
      this.publish({ state: 'error', currentVersion: currentVersion(), code: 'install-failed' })
    }
  }

  private publish(state: UpdateState): void {
    this.state = state
    windows.emitToAll('app:updateChanged', state)
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const core = value.replace(/^v/, '').split('-')[0]!.split('+')[0]!.split('.').map((part) => Number(part) || 0)
    return [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0]
  }
  const a = parse(left); const b = parse(right)
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

export const updateService = new UpdateService()
