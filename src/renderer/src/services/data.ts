/** 设置 › 数据的唯一渲染层服务入口。组件不直接引用 storage:* 频道。 */
import type {
  BackupStatus,
  CleanupAge,
  CleanupPreview,
  CleanupResult,
  ImportApplyResult,
  ImportPreview,
  RestoreResult
} from '../../../shared/domain/data'
import type { StorageStats } from '../../../shared/domain/settings'
import { invoke } from './ipc'

export function getStats(): Promise<StorageStats> {
  return invoke('storage:getStats', undefined)
}

export function openDataDirectory(): Promise<void> {
  return invoke('storage:openDataDirectory', undefined)
}

export function vacuum(): Promise<StorageStats> {
  return invoke('storage:vacuum', undefined)
}

export function exportData(options: { includeEncryptedKeys?: boolean; password?: string } = {}): Promise<{ path: string; encrypted: boolean; bytes: number } | null> {
  return invoke('storage:export', options)
}

export function importPreview(): Promise<ImportPreview | null> {
  return invoke('storage:importPreview', undefined)
}

export function importApply(password?: string): Promise<ImportApplyResult> {
  return invoke('storage:importApply', password === undefined ? {} : { password })
}

export function chooseBackupDirectory(): Promise<string | null> {
  return invoke('storage:chooseBackupDirectory', undefined)
}

export function getBackupStatus(): Promise<BackupStatus> {
  return invoke('storage:getBackupStatus', undefined)
}

export function createBackup(manual = true): Promise<BackupStatus> {
  return invoke('storage:createBackup', { manual })
}

export function restoreBackup(confirm = false): Promise<RestoreResult | null> {
  return invoke('storage:restoreBackup', { confirm })
}

export function cleanupPreview(kind: CleanupPreview['kind'], age?: CleanupAge): Promise<CleanupPreview> {
  return invoke('storage:cleanupPreview', age === undefined ? { kind } : { kind, age })
}

export function cleanupAttachments(): Promise<CleanupResult> {
  return invoke('storage:cleanupAttachments', undefined)
}

export function cleanupByAge(age: CleanupAge): Promise<CleanupResult> {
  return invoke('storage:cleanupByAge', { age })
}

export function clearHistory(): Promise<CleanupResult> {
  return invoke('storage:clearHistory', undefined)
}

export function clearLocalData(confirm: boolean): Promise<{ deleted: boolean }> {
  return invoke('storage:clearLocalData', { confirm })
}

