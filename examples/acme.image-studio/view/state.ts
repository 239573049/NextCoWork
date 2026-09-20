/**
 * 编辑器状态模型 + 撤销/重做。
 *
 * ## 为什么是「参数集」而不是「操作流水」
 *
 * 滤镜、旋转、翻转、裁剪、导出尺寸全部存成**参数**(见 `EditorState`),
 * 画笔和文字存成**矢量**(点列/文本项)。整份状态是一个很小的 Plain Object,
 * 撤销 = 状态快照栈 —— 不需要为 16MP 的图留 N 份位图快照,那会把内存
 * 撑爆,而且「拖一下滑杆」在快照栈里就是一条引用。
 *
 * 渲染永远从原始位图 + 当前参数完整重算(`pipeline.ts`),预览降采样、导出
 * 全尺寸 —— 「预览快、导出准」两头都占。
 *
 * ## 坐标系约定(全仓库只此一处定义,别的文件都引用这里的注释)
 *
 * - **R 空间**:原始图经「滤镜 + 旋转 + 翻转」后的画布坐标。裁剪矩形、
 *   画笔轨迹、文字位置全部住在 R 空间 —— 它们在旋转后仍然「跟着图走」。
 * - **O 空间**:裁剪后的输出坐标(R 平移 -crop 原点),再缩放到导出尺寸。
 * - **屏幕空间**:视口像素。换算见 `pipeline.ts` 的 view 系函数。
 */
import { useCallback, useRef, useState } from 'react'

/** 滤镜参数。数值就是 CSS filter 的取值(100 = 无调整,0..200)。 */
export interface Adjustments {
  brightness: number
  contrast: number
  saturate: number
  /** 色相旋转,度。 */
  hue: number
  blur: number
  grayscale: number
  sepia: number
  invert: number
}

export const DEFAULT_ADJUST: Adjustments = {
  brightness: 100, contrast: 100, saturate: 100, hue: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: 0
}

/** R 空间里的矩形。 */
export interface Rect { x: number; y: number; width: number; height: number }

export interface StrokeAnnotation {
  kind: 'stroke'
  id: string
  /** R 空间点列(相邻点连线)。 */
  points: { x: number; y: number }[]
  color: string
  /** R 空间像素宽。 */
  width: number
  /** true = 橡皮:destination-out,只擦自己这一层(标注层),擦不掉底图。 */
  erase: boolean
}

export interface TextAnnotation {
  kind: 'text'
  id: string
  /** R 空间锚点(文字左上角)。 */
  x: number
  y: number
  text: string
  /** R 空间像素字号。 */
  size: number
  color: string
}

export type Annotation = StrokeAnnotation | TextAnnotation

export interface EditorState {
  adjust: Adjustments
  /** 旋转角,度,任意值;显示与导出一致。 */
  angle: number
  flipH: boolean
  flipV: boolean
  /** null = 不裁剪。 */
  crop: Rect | null
  annotations: Annotation[]
  /** 导出尺寸;null = 跟随裁剪后的自然尺寸。 */
  outWidth: number | null
  outHeight: number | null
}

export function initialState(): EditorState {
  return {
    adjust: { ...DEFAULT_ADJUST },
    angle: 0,
    flipH: false,
    flipV: false,
    crop: null,
    annotations: [],
    outWidth: null,
    outHeight: null
  }
}

export function isPristine(state: EditorState): boolean {
  return (
    state.angle === 0 && !state.flipH && !state.flipV && state.crop === null &&
    state.annotations.length === 0 && state.outWidth === null && state.outHeight === null &&
    Object.entries(state.adjust).every(([key, value]) => value === DEFAULT_ADJUST[key as keyof Adjustments])
  )
}

/** 撤销/重做上限:状态对象很小,但画笔轨迹的点列可能很大,封个顶防止长会话吃内存。 */
const HISTORY_LIMIT = 60

export interface History<T> {
  present: T
  /** 离散动作(按钮、应用裁剪):压一次栈并进入新状态。 */
  commit: (next: T) => void
  /**
   * 开始一段「活编辑」(滑杆拖动/聚焦):立刻把当前状态压栈,之后的
   * `replace` 不再压栈。配套 `endLive` 在值没变时把这次压栈撤掉 ——
   * 否则「点了一下滑杆但没动」也会吃掉一次撤销。
   */
  beginLive: () => void
  endLive: (changed: boolean) => void
  /** 活编辑期间更新当前状态(不压栈)。 */
  replace: (next: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useHistory<T>(initial: T): History<T> {
  const [present, setPresent] = useState<T>(initial)
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])
  const live = useRef(false)
  // 版本号:begin/end/undo/redo 改的是 ref,靠它触发一次渲染让 canUndo/canRedo 重算。
  const [, bump] = useState(0)

  const push = useCallback((): void => {
    past.current.push(present)
    if (past.current.length > HISTORY_LIMIT) past.current.shift()
    future.current = []
  }, [present])

  const commit = useCallback((next: T): void => {
    push()
    live.current = false
    setPresent(next)
    bump((n) => n + 1)
  }, [push])

  const beginLive = useCallback((): void => {
    if (live.current) return
    live.current = true
    push()
    bump((n) => n + 1)
  }, [push])

  const endLive = useCallback((changed: boolean): void => {
    if (!live.current) return
    live.current = false
    if (!changed) {
      // 值没变:把 beginLive 压的那份弹回去,撤销栈保持干净
      past.current.pop()
    }
    bump((n) => n + 1)
  }, [])

  const replace = useCallback((next: T): void => {
    setPresent(next)
  }, [])

  const undo = useCallback((): void => {
    const previous = past.current.pop()
    if (previous === undefined) return
    future.current.push(present)
    live.current = false
    setPresent(previous)
    bump((n) => n + 1)
  }, [present])

  const redo = useCallback((): void => {
    const next = future.current.pop()
    if (next === undefined) return
    past.current.push(present)
    live.current = false
    setPresent(next)
    bump((n) => n + 1)
  }, [present])

  return {
    present,
    commit,
    beginLive,
    endLive,
    replace,
    undo,
    redo,
    // 布尔在每次渲染时从 ref 现读 —— 上面这些方法都伴随一次渲染,一定重算。
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0
  }
}
