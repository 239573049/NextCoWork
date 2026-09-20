/**
 * 视口 —— 唯一直接处理指针的组件。
 *
 * ## 三层叠放
 *
 * ```
 * 裁剪遮罩(DOM)     只有 crop 工具激活时出现
 * 进行中的笔迹/文字幽灵(overlay canvas)   拖动期间画这里,松手才进状态
 * 合成结果(image canvas)   pipeline.compose 的输出,随状态整体重算
 * ```
 *
 * ★ 进行中的笔迹**不**走 compose:大图每来一个点全量重算会把拖动卡成
 *   幻灯片。拖动时只在 overlay 上画增量线段(屏幕坐标),pointerup 一次性
 *   commit 进状态 —— 状态变更才触发一次全量重算。
 *
 * ## 坐标换算(zoom = 每 O 空间单位的屏幕像素)
 *
 * - 屏幕 → O:`(display - pan) / zoom`
 * - O → R:`+ crop 原点`(标注住 R 空间,见 `state.ts` 的约定)
 * - R → 屏幕:反推。全部经 `toRotated` / `toDisplay` 两个函数,别处不许
 *   自己再乘一遍 zoom —— 那是错位 bug 的老家。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t } from './i18n'
import { compose, effectiveCrop, humanBytes, previewScale, rotatedSize, textBounds, type Size } from './pipeline'
import type { EditorState, Rect, TextAnnotation } from './state'

export type Tool = 'pan' | 'crop' | 'brush' | 'text'

export interface BrushSettings { color: string; size: number; erase: boolean }

export interface ViewportProps {
  source: HTMLImageElement
  state: EditorState
  mode: 'preview' | 'edit'
  tool: Tool
  brush: BrushSettings
  onSelectText: (id: string | null) => void
  /** 新文字落点(canvas 内部点击产生,App 负责打开输入框)。 */
  onPlaceText: (x: number, y: number) => void
  onCommitStroke: (stroke: { points: { x: number; y: number }[]; color: string; width: number; erase: boolean }) => void
  onMoveText: (id: string, x: number, y: number) => void
  /** 裁剪被应用(R 空间矩形)。 */
  onApplyCrop: (rect: Rect) => void
  /** 正在内联编辑的文字标注 id;null = 没有。 */
  editingTextId: string | null
  /** value=null 表示取消(Esc);空串表示删除该标注。 */
  onTextEdit: (id: string, value: string | null) => void
  lastSavedBytes: number | null
  /** 帧信息:GIF 只有第一帧可编,状态栏要如实说。 */
  animated: boolean
}

interface DragBase {
  pointerId: number
  startDisplay: { x: number; y: number }
}

type Drag =
  | (DragBase & { kind: 'pan'; startPan: { x: number; y: number } })
  | (DragBase & { kind: 'brush'; points: { x: number; y: number }[] })
  | (DragBase & { kind: 'text'; id: string; startRotated: { x: number; y: number } })
  | (DragBase & { kind: 'cropNew' })
  | (DragBase & { kind: 'cropMove'; startRect: Rect })
  | (DragBase & { kind: 'cropResize'; handle: string; startRect: Rect })

type CropRatio = 'free' | 'original' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16'

export function Viewport(props: ViewportProps): React.ReactElement {
  const { source, state, mode, tool, brush } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const sourceSize: Size = { width: source.naturalWidth, height: source.naturalHeight }
  const rotated = rotatedSize(sourceSize.width, sourceSize.height, state.angle)
  const crop = effectiveCrop(state, rotated)

  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view

  const [cropDraft, setCropDraft] = useState<Rect | null>(null)
  const [cropRatio, setCropRatio] = useState<CropRatio>('free')
  const dragRef = useRef<Drag | null>(null)

  // ── 坐标换算:全组件仅此一处 ───────────────────

  const toRotated = useCallback((displayX: number, displayY: number): { x: number; y: number } => {
    const v = viewRef.current
    return {
      x: (displayX - v.x) / v.zoom + crop.x,
      y: (displayY - v.y) / v.zoom + crop.y
    }
  }, [crop.x, crop.y])

  const toDisplay = useCallback((rotatedX: number, rotatedY: number): { x: number; y: number } => {
    const v = viewRef.current
    return {
      x: (rotatedX - crop.x) * v.zoom + v.x,
      y: (rotatedY - crop.y) * v.zoom + v.y
    }
  }, [crop.x, crop.y])

  const outWidth = state.outWidth ?? crop.width
  const outHeight = state.outHeight ?? crop.height
  const displayWidth = outWidth * view.zoom
  const displayHeight = outHeight * view.zoom

  // ── 合成:状态一变全量重算(预览分辨率) ───────────────────

  useEffect(() => {
    const image = imageRef.current
    if (image === null) return
    const scale = previewScale({ width: outWidth, height: outHeight })
    const result = compose(source, sourceSize, state, scale, false)
    image.width = result.canvas.width
    image.height = result.canvas.height
    const ctx = image.getContext('2d')
    ctx?.drawImage(result.canvas, 0, 0)
    ctx?.drawImage(result.annotations, 0, 0)
  }, [source, sourceSize, state, outWidth, outHeight])

  // overlay 尺寸跟着视口走(全屏覆盖,不随 zoom 变换)
  const syncOverlay = useCallback((): void => {
    const overlay = overlayRef.current
    const container = containerRef.current
    if (overlay === null || container === null) return
    overlay.width = container.clientWidth
    overlay.height = container.clientHeight
  }, [])

  // ── 适配窗口 ───────────────────

  const fit = useCallback((): void => {
    const container = containerRef.current
    if (container === null) return
    const zoom = Math.min(
      container.clientWidth / outWidth,
      container.clientHeight / outHeight,
      8
    ) * 0.92
    setView({
      zoom,
      x: (container.clientWidth - outWidth * zoom) / 2,
      y: (container.clientHeight - outHeight * zoom) / 2
    })
  }, [outWidth, outHeight])

  const lastOutRef = useRef('')
  useLayoutEffect(() => {
    // 输出尺寸变了(裁剪/缩放/重置)才重新适配;滤镜滑杆不动布局,别抢用户的缩放。
    const key = `${outWidth}x${outHeight}`
    if (lastOutRef.current === key) return
    lastOutRef.current = key
    fit()
    // 首帧容器可能还没量出尺寸,下一拍再补一次
    requestAnimationFrame(fit)
  }, [outWidth, outHeight, fit])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const observer = new ResizeObserver(() => { syncOverlay() })
    observer.observe(container)
    syncOverlay()
    return () => { observer.disconnect() }
  }, [syncOverlay])

  // ── 滚轮缩放(围绕光标) ───────────────────

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const v = viewRef.current
      const factor = Math.exp(-event.deltaY * 0.0015)
      const zoom = Math.min(32, Math.max(0.02, v.zoom * factor))
      // 光标指向的 O 点在缩放前后保持不动
      const ox = (cx - v.x) / v.zoom
      const oy = (cy - v.y) / v.zoom
      setView({ zoom, x: cx - ox * zoom, y: cy - oy * zoom })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [])

  // ── 空格临时平移 ───────────────────

  const [spaceHeld, setSpaceHeld] = useState(false)
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code === 'Space' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        setSpaceHeld(true)
      }
    }
    const up = (event: KeyboardEvent): void => { if (event.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // ── 笔迹 overlay 增量绘制 ───────────────────

  const strokeSegment = useCallback((from: { x: number; y: number }, to: { x: number; y: number }): void => {
    const overlay = overlayRef.current
    const ctx = overlay?.getContext('2d')
    if (ctx === null || ctx === undefined) return
    const v = viewRef.current
    ctx.save()
    ctx.globalCompositeOperation = brush.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = brush.color
    ctx.lineWidth = Math.max(1, brush.size * v.zoom)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.restore()
  }, [brush])

  // ── 指针交互 ───────────────────

  const localPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const textAt = (displayX: number, displayY: number): TextAnnotation | null => {
    const point = toRotated(displayX, displayY)
    for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
      const annotation = state.annotations[i]
      if (annotation.kind !== 'text') continue
      const bounds = textBounds(annotation.text, annotation.size)
      if (
        point.x >= annotation.x - 4 && point.x <= annotation.x + bounds.width + 4 &&
        point.y >= annotation.y - 4 && point.y <= annotation.y + bounds.height + 4
      ) return annotation
    }
    return null
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return
    const point = localPoint(event)
    const wantsPan = spaceHeld || event.button === 1 || tool === 'pan' || mode === 'preview'
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    if (wantsPan) {
      dragRef.current = { kind: 'pan', pointerId: event.pointerId, startDisplay: point, startPan: { x: view.x, y: view.y } }
      return
    }
    if (tool === 'brush') {
      const rotatedPoint = toRotated(point.x, point.y)
      dragRef.current = { kind: 'brush', pointerId: event.pointerId, startDisplay: point, points: [rotatedPoint] }
      strokeSegment(point, point)
      return
    }
    if (tool === 'text') {
      const hit = textAt(point.x, point.y)
      if (hit !== null) {
        props.onSelectText(hit.id)
        dragRef.current = { kind: 'text', pointerId: event.pointerId, startDisplay: point, id: hit.id, startRotated: { x: hit.x, y: hit.y } }
        return
      }
      const rotatedPoint = toRotated(point.x, point.y)
      props.onPlaceText(rotatedPoint.x, rotatedPoint.y)
      return
    }
    if (tool === 'crop') {
      const handle = cropHandleAt(point)
      if (handle !== null && cropDraft !== null) {
        dragRef.current = { kind: 'cropResize', pointerId: event.pointerId, startDisplay: point, handle, startRect: cropDraft }
        return
      }
      if (cropDraft !== null) {
        const d = displayRectOf(cropDraft)
        const inside = point.x >= d.left && point.x <= d.left + d.width && point.y >= d.top && point.y <= d.top + d.height
        if (inside) {
          dragRef.current = { kind: 'cropMove', pointerId: event.pointerId, startDisplay: point, startRect: cropDraft }
          return
        }
      }
      dragRef.current = { kind: 'cropNew', pointerId: event.pointerId, startDisplay: point }
      setCropDraft(null)
    }
  }

  const ratioValue = (): number | null => {
    if (cropRatio === 'free') return null
    if (cropRatio === 'original') return outWidth / outHeight
    const [w, h] = cropRatio.split(':').map(Number) as [number, number]
    return w / h
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const point = localPoint(event)
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, x: drag.startPan.x + point.x - drag.startDisplay.x, y: drag.startPan.y + point.y - drag.startDisplay.y }))
      return
    }
    if (drag.kind === 'brush') {
      const last = drag.points[drag.points.length - 1]
      const lastDisplay = toDisplay(last.x, last.y)
      // 屏幕上挪不满 1px 就不记:点列是撤销粒度的内存大头
      if (Math.hypot(point.x - lastDisplay.x, point.y - lastDisplay.y) < 1) return
      const rotatedPoint = toRotated(point.x, point.y)
      drag.points.push(rotatedPoint)
      strokeSegment(lastDisplay, point)
      return
    }
    if (drag.kind === 'text') {
      // 幽灵移动:overlay 上一条淡线示意,真实重算留到松手
      return
    }
    if (drag.kind === 'cropNew') {
      const ratio = ratioValue()
      let widthO = (point.x - drag.startDisplay.x) / view.zoom
      let heightO = (point.y - drag.startDisplay.y) / view.zoom
      if (ratio !== null) {
        if (Math.abs(widthO) > Math.abs(heightO) * ratio) heightO = Math.sign(heightO || 1) * Math.abs(widthO) / ratio
        else widthO = Math.sign(widthO || 1) * Math.abs(heightO) * ratio
      }
      setCropDraft(rectFromDrag(toRotated(drag.startDisplay.x, drag.startDisplay.y), widthO, heightO))
      return
    }
    if (drag.kind === 'cropMove') {
      const dx = (point.x - drag.startDisplay.x) / view.zoom
      const dy = (point.y - drag.startDisplay.y) / view.zoom
      setCropDraft(clampCrop({
        ...drag.startRect,
        x: drag.startRect.x + dx,
        y: drag.startRect.y + dy
      }, rotated))
      return
    }
    if (drag.kind === 'cropResize') {
      const start = toRotated(drag.startDisplay.x, drag.startDisplay.y)
      const now = toRotated(point.x, point.y)
      const dx = now.x - start.x
      const dy = now.y - start.y
      const r = drag.startRect
      let next: Rect = { ...r }
      if (drag.handle.includes('w')) { next = { ...next, x: r.x + dx, width: r.width - dx } }
      if (drag.handle.includes('e')) { next = { ...next, width: r.width + dx } }
      if (drag.handle.includes('n')) { next = { ...next, y: r.y + dy, height: r.height - dy } }
      if (drag.handle.includes('s')) { next = { ...next, height: r.height + dy } }
      const ratio = ratioValue()
      if (ratio !== null) {
        // 锁比:以驱动轴为准改另一轴(保持左上角策略,简单且可预期)
        if (Math.abs(next.width - r.width) >= Math.abs(next.height - r.height)) next = { ...next, height: next.width / ratio }
        else next = { ...next, width: next.height * ratio }
      }
      setCropDraft(clampCrop(next, rotated))
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (drag.kind === 'brush') {
      const overlay = overlayRef.current
      overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
      if (drag.points.length > 0) {
        props.onCommitStroke({ points: drag.points, color: brush.color, width: brush.size, erase: brush.erase })
      }
      return
    }
    if (drag.kind === 'text') {
      const point = localPoint(event)
      const dx = (point.x - drag.startDisplay.x) / view.zoom
      const dy = (point.y - drag.startDisplay.y) / view.zoom
      if (dx !== 0 || dy !== 0) props.onMoveText(drag.id, drag.startRotated.x + dx, drag.startRotated.y + dy)
    }
  }

  // ── 裁剪遮罩几何(显示坐标) ───────────────────

  function displayRectOf(rect: Rect): { left: number; top: number; width: number; height: number } {
    const origin = toDisplay(rect.x, rect.y)
    return { left: origin.x, top: origin.y, width: rect.width * view.zoom, height: rect.height * view.zoom }
  }

  function cropHandleAt(point: { x: number; y: number }): string | null {
    if (cropDraft === null) return null
    const d = displayRectOf(cropDraft)
    const zones: [string, number, number][] = [
      ['nw', d.left, d.top], ['n', d.left + d.width / 2, d.top], ['ne', d.left + d.width, d.top],
      ['w', d.left, d.top + d.height / 2], ['e', d.left + d.width, d.top + d.height / 2],
      ['sw', d.left, d.top + d.height], ['s', d.left + d.width / 2, d.top + d.height], ['se', d.left + d.width, d.top + d.height]
    ]
    for (const [name, hx, hy] of zones) {
      if (Math.abs(point.x - hx) <= 8 && Math.abs(point.y - hy) <= 8) return name
    }
    return null
  }

  const cropBox = cropDraft === null ? null : displayRectOf(cropDraft)
  const cropping = tool === 'crop' && mode === 'edit'

  const imageOrigin = toDisplay(0, 0)

  const zoomPercent = Math.round(view.zoom * 100)

  return (
    <div className="viewport-wrap" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        ref={containerRef}
        className={
          'viewport' +
          (tool === 'brush' && mode === 'edit' && !spaceHeld ? ' tool-brush' : '') +
          (tool === 'text' && mode === 'edit' && !spaceHeld ? ' tool-text' : '') +
          (spaceHeld || dragRef.current?.kind === 'pan' ? ' panning' : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas
          ref={imageRef}
          className="image"
          style={{ transform: `translate(${imageOrigin.x}px, ${imageOrigin.y}px)`, width: displayWidth, height: displayHeight }}
        />
        <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

        {props.animated && (
          <div className="toast" style={{ top: 8, bottom: 'auto' }}>{t('status.frame')} · {t('export.gifNote')}</div>
        )}

        {cropping && cropBox !== null && (
          <div className="crop-overlay">
            <div className="shade" style={{ left: 0, top: 0, width: '100%', height: cropBox.top }} />
            <div className="shade" style={{ left: 0, top: cropBox.top + cropBox.height, width: '100%', bottom: 0 }} />
            <div className="shade" style={{ left: 0, top: cropBox.top, width: cropBox.left, height: cropBox.height }} />
            <div className="shade" style={{ left: cropBox.left + cropBox.width, top: cropBox.top, right: 0, height: cropBox.height }} />
            <div className="frame" style={{ left: cropBox.left, top: cropBox.top, width: cropBox.width, height: cropBox.height }}>
              <div className="rule-third" style={{ left: '33%', top: 0, bottom: 0, borderLeftWidth: 1 }} />
              <div className="rule-third" style={{ left: '66%', top: 0, bottom: 0, borderLeftWidth: 1 }} />
              <div className="rule-third" style={{ top: '33%', left: 0, right: 0, borderTopWidth: 1 }} />
              <div className="rule-third" style={{ top: '66%', left: 0, right: 0, borderTopWidth: 1 }} />
            </div>
            {(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const).map((name) => {
              const d = cropBox
              const hx = name.includes('w') ? d.left : name.includes('e') ? d.left + d.width : d.left + d.width / 2
              const hy = name.includes('n') ? d.top : name.includes('s') ? d.top + d.height : d.top + d.height / 2
              return <div key={name} className={`handle ${name}`} style={{ left: hx - 5.5, top: hy - 5.5 }} />
            })}
          </div>
        )}

        {cropping && cropDraft === null && (
          <div className="toast" style={{ top: 8, bottom: 'auto' }}>{t('crop.hint')}</div>
        )}

        {(() => {
          /*
            内联文字编辑框。位置/字号按当前视图换算(zoom 变化时跟着走);
            pointerdown 必须拦下,否则会先落到视口的 pan/落字逻辑上。
          */
          const editing = state.annotations.find((item) => item.id === props.editingTextId)
          if (editing === undefined || editing.kind !== 'text') return null
          const origin = toDisplay(editing.x, editing.y)
          const commit = (value: string | null): void => { props.onTextEdit(editing.id, value) }
          return (
            <input
              key={editing.id}
              className="text-input"
              autoFocus
              defaultValue={editing.text}
              style={{
                left: origin.x,
                top: origin.y,
                color: editing.color,
                fontSize: Math.max(12, editing.size * view.zoom),
                minWidth: 80
              }}
              onPointerDown={(event) => { event.stopPropagation() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value) }
                if (event.key === 'Escape') { event.preventDefault(); commit(null) }
              }}
              onBlur={(event) => { commit(event.currentTarget.value) }}
            />
          )
        })()}
      </div>

      {/* 裁剪工具条:贴着视口底边,应用/取消 + 比例 */}
      {cropping && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--panel)', borderTop: '1px solid var(--border)', flex: 'none' }}>
          <span style={{ color: 'var(--fg-muted)' }}>{t('crop.ratio')}</span>
          <select value={cropRatio} onChange={(event) => { setCropRatio(event.target.value as CropRatio) }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)', padding: '3px 6px' }}>
            <option value="free">{t('crop.ratio.free')}</option>
            <option value="original">{t('crop.ratio.original')}</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
          </select>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={cropDraft === null} onClick={() => { if (cropDraft !== null) { props.onApplyCrop(cropDraft); setCropDraft(null) } }}>
            {t('action.applyCrop')}
          </button>
          <button type="button" className="btn" onClick={() => { setCropDraft(null) }}>{t('action.cancelCrop')}</button>
        </div>
      )}

      <div className="statusbar">
        <span>{t('status.size', { w: outWidth, h: outHeight })}</span>
        <span>{t('status.zoom', { percent: zoomPercent })}</span>
        {props.lastSavedBytes !== null && <span>{t('status.bytes', { size: humanBytes(props.lastSavedBytes) })}</span>}
        <span className="spacer" />
        <button type="button" className="btn icon" onClick={fit} aria-label={t('fit')}>{t('fit')}</button>
        <button type="button" className="btn icon" onClick={() => setView((v) => ({ ...v, zoom: 1 }))} aria-label={t('actual')}>{t('actual')}</button>
        <span>{t('shortcut.zoom')}</span>
      </div>
    </div>
  )
}

/** 把「锚点 + 可为负的宽高」归一成正矩形。 */
function rectFromDrag(anchor: { x: number; y: number }, width: number, height: number): Rect {
  return {
    x: width < 0 ? anchor.x + width : anchor.x,
    y: height < 0 ? anchor.y + height : anchor.y,
    width: Math.abs(width),
    height: Math.abs(height)
  }
}

function clampCrop(rect: Rect, rotated: Size): Rect {
  const width = Math.min(Math.max(rect.width, 1), rotated.width)
  const height = Math.min(Math.max(rect.height, 1), rotated.height)
  return {
    width, height,
    x: Math.min(Math.max(0, rect.x), rotated.width - width),
    y: Math.min(Math.max(0, rect.y), rotated.height - height)
  }
}
