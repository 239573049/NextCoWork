import { describe, expect, it } from 'vitest'
import {
  formatBrowserSnapshot,
  MAX_BROWSER_SNAPSHOT_CHARS,
  normalizeBrowserSnapshot
} from '../aria-snapshot'

describe('browser accessibility snapshot', () => {
  it('规范化尾部空白并保留 page/ref 元数据', () => {
    const snapshot = normalizeBrowserSnapshot({
      tree: '  - heading "Title" [ref=e1]   \r\n\t- button "Go" [ref=e2]\t\n',
      title: 'Example',
      url: 'https://example.com/',
      snapshotId: 'snapshot-1',
      viewport: { width: 1279.6, height: 719.5 }
    })

    expect(snapshot).toMatchObject({
      tree: '- heading "Title" [ref=e1]\n\t- button "Go" [ref=e2]',
      snapshotId: 'snapshot-1',
      viewport: { width: 1280, height: 720 },
      truncated: false
    })
    expect(formatBrowserSnapshot(snapshot)).toContain('Viewport: 1280x720')
  })

  it('把恶意页面返回的树限制在固定预算', () => {
    const snapshot = normalizeBrowserSnapshot({
      tree: 'x'.repeat(MAX_BROWSER_SNAPSHOT_CHARS + 10),
      title: 'Large',
      url: 'https://example.com/',
      snapshotId: 'snapshot-2',
      viewport: { width: 800, height: 600 }
    })

    expect(snapshot.tree).toHaveLength(MAX_BROWSER_SNAPSHOT_CHARS)
    expect(snapshot.truncated).toBe(true)
    expect(formatBrowserSnapshot(snapshot)).toContain('[Snapshot truncated at 80000 characters.]')
  })

  it('拒绝缺字段或非法 viewport 的跨进程值', () => {
    expect(() => normalizeBrowserSnapshot({ tree: '', title: '', url: '', snapshotId: '' })).toThrow('incomplete')
    expect(() => normalizeBrowserSnapshot({
      tree: '',
      title: '',
      url: 'https://example.com/',
      snapshotId: 'snapshot-3',
      viewport: { width: Number.NaN, height: 600 }
    })).toThrow('invalid viewport')
  })
})
