/**
 * Image Studio 的根组件 —— 跑在主窗口的 `ncw-plugin://acme.image-studio` iframe 里。
 *
 * ## 它拥有的东西
 *
 * - 文档生命周期:向宿主要文件(dec)、解码成位图、失败画空态;
 * - 编辑状态与历史(`state.ts` 的 useHistory);
 * - 保存:自动保存(变更后 1.5s 防抖)+ 立即保存按钮 + pagehide 兜底,
 *   全部经文档通道以 base64 写回**原文件**;
 * - 顶栏(预览/编辑切换、撤销/重做、重置、保存)与左侧工具栏。
 *
 * ## 保存为什么是「自动」而不是「只手动」
 *
 * 宿主对插件自定义编辑器 Tab **没有关闭挽留**(关了就关了),手动保存是
 * 唯一入口的话,用户合 Tab 那一下编辑就全没了。跟 `acme.excalidraw` 的
 * 先例一致:自动保存 + 全量撤销(重置/撤销可回到原始参数,原始字节本身
 * 由工作区的版本控制兜底)。保存冲突(外部同时改了文件)会收到
 * saveFailed 并停在「未保存」状态,不会静默覆盖。
 *
 * ## 保存失败的重试
 *
 * 状态条「保存失败,点击重试」本身就是重试按钮 —— 失败后不再自动重试,
 * 否则一条注定失败的请求会每 1.5s 打一次主进程。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Viewport, type BrushSettings, type Tool } from './canvas'
import { notifyReady, onDocOpen, onDocSaveFailed, onDocSaved, saveDoc, type OpenedDoc } from './doc'
import { t } from './i18n'
import { Panel, type ExportFormatChoice } from './panels'
import { compose, effectiveCrop, encodeCanvas, formatForExtension, rotatedSize, type ExportFormat } from './pipeline'
import { initialState, isPristine, useHistory, type EditorState } from './state'
import './styles.css'

/** 自动保存防抖:太短会把滑杆拖动写成 N 次编码,太长则关窗风险窗口变大。 */
const AUTOSAVE_DELAY_MS = 1500

const TEXT_DEFAULTS = { color: '#ffffff', size: 48 }

function fileExtension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('decode failed')) }
    image.src = dataUrl
  })
}

function uid(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed'

function App(): React.ReactElement {
  const [doc, setDoc] = useState<OpenedDoc | null>(null)
  const [source, setSource] = useState<HTMLImageElement | null>(null)
  const [openFailed, setOpenFailed] = useState(false)
  const history = useHistory<EditorState>(initialState())
  const state = history.present

  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [tool, setTool] = useState<Tool>('pan')
  const [brush, setBrush] = useState<BrushSettings>({ color: '#ff4d4f', size: 8, erase: false })
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [exportFormat, setExportFormat] = useState<ExportFormatChoice>('source')
  const [exportQuality, setExportQuality] = useState(0.92)
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [lastBytes, setLastBytes] = useState<number | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  // ── 文档装载 ───────────────────

  useEffect(() => {
    onDocOpen((opened) => {
      setDoc(opened)
      if (opened.data === '') {
        setOpenFailed(true)
        return
      }
      setOpenFailed(false)
      void loadImage(opened.data)
        .then((image) => { setSource(image) })
        .catch(() => { setOpenFailed(true) })
    })
    notifyReady()
  }, [])

  const extension = fileExtension(doc?.path ?? '')
  const animated = doc?.mime === 'image/gif'
  const { fallbackNote } = formatForExtension(extension)

  // 面板「尺寸」的占位基准:裁剪后、未缩放的自然尺寸(outWidth 为空时它就是导出尺寸)
  const naturalSize = source === null
    ? { width: 0, height: 0 }
    : (() => {
        const rotated = rotatedSize(source.naturalWidth, source.naturalHeight, state.angle)
        const crop = effectiveCrop(state, rotated)
        return { width: crop.width, height: crop.height }
      })()

  // ── 保存 ───────────────────

  const savedKeyRef = useRef<string>(JSON.stringify(initialState()))
  const pendingKeyRef = useRef<string>(JSON.stringify(initialState()))
  const stateKey = JSON.stringify(state)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const sourceRef = useRef(source)
  sourceRef.current = source
  const formatRef = useRef({ exportFormat, exportQuality, extension })
  formatRef.current = { exportFormat, exportQuality, extension }
  const saveStateRef = useRef<SaveState>('clean')
  saveStateRef.current = saveState

  const doSave = useCallback(async (): Promise<void> => {
    const currentSource = sourceRef.current
    if (currentSource === null || savingRef.current) return
    const snapshot = JSON.stringify(stateRef.current)
    const { exportFormat: formatChoice, exportQuality: quality, extension: ext } = formatRef.current
    const format: ExportFormat = formatChoice === 'source' ? formatForExtension(ext).format : formatChoice
    const flatten = format === 'image/jpeg'
    setSaveState('saving')
    savingRef.current = true
    // ★ 只记「等确认」的快照,真正标记已保存要等宿主的 ncw:doc:saved ——
    //   提前写 savedKeyRef 的话,一次失败的写会让后续自动保存全部误判「没变过」。
    pendingKeyRef.current = snapshot
    try {
      const result = compose(
        currentSource,
        { width: currentSource.naturalWidth, height: currentSource.naturalHeight },
        stateRef.current,
        1,
        flatten
      )
      const base64 = await encodeCanvas(result.canvas, format, quality)
      // base64 长度反推字节数:去掉 padding 再乘 3/4
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
      setLastBytes(Math.floor((base64.length * 3) / 4) - padding)
      saveDoc(base64, 'base64')
    } catch {
      setSaveState('failed')
      savingRef.current = false
    }
  }, [])

  useEffect(() => {
    onDocSaved(() => {
      savingRef.current = false
      savedKeyRef.current = pendingKeyRef.current
      setSaveState((current) => (current === 'saving' ? 'saved' : current))
      if (pendingRef.current) {
        pendingRef.current = false
        void doSave()
      }
    })
    onDocSaveFailed(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }, [doSave])

  // 自动保存:状态一变标脏 + 防抖。失败态不再自动重试(见文件头)。
  useEffect(() => {
    if (stateKey === savedKeyRef.current) return
    if (saveStateRef.current !== 'failed' && saveStateRef.current !== 'saving') setSaveState('dirty')
    if (saveStateRef.current === 'failed') return
    if (saveStateRef.current === 'saving') { pendingRef.current = true; return }
    const timer = window.setTimeout(() => { void doSave() }, AUTOSAVE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [stateKey, doSave])

  // pagehide 兜底:防抖里的那次还没落就关 Tab,能抢一拍是一拍。
  useEffect(() => {
    const flush = (): void => {
      if (JSON.stringify(stateRef.current) !== savedKeyRef.current && !savingRef.current) void doSave()
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush) }
  }, [doSave])

  // ── 键盘:撤销/重做/保存 ───────────────────

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) history.redo()
        else history.undo()
        return
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [history, doSave])

  // ── 编辑动作 ───────────────────

  const placeText = (x: number, y: number): void => {
    const id = uid()
    history.commit({
      ...state,
      annotations: [...state.annotations, { kind: 'text', id, x, y, text: '', size: TEXT_DEFAULTS.size, color: TEXT_DEFAULTS.color }]
    })
    setSelectedTextId(id)
    setEditingTextId(id)
  }

  const onTextEdit = (id: string, value: string | null): void => {
    setEditingTextId(null)
    const annotation = state.annotations.find((item) => item.id === id)
    if (annotation === undefined) return
    if (value === null) {
      // Esc:新放的空文字直接撤掉,已写的保持原样
      if (annotation.kind === 'text' && annotation.text === '') {
        history.commit({ ...state, annotations: state.annotations.filter((item) => item.id !== id) })
        setSelectedTextId(null)
      }
      return
    }
    if (value.trim() === '') {
      history.commit({ ...state, annotations: state.annotations.filter((item) => item.id !== id) })
      setSelectedTextId(null)
      return
    }
    history.commit({
      ...state,
      annotations: state.annotations.map((item) => (item.id === id && item.kind === 'text' ? { ...item, text: value } : item))
    })
  }

  const deleteSelectedText = (): void => {
    if (selectedTextId === null) return
    history.commit({ ...state, annotations: state.annotations.filter((item) => item.id !== selectedTextId) })
    setSelectedTextId(null)
  }

  const resetAll = (): void => {
    if (!confirmReset) {
      setConfirmReset(true)
      window.setTimeout(() => { setConfirmReset(false) }, 2500)
      return
    }
    setConfirmReset(false)
    history.commit(initialState())
    setSelectedTextId(null)
  }

  const pristine = isPristine(state)

  // ── 渲染 ───────────────────

  if (doc === null) {
    return <div className="app"><div className="viewport"><div className="empty">…</div></div></div>
  }

  if (openFailed || source === null) {
    return (
      <div className="app">
        <div className="viewport">
          <div className="empty">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('empty.title')}</div>
            <div>{t('empty.bad')}</div>
          </div>
        </div>
      </div>
    )
  }

  const saveLabel =
    saveState === 'saving' ? t('state.saving') :
    saveState === 'saved' ? t('state.saved') :
    saveState === 'failed' ? t('state.failed') :
    saveState === 'dirty' ? t('state.dirty') : ''

  const ToolButton = (props: { name: Tool; label: string; glyph: string; visible: boolean }): React.ReactElement | null => {
    if (!props.visible) return null
    return (
      <button
        type="button"
        aria-pressed={tool === props.name}
        title={props.label}
        onClick={() => {
          setTool(props.name)
          if (mode === 'preview' && props.name !== 'pan') setMode('edit')
        }}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>{props.glyph}</span>
      </button>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
            <circle cx="5.6" cy="5.6" r="1.4" fill="var(--accent)" />
            <path d="M2.5 12 L6.5 8 L9.5 11 L11.5 9 L14 11.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          Image Studio
        </div>
        <div className="seg" role="group" aria-label={t('mode.edit')}>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => { setMode('preview'); setTool('pan') }}>{t('mode.preview')}</button>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => { setMode('edit') }}>{t('mode.edit')}</button>
        </div>
        <button type="button" className="btn icon" disabled={!history.canUndo} onClick={history.undo} title={t('action.undo')} aria-label={t('action.undo')}>↺</button>
        <button type="button" className="btn icon" disabled={!history.canRedo} onClick={history.redo} title={t('action.redo')} aria-label={t('action.redo')}>↻</button>
        <button type="button" className="btn" disabled={pristine} onClick={resetAll}>{confirmReset ? t('action.resetConfirm') : t('action.reset')}</button>
        <div className="spacer" />
        <span className={`save-state ${saveState}`} onClick={() => { if (saveState === 'failed') void doSave() }}>{saveLabel}</span>
        <button type="button" className="btn primary" onClick={() => { void doSave() }}>{t('action.save')}</button>
      </header>

      <div className="main">
        <nav className="toolrail" aria-label={t('mode.edit')}>
          <ToolButton name="pan" label={t('tool.pan')} glyph="✥" visible />
          <ToolButton name="crop" label={t('tool.crop')} glyph="⌗" visible />
          <ToolButton name="brush" label={brush.erase ? t('tool.eraser') : t('tool.brush')} glyph={brush.erase ? '⌫' : '✎'} visible />
          <button
            type="button"
            aria-pressed={brush.erase}
            title={t('tool.eraser')}
            onClick={() => {
              setBrush((current) => ({ ...current, erase: !current.erase }))
              setTool('brush')
              if (mode === 'preview') setMode('edit')
            }}
          >
            <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>⌫</span>
          </button>
          <ToolButton name="text" label={t('tool.text')} glyph="T" visible />
        </nav>

        <Viewport
          source={source}
          state={state}
          mode={mode}
          tool={tool}
          brush={brush}
          onSelectText={setSelectedTextId}
          onPlaceText={placeText}
          onCommitStroke={(stroke) => {
            history.commit({ ...state, annotations: [...state.annotations, { kind: 'stroke', id: uid(), ...stroke }] })
          }}
          onMoveText={(id, x, y) => {
            history.commit({
              ...state,
              annotations: state.annotations.map((item) => (item.id === id && item.kind === 'text' ? { ...item, x, y } : item))
            })
          }}
          onApplyCrop={(rect) => { history.commit({ ...state, crop: rect }) }}
          editingTextId={editingTextId}
          onTextEdit={onTextEdit}
          lastSavedBytes={lastBytes}
          animated={animated}
        />

        <Panel
          state={state}
          history={history}
          mode={mode}
          naturalWidth={naturalSize.width}
          naturalHeight={naturalSize.height}
          brush={brush}
          onBrush={(patch) => { setBrush((current) => ({ ...current, ...patch })) }}
          selectedTextId={selectedTextId}
          onDeleteText={deleteSelectedText}
          extension={extension}
          exportFormat={exportFormat}
          exportQuality={exportQuality}
          onExportFormat={setExportFormat}
          onExportQuality={setExportQuality}
          fallbackNote={fallbackNote}
          animated={animated}
        />
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (container !== null) createRoot(container).render(<App />)
