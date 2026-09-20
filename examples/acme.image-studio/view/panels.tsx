/**
 * 右侧面板 —— 所有数值/选项控件。不持有自己的业务状态,一切改动经
 * `history` 直接入栈(滑杆经 beginLive/replace/endLive 协议,见 `state.ts`)。
 *
 * ★ 面板画出来的每个控件都是一次会失败的承诺:预览模式下变换/调整/画笔
 *   全部不渲染(只读),不摆一堆点不动的高级控件。
 */
import { useRef, useState } from 'react'
import { t } from './i18n'
import type { ExportFormat } from './pipeline'
import type { Adjustments, EditorState, History, TextAnnotation } from './state'
import type { BrushSettings } from './canvas'

export type ExportFormatChoice = 'source' | ExportFormat

export interface PanelProps {
  state: EditorState
  history: History<EditorState>
  mode: 'preview' | 'edit'
  /** 裁剪后的自然尺寸(尺寸面板的占位与比例基准)。 */
  naturalWidth: number
  naturalHeight: number
  brush: BrushSettings
  onBrush: (patch: Partial<BrushSettings>) => void
  /** 选中的文字标注 id;面板据此重算内容 —— 文字本体永远以 state 为准。 */
  selectedTextId: string | null
  onDeleteText: () => void
  /** 源文件扩展名(小写、无点)。 */
  extension: string
  exportFormat: ExportFormatChoice
  exportQuality: number
  onExportFormat: (choice: ExportFormatChoice) => void
  onExportQuality: (quality: number) => void
  /** 扩展名无法从画布编码(gif/bmp/avif/ico → 按 PNG 写)。 */
  fallbackNote: boolean
  animated: boolean
}

/** 滑杆的活编辑协议:按下 begin,拖动 replace,松手 end(changed 才留栈)。 */
function LiveSlider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  history: History<EditorState>
  apply: (value: number, state: EditorState) => EditorState
}): React.ReactElement {
  const origin = useRef(props.value)
  // 松手/失焦统一走这里:props.value 已是 replace 后的最新值(每次 change 都重渲)
  const settle = (): void => { props.history.endLive(props.value !== origin.current) }
  return (
    <div className="row">
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onPointerDown={() => { origin.current = props.value; props.history.beginLive() }}
        onFocus={() => { origin.current = props.value; props.history.beginLive() }}
        onChange={(event) => { props.history.replace(props.apply(Number(event.target.value), props.history.present)) }}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
      />
      <span className="val">{props.value}{props.suffix ?? ''}</span>
    </div>
  )
}

const ADJUST_SLIDERS: { key: keyof Adjustments; label: string; min: number; max: number; suffix?: string }[] = [
  { key: 'brightness', label: t('adjust.brightness'), min: 0, max: 200, suffix: '%' },
  { key: 'contrast', label: t('adjust.contrast'), min: 0, max: 200, suffix: '%' },
  { key: 'saturate', label: t('adjust.saturate'), min: 0, max: 200, suffix: '%' },
  { key: 'hue', label: t('adjust.hue'), min: -180, max: 180, suffix: '°' },
  { key: 'blur', label: t('adjust.blur'), min: 0, max: 40, suffix: 'px' },
  { key: 'grayscale', label: t('adjust.grayscale'), min: 0, max: 100, suffix: '%' },
  { key: 'sepia', label: t('adjust.sepia'), min: 0, max: 100, suffix: '%' },
  { key: 'invert', label: t('adjust.invert'), min: 0, max: 100, suffix: '%' }
]

export function Panel(props: PanelProps): React.ReactElement {
  const { state, history, mode } = props
  const editable = mode === 'edit'

  const [widthText, setWidthText] = useState('')
  const [heightText, setHeightText] = useState('')
  const [lockRatio, setLockRatio] = useState(true)
  const textOrigin = useRef('')

  const selectedText: TextAnnotation | null = (() => {
    const found = state.annotations.find((item) => item.id === props.selectedTextId)
    return found !== undefined && found.kind === 'text' ? found : null
  })()

  const patchText = (current: EditorState, id: string, patch: Partial<TextAnnotation>): EditorState => ({
    ...current,
    annotations: current.annotations.map((item) => (item.id === id && item.kind === 'text' ? { ...item, ...patch } : item))
  })

  const applyResize = (): void => {
    const width = widthText.trim() === '' ? null : Math.max(1, Math.round(Number(widthText)))
    const height = heightText.trim() === '' ? null : Math.max(1, Math.round(Number(heightText)))
    if (width === null && height === null) {
      history.commit({ ...state, outWidth: null, outHeight: null })
      return
    }
    // 只填了一边 + 锁比例:按当前比例补另一边,这是用户「改到 800 宽」的本意
    let finalWidth = width
    let finalHeight = height
    if (lockRatio) {
      const ratio = props.naturalWidth / props.naturalHeight
      if (finalWidth === null && finalHeight !== null) finalWidth = Math.max(1, Math.round(finalHeight * ratio))
      if (finalHeight === null && finalWidth !== null) finalHeight = Math.max(1, Math.round(finalWidth / ratio))
    }
    if (finalWidth === null || finalHeight === null || Number.isNaN(finalWidth) || Number.isNaN(finalHeight)) return
    history.commit({ ...state, outWidth: finalWidth, outHeight: finalHeight })
    setWidthText('')
    setHeightText('')
  }

  const onWidthChange = (text: string): void => {
    setWidthText(text)
    if (lockRatio && text.trim() !== '' && !Number.isNaN(Number(text))) {
      setHeightText(String(Math.max(1, Math.round(Number(text) * props.naturalHeight / props.naturalWidth))))
    }
  }

  const onHeightChange = (text: string): void => {
    setHeightText(text)
    if (lockRatio && text.trim() !== '' && !Number.isNaN(Number(text))) {
      setWidthText(String(Math.max(1, Math.round(Number(text) * props.naturalWidth / props.naturalHeight))))
    }
  }

  const adjustOf = (key: keyof Adjustments): React.ReactElement => (
    <LiveSlider
      key={key}
      label={t(`adjust.${key}`)}
      value={state.adjust[key]}
      min={ADJUST_SLIDERS.find((s) => s.key === key)?.min ?? 0}
      max={ADJUST_SLIDERS.find((s) => s.key === key)?.max ?? 200}
      suffix={ADJUST_SLIDERS.find((s) => s.key === key)?.suffix}
      history={history}
      apply={(value, current) => ({ ...current, adjust: { ...current.adjust, [key]: value } })}
    />
  )

  const qualityVisible = props.exportFormat === 'image/jpeg' || props.exportFormat === 'image/webp' ||
    (props.exportFormat === 'source' && (props.extension === 'jpg' || props.extension === 'jpeg' || props.extension === 'webp'))

  return (
    <div className="panel">
      {editable && (
        <section>
          <h3>{t('tool.rotate')}</h3>
          <div className="btn-row" style={{ marginBottom: 7 }}>
            <button type="button" className="btn" onClick={() => history.commit({ ...state, angle: state.angle - 90 })}>⟲ {t('action.rotateLeft')}</button>
            <button type="button" className="btn" onClick={() => history.commit({ ...state, angle: state.angle + 90 })}>⟳ {t('action.rotateRight')}</button>
          </div>
          <div className="btn-row">
            <button type="button" className={`btn${state.flipH ? ' active' : ''}`} onClick={() => history.commit({ ...state, flipH: !state.flipH })}>⇋ {t('action.flipH')}</button>
            <button type="button" className={`btn${state.flipV ? ' active' : ''}`} onClick={() => history.commit({ ...state, flipV: !state.flipV })}>⇅ {t('action.flipV')}</button>
          </div>
          <LiveSlider
            label={t('adjust.angle')}
            value={Math.round(state.angle)}
            min={-180}
            max={180}
            suffix="°"
            history={history}
            apply={(value, current) => ({ ...current, angle: value })}
          />
        </section>
      )}

      {editable && (
        <section>
          <h3>{t('tool.adjust')}</h3>
          {ADJUST_SLIDERS.map((slider) => adjustOf(slider.key))}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => history.commit({ ...state, adjust: { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0 } })}>
              {t('adjust.reset')}
            </button>
          </div>
        </section>
      )}

      {editable && (
        <section>
          <h3>{t('tool.resize')}</h3>
          <div className="row">
            <label>{t('resize.width')}</label>
            <input type="number" min={1} placeholder={String(props.naturalWidth)} value={widthText} onChange={(event) => { onWidthChange(event.target.value) }} />
          </div>
          <div className="row">
            <label>{t('resize.height')}</label>
            <input type="number" min={1} placeholder={String(props.naturalHeight)} value={heightText} onChange={(event) => { onHeightChange(event.target.value) }} />
          </div>
          <div className="row">
            <label />
            <label style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={lockRatio} onChange={(event) => { setLockRatio(event.target.checked) }} />
              {t('resize.lock')}
            </label>
          </div>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={applyResize}>{t('resize.apply')}</button>
          </div>
          <p className="hint">{t('resize.hint')}</p>
        </section>
      )}

      {editable && (
        <section>
          <h3>{props.brush.erase ? t('tool.eraser') : t('tool.brush')}</h3>
          <div className="row">
            <label>{t('brush.color')}</label>
            <input type="color" value={props.brush.color} onChange={(event) => { props.onBrush({ color: event.target.value }) }} />
          </div>
          <div className="row">
            <label>{t('brush.size')}</label>
            <input type="range" min={1} max={120} value={props.brush.size} onChange={(event) => { props.onBrush({ size: Number(event.target.value) }) }} />
            <span className="val">{props.brush.size}px</span>
          </div>
        </section>
      )}

      {editable && selectedText !== null && (
        <section>
          <h3>{t('tool.text')}</h3>
          {/*
            内容输入走活编辑协议(聚焦 begin / 逐键 replace / 失焦 end):
            逐键 commit 会让撤销变成「一次一键」,而文字本该一次一句地撤销。
          */}
          <div className="row">
            <label>{t('text.content')}</label>
            <input
              type="text"
              value={selectedText.text}
              onFocus={() => { textOrigin.current = selectedText.text; history.beginLive() }}
              onChange={(event) => {
                const text = event.target.value
                history.replace(patchText(state, selectedText.id, { text }))
              }}
              onBlur={() => { history.endLive(selectedText.text !== textOrigin.current) }}
            />
          </div>
          <LiveSlider
            label={t('text.size')}
            value={selectedText.size}
            min={8}
            max={400}
            suffix="px"
            history={history}
            apply={(value, current) => patchText(current, selectedText.id, { size: value })}
          />
          <div className="row">
            <label>{t('text.color')}</label>
            <input
              type="color"
              value={selectedText.color}
              onChange={(event) => { history.commit(patchText(state, selectedText.id, { color: event.target.value })) }}
            />
          </div>
          <div className="btn-row">
            <button type="button" className="btn danger" onClick={props.onDeleteText}>{t('text.delete')}</button>
          </div>
          <p className="hint">{t('text.hint')}</p>
        </section>
      )}

      <section>
        <h3>{t('tool.export')}</h3>
        <div className="row">
          <label>{t('export.format')}</label>
          <select value={props.exportFormat} onChange={(event) => { props.onExportFormat(event.target.value as ExportFormatChoice) }}>
            <option value="source">{t('export.sameFormat')}</option>
            <option value="image/png">PNG</option>
            <option value="image/jpeg">JPEG</option>
            <option value="image/webp">WebP</option>
          </select>
        </div>
        {qualityVisible && (
          <div className="row">
            <label>{t('export.quality')}</label>
            <input
              type="range" min={50} max={100} value={Math.round(props.exportQuality * 100)}
              onChange={(event) => { props.onExportQuality(Number(event.target.value) / 100) }}
            />
            <span className="val">{Math.round(props.exportQuality * 100)}%</span>
          </div>
        )}
        {props.fallbackNote && props.exportFormat === 'source' && <p className="hint">{t('export.pngNote')}</p>}
        {props.animated && <p className="hint">{t('export.gifNote')}</p>}
        {(props.exportFormat === 'image/jpeg' || (props.exportFormat === 'source' && (props.extension === 'jpg' || props.extension === 'jpeg'))) &&
          <p className="hint">{t('export.jpegNote')}</p>}
      </section>
    </div>
  )
}
