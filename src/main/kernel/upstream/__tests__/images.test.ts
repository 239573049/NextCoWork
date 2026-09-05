import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../../../shared/agent/message'
import { MAX_ATTACHMENT_BYTES } from '../../../../shared/domain/attachment'
import { nodeHost, type KernelHost } from '../../host'
import { encodeUpstream } from '../codec'
import { ImageInputError, prepareRequestImages } from '../images'
import { REQUEST } from './openai-fixtures'

let root: string
let host: KernelHost
const signal = new AbortController().signal
const context = { workspaceId: 'workspace', sessionId: 'session-a' }
const imageBytes = Buffer.from('managed image bytes')
const imageUrl = 'ncw://attachments/sessions/session-a/image.png'

function request(dataRef = imageUrl, mime = 'image/png'): typeof REQUEST {
  return { ...REQUEST, messages: [userMessage('u', [
    { type: 'text', text: 'Describe the image.' }, { type: 'image', mime, dataRef }
  ], 0)] }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nextcowork-upstream-images-')))
  await mkdir(join(root, 'attachments', 'sessions', 'session-a'), { recursive: true })
  host = nodeHost({ paths: { userData: () => root, temp: () => root } })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('upstream managed images', () => {
  it('resolves only the outgoing copy, caches repeated references, and feeds all three protocols', async () => {
    await writeFile(join(root, 'attachments', 'sessions', 'session-a', 'image.png'), imageBytes)
    const original = request()
    original.messages.push(userMessage('u2', [{ type: 'image', mime: 'image/png', dataRef: imageUrl }], 0))
    const before = structuredClone(original)
    const read = vi.spyOn(host.fs, 'readFileBytes')
    const prepared = await prepareRequestImages(original, host, context, signal)
    const dataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`
    expect(prepared.messages[0]?.parts[1]).toMatchObject({ dataRef: dataUrl })
    expect(original).toEqual(before)
    expect(read).toHaveBeenCalledTimes(1)
    for (const protocol of ['anthropic', 'openai-chat', 'openai-responses'] as const) {
      const body = encodeUpstream(protocol, prepared, 'model', 'test-key', { userId: context.workspaceId, cacheTtl: 'off' }).body
      expect(JSON.stringify(body)).toContain(imageBytes.toString('base64'))
      expect(JSON.stringify(body)).not.toContain('ncw://')
    }
  })

  it('accepts matching inline images without reading the filesystem', async () => {
    const read = vi.spyOn(host.fs, 'realpath')
    const original = request(`data:image/png;base64,${imageBytes.toString('base64')}`)
    expect(await prepareRequestImages(original, host, context, signal)).toEqual(original)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    'ncw://attachments/sessions/session-b/image.png',
    'ncw://attachments/themes/image.png',
    'ncw://attachments/sessions/session-a/%2e%2e%2fimage.png',
    'https://example.com/image.png',
    '/outside/image.png'
  ])('rejects unowned or unmanaged references before reading: %s', async (dataRef) => {
    const read = vi.spyOn(host.fs, 'readFileBytes')
    await expect(prepareRequestImages(request(dataRef), host, context, signal)).rejects.toBeInstanceOf(ImageInputError)
    expect(read).not.toHaveBeenCalled()
  })

  it('reports missing attachments as a localized non-retryable input error', async () => {
    await expect(prepareRequestImages(request(), host, context, signal)).rejects.toMatchObject({
      error: { code: 'provider', retryable: false, messageKey: 'agent.error.imageInput' }
    })
  })

  it('rejects a file symlink escaping the owning session', async () => {
    await writeFile(join(root, 'outside.png'), imageBytes)
    await symlink(join(root, 'outside.png'), join(root, 'attachments', 'sessions', 'session-a', 'image.png'))
    const read = vi.spyOn(host.fs, 'readFileBytes')
    await expect(prepareRequestImages(request(), host, context, signal)).rejects.toThrow('escaped')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a session directory symlink even when it points inside the attachment root', async () => {
    await writeFile(join(root, 'attachments', 'sessions', 'session-a', 'image.png'), imageBytes)
    await symlink(join(root, 'attachments', 'sessions', 'session-a'), join(root, 'attachments', 'sessions', 'session-link'), 'dir')
    await expect(prepareRequestImages(request('ncw://attachments/sessions/session-link/image.png'), host,
      { ...context, sessionId: 'session-link' }, signal)).rejects.toThrow('escaped')
  })

  it.each([0, MAX_ATTACHMENT_BYTES + 1])('rejects invalid attachment size %s before loading bytes', async (size) => {
    await writeFile(join(root, 'attachments', 'sessions', 'session-a', 'image.png'), imageBytes)
    vi.spyOn(host.fs, 'stat').mockResolvedValue({ size, isDir: false, mtimeMs: 0 })
    const read = vi.spyOn(host.fs, 'readFileBytes')
    await expect(prepareRequestImages(request(), host, context, signal)).rejects.toThrow('size')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects unsupported or mismatched media types', async () => {
    await expect(prepareRequestImages(request(imageUrl, 'image/svg+xml'), host, context, signal)).rejects.toThrow('media type')
    await expect(prepareRequestImages(request('data:image/jpeg;base64,aGk='), host, context, signal)).rejects.toThrow('data URL')
  })

  it('honors cancellation before reading an attachment', async () => {
    const controller = new AbortController()
    controller.abort()
    const read = vi.spyOn(host.fs, 'realpath')
    await expect(prepareRequestImages(request(), host, context, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })
})
