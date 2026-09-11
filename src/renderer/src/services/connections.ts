import type { ConnectionProfileInput, SshAuthResponse } from '../../../shared/domain/environment'
import type { InvokeReq } from '../../../shared/ipc/contract'
import { AgentErrorException, invoke, on } from './ipc'

export const listConnections = () => invoke('connection:list', undefined)
export const saveConnection = (profile: ConnectionProfileInput) => invoke('connection:upsert', profile)
export const removeConnection = (id: string) => invoke('connection:remove', { id })
export const connectForBrowse = (id: string, requestId: string, allowLocalCommands: boolean) => invoke('connection:connect', { id, requestId, allowLocalCommands })
export const browseConnection = (browseId: string, path: string, requestId: string) => invoke('connection:browse', { browseId, path, requestId })
export const closeBrowse = (browseId: string) => invoke('connection:closeBrowse', { browseId })
export const cancelConnectionRequest = (requestId: string) => invoke('connection:cancel', { requestId })
export const disconnectConnection = (id: string) => invoke('connection:disconnect', { id })
export const pickSshFile = () => invoke('connection:pickFile', undefined)
export const respondSshAuthentication = (response: SshAuthResponse) => invoke('connection:respond', response)
export const prepareWorkspace = (request: InvokeReq<'workspace:prepare'>) => invoke('workspace:prepare', request)
export const commitWorkspaceActivation = (ticket: string, requestId: string) => invoke('workspace:commitActivation', { ticket, requestId })
export const releaseWorkspaceActivation = (ticket: string) => invoke('workspace:releaseActivation', { ticket })
export const createSshWorkspace = (browseId: string, path: string, requestId: string) => invoke('workspace:createSsh', { browseId, path, requestId })
export const onConnectionStatus = (listener: Parameters<typeof on<'connection:status'>>[1]) => on('connection:status', listener)
export const onConnectionsChanged = (listener: () => void) => on('connection:changed', listener)
export const onSshAuthentication = (listener: Parameters<typeof on<'connection:auth'>>[1]) => on('connection:auth', listener)
export function connectionErrorKey(error: unknown): string {
  return error instanceof AgentErrorException && error.error.environmentCode
    ? `environment.error.${error.error.environmentCode}` : 'environment.error.connection-failed'
}