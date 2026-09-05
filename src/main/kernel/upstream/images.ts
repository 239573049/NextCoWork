import { isAbsolute, join, relative } from 'node:path'
import { agentError, type AgentError } from '../../../shared/agent/error'
import type { AgentMessage, ContentPart } from '../../../shared/agent/message'
import { attachmentRelPath, MAX_ATTACHMENT_BYTES, parseNcwUrl } from '../../../shared/domain/attachment'
import type { KernelHost } from '../host'
import type { CanonicalRequest, UpstreamRequestContext } from './canonical'

export class ImageInputError extends Error {
  readonly error: AgentError
  constructor(detail: string) {
    super(detail)
    this.error = agentError('provider', detail, { retryable: false, messageKey: 'agent.error.imageInput' })
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
  const resolved = new Map<string, string>()
  const messages: AgentMessage[] = []
  for (const message of request.messages) {
    const parts: ContentPart[] = []
    for (const part of message.parts) {
      signal.throwIfAborted()
      if (part.type !== 'image') { parts.push(part); continue }
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime)) {
        throw new ImageInputError(`Unsupported image media type: ${part.mime}`)
      }
      const cacheKey = `${part.mime}:${part.dataRef}`
      let url = resolved.get(cacheKey)
      if (url === undefined) {
        if (part.dataRef.startsWith('data:')) {
          if (!part.dataRef.startsWith(`data:${part.mime};base64,`) || part.dataRef.length > MAX_ATTACHMENT_BYTES * 1.4) {
            throw new ImageInputError('Invalid image data URL')
          }
          url = part.dataRef
        } else {
          const locator = parseNcwUrl(part.dataRef)
          if (locator?.scope !== 'session' || locator.ownerId === undefined || locator.ownerId !== context.sessionId) {
            throw new ImageInputError('Image attachment does not belong to this session')
          }
          const rel = attachmentRelPath(locator)
          if (rel === null) throw new ImageInputError('Invalid image attachment location')
          try {
            const root = await host.fs.realpath(join(host.paths.userData(), 'attachments'))
            const ownerRoot = await host.fs.realpath(join(root, 'sessions', locator.ownerId))
            const file = await host.fs.realpath(join(root, rel))
            if (ownerRoot !== join(root, 'sessions', locator.ownerId) || !within(root, ownerRoot)
              || !within(ownerRoot, file)) throw new ImageInputError('Image attachment escaped its session directory')
            const stat = await host.fs.stat(file)
            if (stat.isDir || stat.size === 0 || stat.size > MAX_ATTACHMENT_BYTES) throw new ImageInputError('Invalid image attachment size')
            const bytes = await host.fs.readFileBytes(file, MAX_ATTACHMENT_BYTES + 1)
            if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new ImageInputError('Invalid image attachment size')
            url = `data:${part.mime};base64,${Buffer.from(bytes).toString('base64')}`
          } catch (error) {
            if (error instanceof ImageInputError) throw error
            throw new ImageInputError('Image attachment is missing or unreadable')
          }
        }
        resolved.set(cacheKey, url)
      }
      parts.push({ ...part, dataRef: url })
    }
    messages.push({ ...message, parts })
  }
  signal.throwIfAborted()
  return { ...request, messages }
}
