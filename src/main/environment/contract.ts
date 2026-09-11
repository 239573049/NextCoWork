import type { Readable, Writable } from 'node:stream'
import type { Socket } from 'node:net'
import type { EnvironmentFacts } from '../../shared/domain/environment'
import type { KernelFs, WorkspaceHost } from '../kernel/host'

export interface EnvironmentStat {
  size: number
  mtimeMs: number
  mode: number
  isDir: boolean
  isFile: boolean
  isSymbolicLink: boolean
}

export interface EnvironmentFs extends KernelFs {
  stat(path: string): Promise<EnvironmentStat>
  lstat(path: string): Promise<EnvironmentStat>
  readBytes(path: string, maxBytes?: number): Promise<Buffer>
  writeBytes(path: string, bytes: Uint8Array, options?: { exclusive?: boolean; mode?: number }): Promise<void>
  copyFile(source: string, destination: string, maxBytes: number, mode?: number): Promise<number>
  mkdir(path: string): Promise<void>
  rename(source: string, destination: string, replace?: boolean): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
}

export interface EnvironmentProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exited: Promise<{ code: number | null; signal?: string | null }>
  kill(): void
}

export interface TerminalDriver {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
}

export interface WorkspaceEnvironment extends WorkspaceHost {
  generation: number
  terminalShell?: string
  fs: EnvironmentFs
  facts: EnvironmentFacts
  assertReady(): void
  openProcess(command: string, args: readonly string[], options: { cwd: string; env?: Record<string, string> }): Promise<EnvironmentProcess>
  openTerminal(options: { cwd: string; cols: number; rows: number }): Promise<TerminalDriver>
  openTcp?(hostname: string, port: number): Promise<Socket>
}

export interface EnvironmentConnection extends Omit<WorkspaceEnvironment, 'rootPath'> {
  close(): Promise<void>
}

export interface EnvironmentLease {
  environment: WorkspaceEnvironment
  release(): void
}