import type {
  WorkspaceFileMutationRequest,
  WorkspaceFileOperation,
} from '../../../../shared/domain/workspace-file'

export interface FileOperationTarget {
  operation: WorkspaceFileOperation
  /** Parent directory for creation, source item for all other operations. */
  path: string
  name: string
}

export type FileOperationValidation =
  | { request: WorkspaceFileMutationRequest; error?: never }
  | {
      request?: never
      error:
        | 'files.manage.invalidName'
        | 'files.manage.invalidDestination'
        | 'files.manage.unchanged'
    }

export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}

export function operationRequest(
  workspaceId: string,
  target: FileOperationTarget,
  value: string,
): FileOperationValidation {
  const { operation, path } = target
  if (operation === 'delete') return { request: { workspaceId, operation, path } }

  const name = value.trim()
  const containsControl = [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  const destinationOperation = operation === 'copy' || operation === 'move'
  if (destinationOperation) {
    if (
      name === '' ||
      name.includes('\\') ||
      containsControl ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      return { error: 'files.manage.invalidDestination' }
    }
  } else if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name) || containsControl) {
    return { error: 'files.manage.invalidName' }
  }

  if (operation === 'create-file' || operation === 'create-directory') {
    return { request: { workspaceId, operation, path: path === '' ? name : `${path}/${name}` } }
  }
  const parent = parentPath(path)
  const destination = destinationOperation ? name : parent === '' ? name : `${parent}/${name}`
  if (destination === path) return { error: 'files.manage.unchanged' }
  return { request: { workspaceId, operation, path, destination } }
}
