/*
 * Validation and budgeting for values returned by the fixed browser snapshot program.
 *
 * Runtime.evaluate crosses a hostile page boundary even though the code runs in an isolated
 * world. Treat every returned field as unknown so a compromised renderer cannot smuggle an
 * unbounded object into the transcript or poison the ref lifecycle.
 */
import type { BrowserViewport } from '../../shared/domain/browser'
import type { BrowserPageSnapshot } from './runtime'

export const MAX_BROWSER_SNAPSHOT_CHARS = 80_000

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function viewportOf(value: unknown): BrowserViewport {
  const viewport = record(value)
  const width = viewport?.width
  const height = viewport?.height
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error('The browser returned an invalid viewport.')
  }
  return { width: Math.round(width), height: Math.round(height) }
}

export function normalizeBrowserSnapshot(value: unknown): BrowserPageSnapshot {
  const raw = record(value)
  if (raw === null) throw new Error('The browser returned an invalid accessibility snapshot.')
  if (
    typeof raw.tree !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.url !== 'string' ||
    typeof raw.snapshotId !== 'string' ||
    raw.snapshotId === ''
  ) {
    throw new Error('The browser returned an incomplete accessibility snapshot.')
  }
  const normalized = raw.tree
    .split('\n')
    .map((line) => line.replace(/[\t\r ]+$/gu, ''))
    .join('\n')
    .trim()
  const truncated = normalized.length > MAX_BROWSER_SNAPSHOT_CHARS
  return {
    tree: normalized.slice(0, MAX_BROWSER_SNAPSHOT_CHARS),
    title: raw.title.slice(0, 500),
    url: raw.url.slice(0, 8_192),
    snapshotId: raw.snapshotId,
    viewport: viewportOf(raw.viewport),
    truncated
  }
}

export function formatBrowserSnapshot(snapshot: BrowserPageSnapshot): string {
  const body = snapshot.tree === '' ? '(The page has no accessible content.)' : snapshot.tree
  return [
    `Page: ${snapshot.title || '(untitled)'}`,
    `URL: ${snapshot.url}`,
    `Viewport: ${String(snapshot.viewport.width)}x${String(snapshot.viewport.height)}`,
    '',
    body,
    ...(snapshot.truncated ? ['', '[Snapshot truncated at 80000 characters.]'] : [])
  ].join('\n')
}
