import { createHash } from 'node:crypto'
import { WORKSPACE_IMAGE_LIMIT, WORKSPACE_TEXT_LIMIT, type WorkspaceFile } from '../../shared/domain/workspace-file'

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
}
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.pyc', '.sqlite', '.sqlite3', '.db', '.mp3', '.wav', '.ogg', '.flac',
  '.mp4', '.mov', '.webm', '.avi', '.woff', '.woff2', '.ttf', '.otf', '.heic', '.tif', '.tiff', '.psd', '.dmg', '.iso'
])

export const contentRevision = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const workspaceReadLimit = (extension: string): number => IMAGE_MIME[extension] ? WORKSPACE_IMAGE_LIMIT : WORKSPACE_TEXT_LIMIT
export function decodeWorkspaceText(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return undefined }
}
export function isBinaryText(content: string): boolean {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    if (code <= 8 || code === 11 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

export function classifyWorkspaceFile(path: string, extension: string, bytes: Buffer | undefined,
  stat: { size: number; mtimeMs: number; ctimeMs?: number }): WorkspaceFile {
  const base = { path, size: stat.size, revision: bytes ? contentRevision(bytes) : `large:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs ?? 0}` }
  if (!bytes) return { ...base, kind: 'binary', reason: 'too-large' }
  const mime = IMAGE_MIME[extension]
  if (mime) return { ...base, kind: 'image', mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  if (BINARY_EXTENSIONS.has(extension)) return { ...base, kind: 'binary', reason: 'unsupported' }
  const content = decodeWorkspaceText(bytes)
  if (content === undefined || bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { ...base, kind: 'binary', reason: 'encoding' }
  }
  if (isBinaryText(content)) return { ...base, kind: 'binary', reason: 'unsupported' }
  return { ...base, kind: 'text', content }
}