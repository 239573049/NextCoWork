import { app, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionProfileInput, PreparedWorkspace, RemoteDirectory, SshAuthResponse } from '../../shared/domain/environment'
import { normalizeEnvironmentRef } from '../../shared/domain/environment'
import type { Workspace } from '../../shared/domain/workspace'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/domain/workspace'
import { DIR_LISTING_LIMIT } from '../../shared/domain/file-tree'
import { prefixedId } from '../../shared/util/id'
import { getEnvironments, getHost, installEnvironmentInteraction } from '../runtime'
import { abortable } from '../kernel/abort'
import { EnvironmentError } from '../environment/errors'
import type { EnvironmentConnection, EnvironmentLease } from '../environment/contract'
import { SshAuthBroker } from '../environment/ssh/askpass'
import { sshTargetArgs } from '../environment/ssh/command'
import { store } from '../state/store'
import { windows, type WindowContext } from '../window/registry'

let broker: SshAuthBroker | undefined
const requests = new Map<string, AbortController>()
const activations = new Map<number, AbortController>()
const observed = new Set<number>()
const browsers = new Map<string, { senderId: number; connectionId: string; environment: EnvironmentConnection; lease: EnvironmentLease; timer: NodeJS.Timeout; expires: number; roots?: string[] }>()
const prepared = new Map<number, { ticket: string; requestId: string; workspaceId: string; expires: number; timer: NodeJS.Timeout; lease: EnvironmentLease }>()
const activeLeases = new Map<number, Map<string, EnvironmentLease>>()

function dropPrepared(id: number): void {
  const pending = prepared.get(id)
  if (!pending) return
  prepared.delete(id)
  clearTimeout(pending.timer)
  pending.lease.release()
}

function dropBrowser(id: string): void {
  const browser = browsers.get(id)
  if (!browser) return
  browsers.delete(id)
  clearTimeout(browser.timer)
  browser.lease.release()
}

function observe(ctx: WindowContext): void {
  if (observed.has(ctx.id)) return
  observed.add(ctx.id)
  ctx.sender.once('destroyed', () => {
    observed.delete(ctx.id)
    dropPrepared(ctx.id)
    for (const lease of activeLeases.get(ctx.id)?.values() ?? []) lease.release()
    activeLeases.delete(ctx.id)
    broker?.cancelWindow(ctx.id)
    activations.get(ctx.id)?.abort()
    activations.delete(ctx.id)
    for (const [key, controller] of requests) if (key.startsWith(`${ctx.id}:`)) { controller.abort(); requests.delete(key) }
    for (const [key, browser] of browsers) if (browser.senderId === ctx.id) dropBrowser(key)
  })
}

async function operation<Value>(ctx: WindowContext, id: string, work: (signal: AbortSignal) => Promise<Value>, activation = false): Promise<Value> {
  if (typeof id !== 'string' || id.length < 8 || id.length > 128) throw new EnvironmentError('invalid-profile')
  observe(ctx)
  const key = `${ctx.id}:${id}`
  if (requests.has(key)) throw new EnvironmentError('conflict')
  const controller = new AbortController()
  requests.set(key, controller)
  if (activation) { activations.get(ctx.id)?.abort(); activations.set(ctx.id, controller) }
  try {
    const result = await abortable(() => work(controller.signal), controller.signal)
    controller.signal.throwIfAborted()
    return result
  } finally { requests.delete(key); if (activations.get(ctx.id) === controller) activations.delete(ctx.id) }
}

function browserFor(id: string, ctx: WindowContext): NonNullable<ReturnType<typeof browsers.get>> {
  const browser = browsers.get(id)
  if (!browser || browser.senderId !== ctx.id || browser.expires < Date.now()) throw new EnvironmentError('approval-expired')
  browser.environment.assertReady()
  browser.expires = Date.now() + 10 * 60_000
  browser.timer.refresh()
  return browser
}

async function directory(id: string, path: string, ctx: WindowContext, signal: AbortSignal): Promise<RemoteDirectory> {
  const browser = browserFor(id, ctx)
  const environment = browser.environment
  if (!environment.path.isAbsolute(path)) throw new EnvironmentError('invalid-path')
  const canonical = await abortable(() => environment.fs.realpath(path), signal)
  if (!(await abortable(() => environment.fs.stat(canonical), signal)).isDir) throw new EnvironmentError('invalid-path')
  if (!browser.roots) {
    if (environment.facts.os === 'win32') {
      const result = await environment.spawn('ConvertTo-Json -Compress -InputObject @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { $_.RootDirectory.FullName })', { cwd: canonical, signal, timeoutMs: 10_000 })
      if (result.code !== 0) throw new EnvironmentError('unsupported-platform')
      const roots: unknown = JSON.parse(result.stdout.trim())
      browser.roots = (Array.isArray(roots) ? roots : [roots]).filter((root): root is string => typeof root === 'string' && /^[a-z]:[\\/]$/i.test(root)).slice(0, 26)
    } else browser.roots = ['/']
  }
  const breadcrumbs: RemoteDirectory['breadcrumbs'] = []
  let ancestor = canonical
  for (let depth = 0; depth < 128; depth++) {
    const parent = environment.path.dirname(ancestor)
    breadcrumbs.unshift({ path: ancestor, name: parent === ancestor ? ancestor : environment.path.basename(ancestor) })
    if (parent === ancestor) break
    ancestor = parent
  }
  const entries = (await abortable(() => environment.fs.readDir(canonical), signal)).filter((entry) => entry.isDir)
  environment.assertReady()
  return { browseId: id, connectionId: browser.connectionId, facts: environment.facts, path: canonical,
    parent: environment.path.dirname(canonical), breadcrumbs, roots: browser.roots, truncated: entries.length > DIR_LISTING_LIMIT,
    entries: entries.slice(0, DIR_LISTING_LIMIT).sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({ name: entry.name, path: environment.path.join(canonical, entry.name) })) }
}

export function registerConnectionBridge(): void {
  broker = new SshAuthBroker(getHost().secrets, (senderId, request) => {
    const owner = windows.list().find((window) => window.id === senderId)
    if (!owner) { broker?.cancelWindow(senderId); return }
    windows.emitTo(owner.sender, 'connection:auth', request)
  })
  installEnvironmentInteraction((profile, senderId) => broker!.open(profile, senderId,
    { executable: process.execPath, ...(app.isPackaged ? {} : { appPath: app.getAppPath() }) }),
  (status) => windows.emitToAll('connection:status', status))
}

export function listConnections(): Array<{ profile: ConnectionProfile; status: ReturnType<ReturnType<typeof getEnvironments>['status']> }> {
  return store.listConnectionProfiles().map((profile) => ({ profile, status: getEnvironments().status(profile.id) }))
}

export async function upsertConnection(input: ConnectionProfileInput): Promise<ConnectionProfile> {
  if (!input || input.kind !== 'ssh' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120
    || !['auto', 'linux', 'darwin', 'win32'].includes(input.platform) || typeof input.enabled !== 'boolean'
    || (input.id !== undefined && (typeof input.id !== 'string' || input.id.length > 128))) throw new EnvironmentError('invalid-profile')
  const previous = input.id ? store.getConnectionProfile(input.id) : undefined
  if (previous && previous.revision !== input.revision) throw new EnvironmentError('conflict')
  const now = Date.now()
  const target = input.target
  const profile: ConnectionProfile = { id: previous?.id ?? randomUUID(), name: input.name.trim(), kind: 'ssh', enabled: input.enabled,
    platform: input.platform, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
    target: target?.kind === 'config' ? { kind: 'config', host: target.host, configFile: target.configFile }
      : { kind: 'manual', host: target?.host, port: target?.port, username: target?.username, identityFile: target?.identityFile, proxyJump: target?.proxyJump } }
  sshTargetArgs(profile)
  const identityChanged = previous && (JSON.stringify(previous.target) !== JSON.stringify(profile.target) || previous.platform !== profile.platform)
  if (identityChanged && !input.confirmTargetChange && store.listWorkspaces().some((workspace) => {
    const ref = normalizeEnvironmentRef(workspace.environment)
    return ref.kind === 'connection' && ref.connectionId === previous.id
  })) throw new EnvironmentError('approval-required')
  if (previous) await getEnvironments().disconnect(previous.id)
  store.putConnectionProfile(profile)
  windows.emitToAll('connection:changed', undefined)
  return profile
}

export async function removeConnection(id: string): Promise<void> {
  store.removeConnectionProfile(id)
  await getEnvironments().disconnect(id)
  windows.emitToAll('connection:changed', undefined)
}

export async function connectForBrowse(req: { id: string; requestId: string; allowLocalCommands: boolean }, ctx: WindowContext): Promise<RemoteDirectory> {
  return operation(ctx, req.requestId, async (signal) => {
    if (getEnvironments().status(req.id).phase !== 'ready' && req.allowLocalCommands !== true) throw new EnvironmentError('approval-required')
    const environment = await getEnvironments().connect(req.id, { senderId: ctx.id, signal })
    for (const [id, browser] of browsers) if (browser.expires < Date.now()) dropBrowser(id)
    if (browsers.size >= 64) throw new EnvironmentError('unsupported')
    signal.throwIfAborted()
    const id = randomUUID()
    const lease = getEnvironments().retain({ ...environment, rootPath: environment.facts.home })
    const timer = setTimeout(() => dropBrowser(id), 10 * 60_000)
    timer.unref()
    browsers.set(id, { senderId: ctx.id, connectionId: req.id, environment, lease, timer, expires: Date.now() + 10 * 60_000 })
    try { return await directory(id, environment.facts.home, ctx, signal) } catch (error) { dropBrowser(id); throw error }
  })
}

export function browseConnection(req: { browseId: string; path: string; requestId: string }, ctx: WindowContext): Promise<RemoteDirectory> {
  return operation(ctx, req.requestId, (signal) => directory(req.browseId, req.path, ctx, signal))
}
export function closeBrowse(id: string, ctx: WindowContext): void { if (browsers.get(id)?.senderId === ctx.id) dropBrowser(id) }
export function cancelConnectionRequest(id: string, ctx: WindowContext): void {
  requests.get(`${ctx.id}:${id}`)?.abort()
  if (prepared.get(ctx.id)?.requestId === id) dropPrepared(ctx.id)
}
export async function respondSshAuthentication(response: SshAuthResponse, ctx: WindowContext): Promise<void> {
  if (!broker) throw new EnvironmentError('authentication')
  await broker.respond(ctx.id, response)
}
export async function pickSshFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ['openFile', 'showHiddenFiles'] })
  return result.canceled ? null : result.filePaths[0] ?? null
}

export function prepareWorkspace(req: { workspaceId: string; requestId: string; allowLocalCommands?: boolean }, ctx: WindowContext): Promise<PreparedWorkspace> {
  return operation(ctx, req.requestId, async (signal) => {
    dropPrepared(ctx.id)
    const workspace = store.getWorkspace(req.workspaceId)
    if (!workspace) throw new EnvironmentError('unbound')
    const ref = normalizeEnvironmentRef(workspace?.environment)
    if (ref.kind === 'connection' && getEnvironments().status(ref.connectionId).phase !== 'ready' && !req.allowLocalCommands) throw new EnvironmentError('approval-required')
    const environment = await getEnvironments().prepare(req.workspaceId, { senderId: ctx.id, signal })
    signal.throwIfAborted()
    environment.assertReady()
    const ticket = randomUUID()
    const lease = getEnvironments().acquire(req.workspaceId)
    if (lease.environment.key !== environment.key) { lease.release(); throw new EnvironmentError('disconnected') }
    const timer = setTimeout(() => { if (prepared.get(ctx.id)?.ticket === ticket) dropPrepared(ctx.id) }, 30_000)
    timer.unref()
    prepared.set(ctx.id, { ticket, requestId: req.requestId, workspaceId: req.workspaceId, expires: Date.now() + 30_000, lease, timer })
    return { ticket, workspaceId: req.workspaceId, rootPath: environment.rootPath, environmentKey: environment.key, generation: environment.generation }
  }, true)
}

export function commitWorkspaceActivation(req: { ticket: string; requestId: string }, ctx: WindowContext): void {
  const pending = prepared.get(ctx.id)
  if (!pending || pending.ticket !== req.ticket || pending.requestId !== req.requestId || pending.expires < Date.now()) throw new EnvironmentError('approval-expired')
  pending.lease.environment.assertReady()
  const workspace = store.getWorkspace(pending.workspaceId)
  if (!workspace || getEnvironments().get(workspace.id).key !== pending.lease.environment.key) throw new EnvironmentError('disconnected')
  prepared.delete(ctx.id)
  clearTimeout(pending.timer)
  const leases = activeLeases.get(ctx.id) ?? new Map<string, EnvironmentLease>()
  leases.set(pending.ticket, pending.lease)
  activeLeases.set(ctx.id, leases)
  store.putWorkspace({ ...workspace, lastOpenedAt: Date.now(), unavailable: false })
}

export function releaseWorkspaceActivation(ticket: string, ctx: WindowContext): void {
  const leases = activeLeases.get(ctx.id)
  leases?.get(ticket)?.release()
  leases?.delete(ticket)
  if (leases?.size === 0) activeLeases.delete(ctx.id)
}

export function createSshWorkspace(req: { browseId: string; path: string; requestId: string }, ctx: WindowContext): Promise<Workspace> {
  return operation(ctx, req.requestId, async (signal) => {
    const listing = await directory(req.browseId, req.path, ctx, signal)
    const browser = browserFor(req.browseId, ctx)
    signal.throwIfAborted()
    const existing = store.listWorkspaces().find((workspace) => {
      const ref = normalizeEnvironmentRef(workspace.environment)
      return ref.kind === 'connection' && ref.connectionId === browser.connectionId && workspace.rootPath === listing.path
    })
    const now = Date.now()
    const workspace = store.putWorkspace(existing ? { ...existing, unavailable: false } : {
      id: prefixedId('ws'), name: `${store.getConnectionProfile(browser.connectionId)?.name ?? 'SSH'}: ${browser.environment.path.basename(listing.path) || listing.path}`, rootPath: listing.path,
      environment: { kind: 'connection', connectionId: browser.connectionId }, settings: structuredClone(DEFAULT_WORKSPACE_SETTINGS), createdAt: now, lastOpenedAt: 0
    })
    windows.emitToAll('workspace:changed', { workspaces: store.listWorkspaces() })
    return workspace
  })
}