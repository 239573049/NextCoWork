import { isAbsolute, join, relative } from 'node:path'
import { agentError, type AgentError } from '../../../shared/agent/error'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import { attachmentRelPath, imageMimeOfBytes, MAX_ATTACHMENT_BYTES, normalizeImageMime, parseNcwUrl } from '../../../shared/domain/attachment'
import type { KernelHost } from '../host'
import type { CanonicalRequest, UpstreamRequestContext } from './canonical'

type ImageInputFailure = 'unsupportedImage' | 'invalidImageData' | 'foreignSession' | 'invalidLocation'
  | 'unsafePath' | 'invalidSize' | 'storageUnavailable' | 'missing' | 'unreadable' | 'incompleteRead'

export class ImageInputError extends Error {
  readonly error: AgentError
  constructor(detail: string, reason: ImageInputFailure, messageParams?: AgentError['messageParams']) {
    super(detail)
    this.error = agentError('provider', detail, { retryable: false, messageKey: `attachment.error.${reason}`, messageParams })
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

/** Resolve only this session's managed images. Data URLs live in the outgoing copy, never the transcript. */
export async function prepareRequestImages(
  request: CanonicalRequest,
  host: KernelHost,
  context: UpstreamRequestContext,
  signal: AbortSignal
): Promise<CanonicalRequest> {
  if (!request.messages.some((m) => m.parts.some((p) => p.type === 'image'))) return request
  const resolved = new Map<string, { mime: string; dataRef: string }>()
  const limit = MAX_ATTACHMENT_BYTES / 1024 / 1024
  const messages: AgentMessage[] = []
  for (const message of request.messages) {
    const parts: ContentPart[] = []
    for (const part of message.parts) {
      signal.throwIfAborted()
      if (part.type !== 'image') { parts.push(part); continue }
      const mime = normalizeImageMime(part.mime)
      if (mime === null) {
        throw new ImageInputError(`Unsupported image media type: ${part.mime}`, 'unsupportedImage', { mime: part.mime })
      }
      const cacheKey = `${mime}:${part.dataRef}`
      let image = resolved.get(cacheKey)
      if (image === undefined) {
        if (part.dataRef.startsWith('data:')) {
          if (part.dataRef.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 128) {
            throw new ImageInputError('Invalid image attachment size', 'invalidSize', { limit })
          }
          const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(part.dataRef)
          if (match === null || normalizeImageMime(match[1]!) !== mime) {
            throw new ImageInputError('Invalid image data URL', 'invalidImageData')
          }
          const data = match[2]!
          const bytes = Buffer.from(data, 'base64')
          const encoded = bytes.toString('base64')
          if (encoded.replace(/=+$/, '') !== data.replace(/=+$/, '')) {
            throw new ImageInputError('Invalid image data URL', 'invalidImageData')
          }
          if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
            throw new ImageInputError('Invalid image attachment size', 'invalidSize', { limit })
          }
          const actualMime = imageMimeOfBytes(bytes) ?? mime
          image = { mime: actualMime, dataRef: `data:${actualMime};base64,${encoded}` }
        } else {
          const locator = parseNcwUrl(part.dataRef)
          if (locator === null) throw new ImageInputError('Invalid image attachment location', 'invalidLocation')
          if (locator.scope !== 'session' || locator.ownerId === undefined || locator.ownerId !== context.sessionId) {
            throw new ImageInputError('Image attachment does not belong to this session', 'foreignSession')
          }
          const rel = attachmentRelPath(locator)
          if (rel === null) throw new ImageInputError('Invalid image attachment location', 'invalidLocation')
          let stage: 'storage' | 'file' | 'read' = 'storage'
          try {
            const root = await host.fs.realpath(host.paths.attachments())
            const expectedOwnerRoot = join(root, 'sessions', locator.ownerId)
            const ownerRoot = await host.fs.realpath(expectedOwnerRoot)
            stage = 'file'
            const file = await host.fs.realpath(join(root, rel))
            if (relative(expectedOwnerRoot, ownerRoot) !== '' || !within(root, ownerRoot)
              || !within(ownerRoot, file)) throw new ImageInputError('Image attachment escaped its session directory', 'unsafePath')
            const stat = await host.fs.stat(file)
            if (stat.isDir) throw new ImageInputError('Image attachment is a directory', 'invalidLocation')
            if (stat.size === 0 || stat.size > MAX_ATTACHMENT_BYTES) {
              throw new ImageInputError('Invalid image attachment size', 'invalidSize', { limit })
            }
            stage = 'read'
            const bytes = await host.fs.readFileBytes(file, stat.size + 1)
            if (bytes.length !== stat.size) {
              throw new ImageInputError('Image attachment changed or was not read completely', 'incompleteRead', { name: locator.fileName })
            }
            const actualMime = imageMimeOfBytes(bytes) ?? mime
            image = { mime: actualMime, dataRef: `data:${actualMime};base64,${Buffer.from(bytes).toString('base64')}` }
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof ImageInputError) throw error
            const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
            const reason = stage === 'storage' ? 'storageUnavailable' : code === 'ENOENT' ? 'missing' : 'unreadable'
            throw new ImageInputError(`Image attachment is missing or unreadable (${stage}: ${code})`, reason, { name: locator.fileName, code })
          }
        }
        resolved.set(cacheKey, image)
      }
      parts.push({ ...part, ...image })
    }
    messages.push({ ...message, parts })
  }
  signal.throwIfAborted()
  return { ...request, messages }
}
