import type { ClientAuthState, ClientAuthUser, ClientUsageEntry } from '../../../shared/domain/client-auth'
import { invoke } from './ipc'

export const getClientAuthState = (): Promise<ClientAuthState> => invoke('clientAuth:getState', undefined)
export const startClientLogin = (): Promise<ClientAuthState> => invoke('clientAuth:startLogin', undefined)
export const useOffline = (): Promise<ClientAuthState> => invoke('clientAuth:useOffline', undefined)
export const signOutClient = (): Promise<ClientAuthState> => invoke('clientAuth:signOut', undefined)
export const getClientUser = (): Promise<ClientAuthUser | null> => invoke('clientAuth:getUser', undefined)
export const getClientUsage = (range: { from?: string; to?: string } = {}): Promise<ClientUsageEntry[]> => invoke('clientAuth:getUsage', range)
