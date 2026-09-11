export type EnvironmentRef =
  | { kind: 'local' }
  | { kind: 'connection'; connectionId: string }
  | { kind: 'unbound' }

export type SshTarget =
  | { kind: 'config'; host: string; configFile?: string }
  | { kind: 'manual'; host: string; port: number; username: string; identityFile?: string; proxyJump?: string }

export interface SshConnectionProfile {
  id: string
  kind: 'ssh'
  name: string
  target: SshTarget
  platform: 'auto' | 'linux' | 'darwin' | 'win32'
  enabled: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

export type ConnectionProfile = SshConnectionProfile

export type ConnectionPhase = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'error'

export type EnvironmentErrorCode =
  | 'unbound' | 'disabled' | 'invalid-profile' | 'connection-in-use'
  | 'ssh-unavailable' | 'unsupported-client' | 'unsupported-config'
  | 'connection-failed' | 'disconnected' | 'timeout' | 'cancelled'
  | 'authentication' | 'host-key' | 'sftp-unavailable' | 'unsupported-platform'
  | 'invalid-path' | 'not-found' | 'permission' | 'unsupported'
  | 'conflict' | 'result-unknown' | 'approval-required' | 'approval-expired'

export class EnvironmentError extends Error {
  constructor(readonly code: EnvironmentErrorCode, readonly detail?: string) {
    super(`environment:${code}${detail ? ` ${detail}` : ''}`)
    this.name = 'EnvironmentError'
  }
}

export interface ConnectionStatus {
  connectionId: string
  phase: ConnectionPhase
  generation: number
  error?: EnvironmentErrorCode
  detail?: string
}

export interface EnvironmentFacts {
  os: string
  osVersion: string
  shell: string
  home: string
  hostname: string
  username: string
}

export interface SshAuthRequest {
  id: string
  connectionId: string
  connectionName: string
  prompt: string
  kind: 'host-key' | 'password' | 'passphrase' | 'challenge'
  canRemember: boolean
  hasSaved: boolean
}

export interface SshAuthResponse {
  id: string
  value?: string
  cancelled?: boolean
  remember?: boolean
  useSaved?: boolean
}

export type ConnectionProfileInput = Omit<SshConnectionProfile, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & {
  id?: string
  revision?: number
  confirmTargetChange?: boolean
}

export interface RemoteDirectory {
  browseId: string
  connectionId: string
  path: string
  parent: string
  facts: EnvironmentFacts
  entries: Array<{ name: string; path: string }>
  breadcrumbs: Array<{ name: string; path: string }>
  roots: string[]
  truncated: boolean
}

export interface PreparedWorkspace {
  ticket: string
  workspaceId: string
  rootPath: string
  environmentKey: string
  generation: number
}

export function normalizeEnvironmentRef(value: unknown): EnvironmentRef {
  if (value === undefined) return { kind: 'local' }
  if (typeof value !== 'object' || value === null) return { kind: 'unbound' }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'local') return { kind: 'local' }
  if (candidate.kind === 'connection' && typeof candidate.connectionId === 'string' && candidate.connectionId.trim() !== '') {
    return { kind: 'connection', connectionId: candidate.connectionId }
  }
  return { kind: 'unbound' }
}

export function environmentKey(value: EnvironmentRef | undefined): string {
  const ref = normalizeEnvironmentRef(value)
  return ref.kind === 'connection' ? JSON.stringify(['connection', ref.connectionId]) : ref.kind
}

export function isLocalEnvironment(value: EnvironmentRef | undefined): boolean {
  return normalizeEnvironmentRef(value).kind === 'local'
}

export function connectionSecretRef(connectionId: string, kind: 'password' | 'passphrase'): string {
  return `connection:${connectionId}:${kind}`
}