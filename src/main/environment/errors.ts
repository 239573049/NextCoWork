export { EnvironmentError } from '../../shared/domain/environment'

export function errorCode(error: unknown): string | number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string | number }).code : undefined
}

export function missingPath(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR' || errorCode(error) === 2
}

export function sftpError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'SFTP request failed'
  const code = errorCode(error)
  const normalized = code === 2 ? 'ENOENT' : code === 3 ? 'EACCES' : code === 8 ? 'ENOTSUP' : code
  return Object.assign(new Error(message), { code: normalized })
}