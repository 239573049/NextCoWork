/**
 * 渲染管线 —— 状态到像素的全部换算,纯函数(不碰 React)。
 *
 * ## 管线次序(固定,不做可重排的操作栈)
 *
 * ```
 * 原始位图 ─滤镜+旋转+翻转→ R 画布 ─裁剪→ O 空间 ─缩放→ 导出尺寸
 *                                   └ 标注层(画笔/文字,住在 R 空间)同裁同缩
 * ```
 *
 * 次序固定让坐标系只有一种解释(见 `state.ts` 的约定):裁剪与标注都在
 * 「旋转后」的空间里,用户先转再裁、先画再转,结果都可预测。
 *
 * ## 预览与导出同一条管线、两个分辨率
 *
 * `compose(state, source, scale)` 是唯一的合成入口:预览给小 scale(视口
 * 上限),导出给 1。分开写两套迟早长得不一样,而「预览看到的和存出来的
 * 不一致」是图片编辑器最坏的 bug。
 */
import type { Adjustments, EditorState, Rect } from './state'

export interface Size { width: number; height: number }

/** 旋转后(R 空间)的外接框。用 ceil:宁可多一列透明像素,不可裁掉半列内容。 */
export function rotatedSize(width: number, height: number, angleDeg: number): Size {
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return {
    width: Math.ceil(width * cos + height * sin),
    height: Math.ceil(width * sin + height * cos)
  }
}

/** 只拼非恒等项:Chromium 对 filter 串越长越慢,恒等项白付。 */
export function filterString(adjust: Adjustments): string {
  const parts: string[] = []
  if (adjust.brightness !== 100) parts.push(`brightness(${adjust.brightness}%)`)
  if (adjust.contrast !== 100) parts.push(`contrast(${adjust.contrast}%)`)
  if (adjust.saturate !== 100) parts.push(`saturate(${adjust.saturate}%)`)
  if (adjust.hue !== 0) parts.push(`hue-rotate(${adjust.hue}deg)`)
  if (adjust.blur !== 0) parts.push(`blur(${adjust.blur}px)`)
  if (adjust.grayscale !== 0) parts.push(`grayscale(${adjust.grayscale}%)`)
  if (adjust.sepia !== 0) parts.push(`sepia(${adjust.sepia}%)`)
  if (adjust.invert !== 0) parts.push(`invert(${adjust.invert}%)`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

/** R 画布:滤镜 + 旋转 + 翻转 后的原始图。 */
function renderRotated(source: CanvasImageSource, sourceSize: Size, state: EditorState): HTMLCanvasElement {
  const size = rotatedSize(sourceSize.width, sourceSize.height, state.angle)
  const canvas = makeCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return canvas
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((state.angle * Math.PI) / 180)
  ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1)
  ctx.filter = filterString(state.adjust)
  ctx.drawImage(source, -sourceSize.width / 2, -sourceSize.height / 2)
  return canvas
}

/** 生效的裁剪矩形(R 空间,已与 R 边界求交)。 */
export function effectiveCrop(state: EditorState, rotated: Size): Rect {
  if (state.crop === null) return { x: 0, y: 0, width: rotated.width, height: rotated.height }
  const x = Math.max(0, Math.min(state.crop.x, rotated.width - 1))
  const y = Math.max(0, Math.min(state.crop.y, rotated.height - 1))
  return {
    x, y,
    width: Math.max(1, Math.min(state.crop.width, rotated.width - x)),
    height: Math.max(1, Math.min(state.crop.height, rotated.height - y))
  }
}

/** 导出尺寸(裁剪后自然尺寸 × 显式缩放)。 */
export function outputSize(state: EditorState, rotated: Size): Size {
  const crop = effectiveCrop(state, rotated)
  return {
    width: state.outWidth !== null ? Math.max(1, Math.round(state.outWidth)) : crop.width,
    height: state.outHeight !== null ? Math.max(1, Math.round(state.outHeight)) : crop.height
  }
}

function drawAnnotations(ctx: CanvasRenderingContext2D, state: EditorState, crop: Rect, scale: number): void {
  ctx.save()
  ctx.scale(scale, scale)
  // 标注住在 R 空间:先平移掉裁剪原点。crop 由调用方传**生效裁剪**
  // (effectiveCrop),与底图的取样矩形同源 —— 两处各算一遍的话,越界裁剪
  // 被钳制时标注会和底图错位。
  ctx.translate(-crop.x, -crop.y)
  for (const annotation of state.annotations) {
    if (annotation.kind === 'stroke') {
      ctx.save()
      ctx.globalCompositeOperation = annotation.erase ? 'destination-out' : 'source-over'
      ctx.strokeStyle = annotation.color
      ctx.lineWidth = annotation.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const points = annotation.points
      if (points.length === 1) {
        // 单点 = 点一下:画一个零长度线段,靠 round cap 呈现圆点
        ctx.moveTo(points[0].x, points[0].y)
        ctx.lineTo(points[0].x + 0.01, points[0].y)
      } else {
        ctx.moveTo(points[0].x, points[0].y)
        for (let i = 1; i < points.length - 1; i += 1) {
          // 中点二次平滑:折线感消失,笔迹像笔
          const midX = (points[i].x + points[i + 1].x) / 2
          const midY = (points[i].y + points[i + 1].y) / 2
          ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY)
        }
        const last = points[points.length - 1]
        ctx.lineTo(last.x, last.y)
      }
      ctx.stroke()
      ctx.restore()
      continue
    }
    ctx.save()
    ctx.fillStyle = annotation.color
    ctx.font = `${annotation.size}px -apple-system, 'PingFang SC', 'Segoe UI', sans-serif`
    ctx.textBaseline = 'top'
    const lines = annotation.text.split('\n')
    lines.forEach((line, index) => { ctx.fillText(line, annotation.x, annotation.y + index * annotation.size * 1.25) })
    ctx.restore()
  }
  ctx.restore()
}

export interface ComposeResult {
  /** 合成结果(导出/预览直接用)。 */
  canvas: HTMLCanvasElement
  /** 标注单独一层 —— 预览时鼠标交互需要知道「点到了哪个文字」。 */
  annotations: HTMLCanvasElement
  /** 本结果对应的 O 空间尺寸(= state 的导出尺寸)。 */
  out: Size
}

/**
 * 唯一的合成入口。`scale` 是 O 空间 → 像素的缩放:预览传视口上限算出的
 * 比例,导出传 1。`flattenWhite` 给 JPEG(不支持透明)。
 */
export function compose(
  source: CanvasImageSource,
  sourceSize: Size,
  state: EditorState,
  scale: number,
  flattenWhite: boolean
): ComposeResult {
  const rotated = rotatedSize(sourceSize.width, sourceSize.height, state.angle)
  const crop = effectiveCrop(state, rotated)
  const out = outputSize(state, rotated)
  const pixelWidth = Math.max(1, Math.round(out.width * scale))
  const pixelHeight = Math.max(1, Math.round(out.height * scale))
  const innerScale = pixelWidth / out.width

  const rotatedCanvas = renderRotated(source, sourceSize, state)
  const canvas = makeCanvas(pixelWidth, pixelHeight)
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    if (flattenWhite) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(rotatedCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
  }

  const annotations = makeCanvas(pixelWidth, pixelHeight)
  const annCtx = annotations.getContext('2d')
  if (annCtx !== null) drawAnnotations(annCtx, state, crop, innerScale)

  return { canvas, annotations, out }
}

/** 预览上限:长边超过这个值就降采样 —— 16MP 图每帧全量重算会卡成幻灯片。 */
export const PREVIEW_MAX_EDGE = 1800

export function previewScale(out: Size): number {
  const longest = Math.max(out.width, out.height)
  return longest <= PREVIEW_MAX_EDGE ? 1 : PREVIEW_MAX_EDGE / longest
}

let textMeasurer: CanvasRenderingContext2D | null = null

/** 文字标注的命中框(R 空间)。宽高按当前字体度量,行高 1.25。 */
export function textBounds(text: string, size: number): { width: number; height: number } {
  if (textMeasurer === null) {
    textMeasurer = document.createElement('canvas').getContext('2d')
  }
  const ctx = textMeasurer
  if (ctx === null) return { width: 0, height: 0 }
  ctx.font = `${size}px -apple-system, 'PingFang SC', 'Segoe UI', sans-serif`
  const lines = text.split('\n')
  const width = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0)
  return { width, height: lines.length * size * 1.25 }
}

// ─────────────────── 导出编码 ───────────────────

export type ExportFormat = 'image/png' | 'image/jpeg' | 'image/webp'

/** 能从 Canvas 编码的扩展名 → 格式;编不了的(gif/bmp/avif/ico)回落 PNG。 */
export function formatForExtension(extension: string): { format: ExportFormat; fallbackNote: boolean } {
  if (extension === 'png') return { format: 'image/png', fallbackNote: false }
  if (extension === 'jpg' || extension === 'jpeg') return { format: 'image/jpeg', fallbackNote: false }
  if (extension === 'webp') return { format: 'image/webp', fallbackNote: false }
  return { format: 'image/png', fallbackNote: true }
}

function toBase64(bytes: Uint8Array): string {
  // 分块 btoa:几 MB 的图一次性 String.fromCharCode.apply 会爆调用栈
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function encodeCanvas(canvas: HTMLCanvasElement, format: ExportFormat, quality: number): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, format, quality) })
  if (blob === null) throw new Error('encode failed')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return toBase64(bytes)
}

export function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}
