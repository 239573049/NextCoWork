/**
 * Markdown Studio 根组件 —— 跑在 `ncw-plugin://acme.markdown-studio` iframe 里。
 *
 * ## 形态
 *
 * 编辑 / 所见即所得 / 预览 三态,默认**所见即所得** —— 打开 .md 直接改
 * 渲染结果,源码编辑与只读预览按需切换。「所见即所得」是 Milkdown
 * (ProseMirror)的真富文本编辑(直接改渲染结果,不是分屏看源码):三个
 * 面板**同一份 `text` 状态**,进出所见即所得都用当前文本重建编辑器,
 * 不存在双编辑器互相同步的拉锯(见 `wysiwyg.tsx`)。
 * ★ 编辑器**始终保持挂载**(切换只切显隐):卸载重挂会丢光标、撤销栈和
 * 滚动位置,而「切到预览看一眼再回来」是高频动作。预览只在可见时渲染 ——
 * 它是整棵树最贵的一块。大纲默认隐藏,顶栏开关按需唤出(导航辅助,不是
 * 每份文档都值得常驻一栏)。
 *
 * ## 保存(与 image-studio 同一立场)
 *
 * 自动保存(800ms 防抖)+ ⌘S + pagehide 兜底。宿主对插件 Tab 没有关闭挽留,
 * 手动保存是唯一入口的话,合 Tab 那一下就全丢了。冲突/失败停在「未保存」
 * 状态,不自动重试 —— 一条注定失败的请求每 800ms 打一次主进程没有意义。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { indentWithTab } from '@codemirror/commands'
import { notifyReady, onDocOpen, onDocSaveFailed, onDocSaved, saveDoc, type OpenedDoc } from './doc'
import { t } from './i18n'
import { scanOutline } from './outline'
import { MarkdownPreviewBody } from './preview'
import { computeStats } from './stats'
import { insertBlock, insertLink, toggleLinePrefix, wrapSelection, TEMPLATES } from './toolbar-actions'
import { useHostTheme } from './use-host-theme'
import { WysiwygEditor } from './wysiwyg'
import './styles.css'

const AUTOSAVE_DELAY_MS = 800

type Mode = 'edit' | 'wysiwyg' | 'preview'
type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed'

function App(): React.ReactElement {
  const [doc, setDoc] = useState<OpenedDoc | null>(null)
  const [text, setText] = useState('')
  // 需求:默认所见即所得 —— 打开 .md 直接改渲染结果,源码编辑是按需切换的
  // 进阶视图;三个面板同一份 text,切走再切回各面板状态都在(见文件头)。
  const [mode, setMode] = useState<Mode>('wysiwyg')
  // 需求:大纲默认隐藏 —— 大纲是导航辅助,不是每份文档都需要它占一栏;
  // 顶栏开关按需唤出。状态不持久化:打开下一个文件回到默认,不让一个
  // 文档的结构浏览习惯污染另一个。
  const [outlineVisible, setOutlineVisible] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const savedTextRef = useRef('')
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const textRef = useRef('')
  textRef.current = text
  const saveStateRef = useRef<SaveState>('clean')
  saveStateRef.current = saveState

  // ── 装载 ───────────────────

  useEffect(() => {
    onDocOpen((opened) => {
      setDoc(opened)
      setText(opened.data)
      savedTextRef.current = opened.data
    })
    notifyReady()
  }, [])

  // ── 保存 ───────────────────

  const pendingKeyRef = useRef('')

  const doSave = useCallback((): void => {
    if (savingRef.current) return
    const snapshot = textRef.current
    if (snapshot === savedTextRef.current) return
    setSaveState('saving')
    savingRef.current = true
    pendingKeyRef.current = snapshot
    saveDoc(snapshot)
  }, [])

  useEffect(() => {
    onDocSaved(() => {
      savingRef.current = false
      savedTextRef.current = pendingKeyRef.current
      setSaveState((current) => (current === 'saving' ? 'saved' : current))
      if (pendingRef.current) {
        pendingRef.current = false
        doSave()
      }
    })
    onDocSaveFailed(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }, [doSave])

  // 自动保存:文本变了才标脏 + 防抖;失败态不自动重试(见文件头)
  useEffect(() => {
    if (text === savedTextRef.current) {
      if (saveStateRef.current !== 'saving' && saveStateRef.current !== 'failed') setSaveState('clean')
      return
    }
    if (saveStateRef.current === 'failed') { setSaveState('dirty'); return }
    if (saveStateRef.current === 'saving') { pendingRef.current = true; setSaveState('dirty'); return }
    setSaveState('dirty')
    const timer = window.setTimeout(() => { doSave() }, AUTOSAVE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [text, doSave])

  // pagehide 兜底:防抖里那次还没落就关 Tab,能抢一拍是一拍
  useEffect(() => {
    const flush = (): void => {
      if (textRef.current !== savedTextRef.current && !savingRef.current) {
        saveDoc(textRef.current)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush) }
  }, [])

  // ── 快捷键 ───────────────────

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [doSave])

  // ── 派生数据 ───────────────────

  const stats = useMemo(() => computeStats(text), [text])
  const outlineItems = useMemo(() => scanOutline(text), [text])

  /*
    大纲跳转到所见即所得面板的信号:WYSIWYG 没有「行」的概念,
    jumpTo 在 wysiwyg 模式下只发文本信号,由 wysiwyg.tsx 做文本匹配滚动。
  */
  const [scrollSignal, setScrollSignal] = useState<{ text: string; stamp: number } | null>(null)

  // ── 编辑器扩展 ───────────────────

  /*
    CM 主题两条腿(同宿主 `views/files/CodeEditor.tsx` 的做法):
    1. @uiw 的 `theme` prop 切自带的浅/深底(没有它 CM 永远浅色,深色下白底一块);
    2. 这个 EditorView.theme 把内部颜色全部映到 --ncw-* 变量 —— 换色器
       换 accent 时编辑器跟着走,不需要第二套字面量。
    ★ appearance 进依赖:主题切换必须重建扩展,CM 不响应 prop 变化。
  */
  const appearance = useHostTheme()

  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    EditorView.lineWrapping,
    keymap.of([indentWithTab]),
    EditorView.theme({
      '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '13.5px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace", lineHeight: '1.6' },
      '.cm-content': { caretColor: 'var(--fg)' },
      '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-muted)', border: 'none' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
      '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)' },
      '.cm-textfield': { background: 'var(--panel-2)', color: 'var(--fg)', borderColor: 'var(--border)' },
      '.cm-button': { background: 'var(--panel-2)', color: 'var(--fg)', borderColor: 'var(--border)' }
    }, { dark: appearance === 'dark' }),
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) return
      const pos = update.state.selection.main.head
      const line = update.state.doc.lineAt(pos)
      setCursor({ line: line.number, col: pos - line.from + 1 })
    })
  ], [appearance])

  // ── 大纲跳转:编辑器按行(精确);预览/WYSIWYG 发文本信号匹配兜底 ───────────────────

  const jumpTo = (line: number, text: string): void => {
    const view = cmRef.current?.view
    if (view !== undefined) {
      const target = view.state.doc.line(Math.min(line + 1, view.state.doc.lines))
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
    }
    if (mode === 'wysiwyg') {
      setScrollSignal({ text, stamp: Date.now() })
      return
    }
    const preview = previewRef.current
    if (preview !== null) {
      const stripped = text.replace(/[*_`~]/g, '')
      const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6')
      for (const element of headings) {
        if ((element.textContent ?? '').replace(/[*_`~]/g, '') === stripped) {
          element.scrollIntoView({ block: 'start' })
          break
        }
      }
    }
  }

  // ── 工具栏 ───────────────────

  const withView = (action: (view: EditorView) => void): void => {
    const view = cmRef.current?.view
    if (view === undefined) return
    action(view)
  }

  const TB = (props: { label: string; glyph: string; run: () => void; separator?: boolean }): React.ReactElement | null => {
    // 工具按钮全部是源码事务(见 toolbar-actions.ts)—— 只在源码编辑模式出现;
    // 所见即所得用输入规则与键盘(没有一套源码操作能无损映到 ProseMirror 上)。
    if (mode !== 'edit') return null
    return (
      <>
        {props.separator === true && <span className="divider" />}
        <button type="button" title={props.label} aria-label={props.label} onClick={props.run}>
          <span aria-hidden>{props.glyph}</span>
        </button>
      </>
    )
  }

  const saveLabel =
    saveState === 'saving' ? t('state.saving') :
    saveState === 'saved' ? t('state.saved') :
    saveState === 'failed' ? t('state.failed') :
    saveState === 'dirty' ? t('state.dirty') : ''

  const fileName = doc?.path.split('/').pop() ?? ''

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
            <path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Markdown Studio{fileName === '' ? '' : <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>· {fileName}</span>}
        </div>
        <div className="seg" role="group" aria-label="view mode">
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => { setMode('edit') }}>{t('mode.edit')}</button>
          <button type="button" aria-pressed={mode === 'wysiwyg'} onClick={() => { setMode('wysiwyg') }}>{t('mode.wysiwyg')}</button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => { setMode('preview') }}>{t('mode.preview')}</button>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className={`btn${outlineVisible ? ' active' : ''}`}
          aria-pressed={outlineVisible}
          title={t('outline.title')}
          onClick={() => { setOutlineVisible((v) => !v) }}
        >
          ☰ {t('outline.title')}
        </button>
        <span className={`save-state ${saveState}`} onClick={() => { if (saveState === 'failed') doSave() }}>{saveLabel}</span>
        <button type="button" className="btn primary" disabled={saveState === 'clean'} onClick={doSave}>{t('action.save')}</button>
      </header>

      <div className="toolbar" role="toolbar" aria-label="markdown">
        <TB label={`H1 ${t('toolbar.heading')}`} glyph="H1" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^#{1,6}\s/.exec(l)?.[0] ?? null, () => '# ')) }} />
        <TB label={`H2 ${t('toolbar.heading')}`} glyph="H2" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^#{1,6}\s/.exec(l)?.[0] ?? null, () => '## ')) }} />
        <TB label={`H3 ${t('toolbar.heading')}`} glyph="H3" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^#{1,6}\s/.exec(l)?.[0] ?? null, () => '### ')) }} separator />
        <TB label={t('toolbar.bold')} glyph="B" run={() => { withView((v) => wrapSelection(v, '**', 'bold')) }} />
        <TB label={t('toolbar.italic')} glyph="I" run={() => { withView((v) => wrapSelection(v, '*', 'italic')) }} />
        <TB label={t('toolbar.strike')} glyph="S" run={() => { withView((v) => wrapSelection(v, '~~', 'text')) }} />
        <TB label={t('toolbar.code')} glyph="‹›" run={() => { withView((v) => wrapSelection(v, '`', 'code')) }} separator />
        <TB label={t('toolbar.link')} glyph="🔗" run={() => { withView((v) => insertLink(v, false)) }} />
        <TB label={t('toolbar.image')} glyph="🖼" run={() => { withView((v) => insertLink(v, true)) }} />
        <TB label={t('toolbar.codeBlock')} glyph="{ }" run={() => { withView((v) => insertBlock(v, TEMPLATES.codeBlock, TEMPLATES.codeBlockCursor)) }} separator />
        <TB label={t('toolbar.quote')} glyph="❝" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^>\s?/.exec(l)?.[0] ?? null, () => '> ')) }} />
        <TB label={t('toolbar.list')} glyph="•" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^[-*]\s/.exec(l)?.[0] ?? null, () => '- ')) }} />
        <TB label={t('toolbar.ordered')} glyph="1." run={() => { withView((v) => toggleLinePrefix(v, (l) => /^\d+\.\s/.exec(l)?.[0] ?? null, (i) => `${i + 1}. `)) }} />
        <TB label={t('toolbar.task')} glyph="☑" run={() => { withView((v) => toggleLinePrefix(v, (l) => /^[-*]\s\[[ x]\]\s/.exec(l)?.[0] ?? null, () => '- [ ] ')) }} />
        <TB label={t('toolbar.table')} glyph="⊞" run={() => { withView((v) => insertBlock(v, TEMPLATES.table)) }} separator />
        <TB label={t('toolbar.hr')} glyph="—" run={() => { withView((v) => insertBlock(v, TEMPLATES.hr)) }} />
        <TB label={t('toolbar.math')} glyph="∑" run={() => { withView((v) => insertBlock(v, TEMPLATES.mathBlock)) }} />
        <TB label={t('toolbar.mermaid')} glyph="◈" run={() => { withView((v) => insertBlock(v, TEMPLATES.mermaid)) }} />
      </div>

      <div className="main">
        {/*
          编辑器常驻挂载,只切显隐(见文件头)。
          ★ 只在「编辑」模式可见 —— 所见即所得自己占一整栏,源码面板若同时
          显示就是分屏,而分屏已被所见即所得取代(那是 0.2.0 的全责重构点)。
        */}
        <div className="editor-pane" style={{ display: mode === 'edit' ? 'flex' : 'none' }}>
          {doc === null
            ? <div className="empty">…</div>
            : (
              <CodeMirror
                ref={cmRef}
                value={text}
                onChange={(next) => { setText(next) }}
                extensions={extensions}
                theme={appearance}
                height="100%"
                basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, highlightSelectionMatches: true }}
              />
            )}
        </div>
        {mode === 'wysiwyg' && (
          <WysiwygEditor
            key={doc?.path ?? 'new'}
            initial={text}
            onChange={(next) => { setText(next) }}
            scrollSignal={scrollSignal}
          />
        )}
        {mode === 'preview' && (
          <div className="preview-pane single" ref={previewRef}>
            <div className="md-body">
              <MarkdownPreviewBody source={text} />
            </div>
          </div>
        )}
        {outlineVisible && (
          <nav className="outline" aria-label={t('outline.title')}>
            <h3>{t('outline.title')}</h3>
            {outlineItems.length === 0
              ? <div className="empty" style={{ position: 'static', padding: '4px 8px' }}>{t('outline.empty')}</div>
              : outlineItems.map((item, index) => (
              <button
                key={`${item.line}-${index}`}
                type="button"
                style={{ '--depth': item.level - 1 } as React.CSSProperties}
                title={item.text}
                onClick={() => { jumpTo(item.line, item.text) }}
              >
                {item.text === '' ? `H${item.level}` : item.text}
              </button>
            ))}
          </nav>
        )}
      </div>

      <div className="statusbar">
        <span>{t('status.words', { count: stats.words })}</span>
        <span>{t('status.chars', { count: stats.chars })}</span>
        <span>{t('status.lines', { count: stats.lines })}</span>
        <span>{t('status.readMinutes', { count: stats.readMinutes })}</span>
        <span className="spacer" />
        <span>{t('status.cursor', { line: cursor.line, col: cursor.col })}</span>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (container !== null) createRoot(container).render(<App />)
