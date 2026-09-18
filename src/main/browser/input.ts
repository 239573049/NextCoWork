/*
 * CDP input semantics shared by embedded and headless browser pages.
 *
 * ★ Ref actions consume the latest snapshot. This is not cosmetic bookkeeping: allowing two
 * writes against one observation makes the second click use assumptions from a page that the
 * first click may already have replaced. The failure tells the Agent to observe again.
 */
import type { BrowserCuaEvent, BrowserViewport } from '../../shared/domain/browser'
import type { BrowserMouseButton, BrowserPoint } from './runtime'
import { CdpPageSession } from './cdp-session'

interface RefPoint extends BrowserPoint {
  ok: true
}

interface RefFailure {
  ok: false
  error: 'missing_snapshot' | 'stale_snapshot' | 'missing_ref' | 'hidden_ref'
}

interface SelectResult {
  ok: boolean
  error?: string
}

const BUTTON_NUMBER: Record<BrowserMouseButton, number> = {
  left: 1,
  right: 2,
  middle: 4
}

const MODIFIER_BIT: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8
}

const KEY_INFO: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32 }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function refError(failure: RefFailure): Error {
  if (failure.error === 'missing_ref') return new Error('The ref is no longer present. Take a fresh browser_snapshot and rebuild the target.')
  if (failure.error === 'hidden_ref') return new Error('The ref is no longer visible. Take a fresh browser_snapshot and rebuild the target.')
  return new Error('The browser snapshot is stale. Take a fresh browser_snapshot before another action.')
}

function parseRefPoint(value: unknown): RefPoint | RefFailure {
  const raw = record(value)
  if (raw?.ok !== true) {
    const error = raw?.error
    return {
      ok: false,
      error: error === 'missing_ref' || error === 'hidden_ref' || error === 'missing_snapshot'
        ? error
        : 'stale_snapshot'
    }
  }
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
    return { ok: false, error: 'hidden_ref' }
  }
  return { ok: true, x: raw.x, y: raw.y }
}

function pointExpression(snapshotId: string, ref: string, focus: 'none' | 'focus' | 'select'): string {
  return `(() => {
    const state = globalThis.__ncwBrowserState;
    if (!state) return { ok: false, error: 'missing_snapshot' };
    if (state.snapshotId !== ${JSON.stringify(snapshotId)}) return { ok: false, error: 'stale_snapshot' };
    const element = state.refs.get(${JSON.stringify(ref)});
    if (!element || !document.contains(element)) return { ok: false, error: 'missing_ref' };
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: 'hidden_ref' };
    ${focus === 'none' ? '' : "if (typeof element.focus === 'function') element.focus({ preventScroll: true });"}
    ${focus === 'select' ? `
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
      else if (element.getAttribute('contenteditable') === 'true') {
        const selection = globalThis.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    ` : ''}
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`
}

function selectExpression(snapshotId: string, ref: string, values: readonly string[]): string {
  return `(() => {
    const state = globalThis.__ncwBrowserState;
    if (!state || state.snapshotId !== ${JSON.stringify(snapshotId)}) return { ok: false, error: 'stale_snapshot' };
    const element = state.refs.get(${JSON.stringify(ref)});
    if (!(element instanceof HTMLSelectElement) || !document.contains(element)) return { ok: false, error: 'not_select' };
    const requested = new Set(${JSON.stringify(values)});
    let selected = 0;
    for (const option of element.options) {
      option.selected = requested.has(option.value);
      if (option.selected) selected++;
    }
    if (selected === 0 && requested.size > 0) return { ok: false, error: 'missing_option' };
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`
}

function keyInfo(raw: string, shifted: boolean): { key: string; code: string; keyCode: number; text?: string } {
  const clean = raw.trim()
  const known = KEY_INFO[clean.toLowerCase()]
  if (known !== undefined) return known
  if (clean.length !== 1) throw new Error(`Unsupported browser key: ${raw}`)
  const upper = clean.toUpperCase()
  const isLetter = /^[A-Z]$/u.test(upper)
  const key = shifted && isLetter ? upper : clean
  return {
    key,
    code: isLetter ? `Key${upper}` : /^[0-9]$/u.test(clean) ? `Digit${clean}` : clean,
    keyCode: upper.charCodeAt(0),
    text: key
  }
}

function modifierKey(name: string): { key: string; code: string; keyCode: number } {
  const normalized = name.toLowerCase()
  if (normalized === 'shift') return { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }
  if (normalized === 'alt') return { key: 'Alt', code: 'AltLeft', keyCode: 18 }
  if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command') return { key: 'Meta', code: 'MetaLeft', keyCode: 91 }
  return { key: 'Control', code: 'ControlLeft', keyCode: 17 }
}

export class BrowserInputController {
  private snapshotId: string | null = null
  private screenshotReady = false

  constructor(
    private readonly session: CdpPageSession,
    private readonly viewport: () => Promise<BrowserViewport>,
    private readonly emit: (kind: BrowserCuaEvent['kind'], point: BrowserPoint) => void
  ) {}

  setSnapshot(snapshotId: string): void {
    this.snapshotId = snapshotId
    this.screenshotReady = false
  }

  setScreenshotReady(): void {
    this.screenshotReady = true
  }

  invalidate(): void {
    this.snapshotId = null
    this.screenshotReady = false
    this.session.invalidateContext()
  }

  async clickRef(ref: string, button: BrowserMouseButton = 'left', clickCount = 1): Promise<void> {
    const point = await this.pointFor(ref, 'none')
    await this.clickAt(point, button, clickCount)
    this.consumeObservation()
  }

  async typeRef(ref: string, text: string): Promise<void> {
    const snapshotId = this.requireSnapshot()
    const point = await this.pointFor(ref, 'focus')
    await this.clickAt(point, 'left', 1)
    await this.session.evaluate<void>(pointExpression(snapshotId, ref, 'select'))
    await this.session.send('Input.insertText', { text })
    this.emit('type', point)
    this.consumeObservation()
  }

  async press(keys: readonly string[], ref?: string): Promise<void> {
    this.requireSnapshot()
    let point: BrowserPoint | null = null
    if (ref !== undefined) point = await this.pointFor(ref, 'focus')
    const modifiers = keys.filter((key) => MODIFIER_BIT[key.trim().toLowerCase()] !== undefined)
    const primary = keys.filter((key) => MODIFIER_BIT[key.trim().toLowerCase()] === undefined)
    if (primary.length !== 1) throw new Error('Browser keypress requires exactly one non-modifier key.')
    let mask = 0
    for (const modifier of modifiers) mask |= MODIFIER_BIT[modifier.trim().toLowerCase()] ?? 0
    for (const modifier of modifiers) {
      const info = modifierKey(modifier)
      await this.session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
        modifiers: mask
      })
    }
    const info = keyInfo(primary[0]!, (mask & 8) !== 0)
    // Ctrl/Alt/Meta chords are commands; Shift still produces printable text such as "A".
    const text = (mask & 7) === 0 ? info.text : undefined
    await this.session.send('Input.dispatchKeyEvent', {
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers: mask,
      ...(text === undefined ? {} : { text })
    })
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers: mask
    })
    for (const modifier of [...modifiers].reverse()) {
      const modifierInfo = modifierKey(modifier)
      await this.session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: modifierInfo.key,
        code: modifierInfo.code,
        windowsVirtualKeyCode: modifierInfo.keyCode,
        nativeVirtualKeyCode: modifierInfo.keyCode,
        modifiers: mask
      })
    }
    if (point !== null) this.emit('type', point)
    this.consumeObservation()
  }

  async select(ref: string, values: readonly string[]): Promise<void> {
    const snapshotId = this.requireSnapshot()
    const result = record(await this.session.evaluate<SelectResult>(selectExpression(snapshotId, ref, values)))
    if (result?.ok !== true) {
      const reason = result?.error === 'not_select'
        ? 'The ref is not a select element.'
        : result?.error === 'missing_option'
          ? 'None of the requested select options exist.'
          : 'The browser snapshot is stale. Take a fresh browser_snapshot before another action.'
      throw new Error(reason)
    }
    this.consumeObservation()
  }

  async scroll(input: { x?: number; y?: number; scrollX: number; scrollY: number }): Promise<void> {
    if (this.snapshotId === null && !this.screenshotReady) {
      throw new Error('Observe the page with browser_snapshot or browser_screenshot before scrolling.')
    }
    const viewport = await this.viewport()
    const point = {
      x: input.x ?? viewport.width / 2,
      y: input.y ?? viewport.height / 2
    }
    this.assertPoint(point, viewport)
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: input.scrollX,
      deltaY: input.scrollY,
      pointerType: 'mouse'
    })
    this.emit('move', point)
    this.consumeObservation()
  }

  async cuaClick(point: BrowserPoint, button: BrowserMouseButton = 'left'): Promise<void> {
    this.requireScreenshot()
    await this.clickAt(point, button, 1)
    this.consumeObservation()
  }

  async cuaDrag(path: readonly BrowserPoint[], keys: readonly string[] = []): Promise<void> {
    this.requireScreenshot()
    if (path.length < 2) throw new Error('Browser drag requires at least two path points.')
    const viewport = await this.viewport()
    for (const point of path) this.assertPoint(point, viewport)
    let modifiers = 0
    for (const key of keys) {
      const bit = MODIFIER_BIT[key.trim().toLowerCase()]
      if (bit === undefined) throw new Error(`Unsupported drag modifier: ${key}`)
      modifiers |= bit
    }
    const first = path[0]!
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: first.x, y: first.y, modifiers, pointerType: 'mouse'
    })
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, modifiers, pointerType: 'mouse'
    })
    for (const point of path.slice(1)) {
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1, modifiers, pointerType: 'mouse'
      })
      this.emit('move', point)
    }
    const last = path[path.length - 1]!
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, modifiers, pointerType: 'mouse'
    })
    this.emit('click', last)
    this.consumeObservation()
  }

  private requireSnapshot(): string {
    if (this.snapshotId === null) {
      throw new Error('Take a fresh browser_snapshot before this action.')
    }
    return this.snapshotId
  }

  private requireScreenshot(): void {
    if (!this.screenshotReady) {
      throw new Error('Take a fresh browser_screenshot before using coordinate actions.')
    }
  }

  private consumeObservation(): void {
    this.snapshotId = null
    this.screenshotReady = false
  }

  private async pointFor(ref: string, focus: 'none' | 'focus' | 'select'): Promise<BrowserPoint> {
    const snapshotId = this.requireSnapshot()
    const result = parseRefPoint(await this.session.evaluate<unknown>(pointExpression(snapshotId, ref, focus)))
    if (!result.ok) throw refError(result)
    const viewport = await this.viewport()
    this.assertPoint(result, viewport)
    return result
  }

  private async clickAt(point: BrowserPoint, button: BrowserMouseButton, clickCount: number): Promise<void> {
    const viewport = await this.viewport()
    this.assertPoint(point, viewport)
    const buttons = BUTTON_NUMBER[button]
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse'
    })
    this.emit('move', point)
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount, pointerType: 'mouse'
    })
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount, pointerType: 'mouse'
    })
    this.emit('click', point)
  }

  private assertPoint(point: BrowserPoint, viewport: BrowserViewport): void {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > viewport.width ||
      point.y > viewport.height
    ) {
      throw new Error(`Browser coordinates (${String(point.x)}, ${String(point.y)}) are outside the ${String(viewport.width)}x${String(viewport.height)} viewport.`)
    }
  }
}
