export type EnvironmentRef =
  | { kind: 'local' }
  | { kind: 'connection'; connectionId: string }
  | { kind: 'unbound' }

export type SshTarget =
  | { kind: 'config'; host: string; configFile?: string; identityFile?: string }
  | { kind: 'manual'; host: string; port: number; username: string; identityFile?: string; proxyJump?: string }

export const SSH_AUTH_METHODS = ['auto', 'password', 'key', 'interactive', 'ask'] as const
export type SshAuthMethod = typeof SSH_AUTH_METHODS[number]

export interface SshConnectionProfile {
  id: string
  kind: 'ssh'
  name: string
  target: SshTarget
  /** Omitted on older profiles: preserve the system OpenSSH authentication configuration. */
  authMethod?: SshAuthMethod
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
  /**
   * 这一次是**因为已保存的密码被服务器拒绝**才弹出来的。
   *
   * ★ 没有这个标记,用户看到的就是"我明明在连接里存了密码,它还是问我" ——
   * 而真正发生的是那个密码不对。界面要把这件事说出来,否则用户会去怀疑功能坏了。
   */
  savedRejected?: boolean
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
  /**
   * 表单里填的账户密码。**传输期字段 —— 绝不写进 `connection_profiles` 行。**
   *
   * 主进程把它剥下来存进 `credentials`(safeStorage 加密),profile 本身逐字段构造,
   * 天然带不上它。三种取值:`undefined` 不动已存的、`''`/`null` 清除、非空写入。
   *
   * ★ 它不会被"发给 ssh"—— OpenSSH 不接受任何非交互方式传入的密码。它只是被存下来,
   * 等 ssh 自己通过 SSH_ASKPASS 问密码时由 broker 代答(见 `ssh/askpass.ts`)。
   */
  password?: string | null
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
