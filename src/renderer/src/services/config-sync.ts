import type { SyncConflict, SyncPreview, SyncStatus } from '../../../shared/domain/config-sync'
import { invoke } from './ipc'

export function getStatus(): Promise<SyncStatus> {
  return invoke('configSync:getStatus', undefined)
}

export function getConflicts(): Promise<SyncConflict[]> {
  return invoke('configSync:getConflicts', undefined)
}

export function getPreview(): Promise<SyncPreview> {
  return invoke('configSync:getPreview', undefined)
}

export function confirmInitial(): Promise<void> {
  return invoke('configSync:confirmInitial', undefined)
}

export function resolve(id: string, useRemote: boolean): Promise<void> {
  return invoke('configSync:resolve', { id, useRemote })
}
