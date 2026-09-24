/**
 * 需求：正文引用在气泡里保留，同时在气泡下与发送的图片/文件一起展示；
 * 草稿里只有上传完的图片可打开预览，不改变发送内容或附件的其他操作。
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userMessage } from '../../../../../shared/agent/message'
import { emptyTranscript } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { AttachmentTray, type TrayItem } from '../AttachmentTray'
import { Thread } from '../Thread'
import { userMessageFileRefs } from '../user-message-attachments'

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
  vi.unstubAllGlobals()
})

async function render(children: ReactNode): Promise<HTMLElement> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  const container = document.getElementById('root')!
  const root = createRoot(container)
  cleanup = async () => {
    await act(async () => root.unmount())
    dom.window.close()
  }
  await act(async () => root.render(createElement(I18nProvider, { initialLocale: 'zh-CN', children })))
  return container
}

const image = (name: string): TrayItem => ({
  key: name, name, status: 'done', attachment: {
    id: name, scope: 'session', ownerId: 's', displayName: name,
    mime: 'image/png', size: 1, checksum: name, createdAt: 1,
    url: `ncw://attachments/${name}`
  }
})

describe('用户消息附件', () => {
  it('按路径去重正文引用和 file_ref，排除网址与技能且不修改 parts', () => {
    const text = '先看 [a](src/a.ts) 和 [a](src/a.ts) [web](https://example.com) <skill name="test" /> [b](src/b.ts)'
    const parts = [
      { type: 'text' as const, text },
      { type: 'file_ref' as const, name: 'another a', path: 'src/a.ts' },
      { type: 'file_ref' as const, name: 'c', path: 'src/c.ts' }
    ]
    const original = JSON.stringify(parts)
    expect(userMessageFileRefs(text, parts)).toEqual([
      { name: 'a', path: 'src/a.ts' },
      { name: 'b', path: 'src/b.ts' },
      { name: 'c', path: 'src/c.ts' }
    ])
    expect(JSON.stringify(parts)).toBe(original)
  })

  it('纯图片消息没有空文字气泡，多张图片可预览和翻页', async () => {
    const messages = [userMessage('u', [
      { type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/one' },
      { type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/two' }
    ], 1)]
    const container = await render(createElement(Thread, {
      transcript: { ...emptyTranscript(), messages }, runId: null, lastSeq: 0,
      queued: 0, model: undefined, providerName: undefined
    }))
    expect(container.querySelector('[data-testid="user-message-bubble"]')).toBeNull()
    const attachments = container.querySelector('[data-testid="user-message-attachments"]')!
    expect(attachments.querySelectorAll('[data-testid="message-image"]')).toHaveLength(2)
    expect(attachments.querySelector('img')?.className).toContain('max-h-24')
    await act(async () => (attachments.querySelector('button') as HTMLButtonElement).click())
    expect(document.querySelector('[data-testid="lightbox-image"]')?.getAttribute('src')).toBe('ncw://attachments/one')
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight' })))
    expect(document.querySelector('[data-testid="lightbox-image"]')?.getAttribute('src')).toBe('ncw://attachments/two')
  })

  it('正文保留引用 chip，下方只出现一张独立文件卡片', async () => {
    const messages = [userMessage('u', [
      { type: 'text', text: '看 [a](src/a.ts) [a](src/a.ts)' },
      { type: 'file_ref', path: 'src/a.ts', name: 'a' },
      { type: 'image', mime: 'image/png', dataRef: 'ncw://attachments/one' }
    ], 1)]
    const container = await render(createElement(Thread, {
      transcript: { ...emptyTranscript(), messages }, runId: null, lastSeq: 0,
      queued: 0, model: undefined, providerName: undefined
    }))
    const bubble = container.querySelector('[data-testid="user-message-bubble"]')!
    const attachments = container.querySelector('[data-testid="user-message-attachments"]')!
    expect(bubble.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(2)
    expect(bubble.querySelector('[data-testid="message-file-ref"]')).toBeNull()
    expect(attachments.querySelectorAll('[data-testid="message-file-ref"]')).toHaveLength(1)
    expect(attachments.querySelector('[data-testid="message-file-ref"]')?.tagName).toBe('DIV')
    expect(attachments.parentElement).toBe(bubble.parentElement)
  })
})

describe('草稿图片预览', () => {
  it('上传完成图片可打开灯箱，删除按钮仍独立生效', async () => {
    const onRemove = vi.fn()
    const container = await render(createElement(AttachmentTray, {
      items: [image('one.png')], onRemove, onRetry: vi.fn()
    }))
    const preview = container.querySelector<HTMLButtonElement>('[aria-label="放大查看图片"]')
    expect(preview).not.toBeNull()
    await act(async () => preview!.click())
    expect(document.querySelector('[data-testid="lightbox-image"]')?.getAttribute('src')).toBe('ncw://attachments/one.png')
    await act(async () => (document.querySelector('[data-testid="lightbox-close"]') as HTMLButtonElement).click())
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull()
    await act(async () => (container.querySelector('[data-testid="attachment-remove"]') as HTMLButtonElement).click())
    expect(onRemove).toHaveBeenCalledWith('one.png')
  })

  it('未上传、上传失败及非图片不提供预览入口', async () => {
    const container = await render(createElement(AttachmentTray, {
      items: [
        { ...image('pending.png'), status: 'uploading' },
        { ...image('failed.png'), status: 'error', error: 'error' },
        { key: 'file', name: 'file.txt', status: 'done', path: '/file.txt' }
      ], onRemove: vi.fn(), onRetry: vi.fn()
    }))
    expect(container.querySelector('[data-status="uploading"] [aria-label="放大查看图片"]')).toBeNull()
    expect(container.querySelector('[data-status="error"] [aria-label="放大查看图片"]')).toBeNull()
    expect(container.querySelector('[data-status="done"] [aria-label="放大查看图片"]')).toBeNull()
  })
})
