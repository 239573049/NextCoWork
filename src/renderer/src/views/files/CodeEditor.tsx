import CodeMirror, { EditorState, EditorView, Prec, keymap, type Extension } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { editorPhrases } from '../../i18n/editor'
import { useAppearance } from '../../theme/useAppearance'
import { languageForPath } from './editor-language'
import './file-editor.css'

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  path: string
  readOnly?: boolean
  onSave: () => void
}

export function CodeEditor({ value, onChange, path, readOnly = false, onSave }: CodeEditorProps): ReactNode {
  const { t } = useI18n()
  const appearance = useAppearance()
  const save = useRef(onSave)
  const [loaded, setLoaded] = useState<{ path: string; extension: Extension; failed: boolean } | null>(null)

  useEffect(() => { save.current = onSave }, [onSave])

  useEffect(() => {
    let active = true
    const language = languageForPath(path)
    setLoaded(null)
    if (language) {
      void language.load().then((extension) => {
        if (active) setLoaded({ path, extension, failed: false })
      }).catch(() => {
        if (active) setLoaded({ path, extension: [], failed: true })
      })
    }
    return () => { active = false }
  }, [path])

  const extensions = useMemo(() => [
    ...(loaded?.path === path ? [loaded.extension] : []),
    EditorState.phrases.of(editorPhrases(t)),
    EditorView.contentAttributes.of({
      'aria-label': t(readOnly ? 'editor.readOnlyLabel' : 'editor.codeLabel', { path }),
      'aria-multiline': 'true',
      spellcheck: 'false'
    }),
    Prec.highest(keymap.of([{
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        if (!readOnly) save.current()
        return true
      }
    }])),
    EditorView.theme({
      '&': { backgroundColor: 'var(--color-canvas)', color: 'var(--color-fg)', fontSize: '12px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.8' },
      '.cm-content': { padding: '12px 0', caretColor: 'var(--color-fg)' },
      '.cm-line': { padding: '0 16px 0 12px' },
      '.cm-gutters': { backgroundColor: 'var(--color-canvas)', color: 'var(--color-fg-faint)', border: 'none', minWidth: '42px' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--color-tint)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-fg)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--color-tint-strong)' },
      '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--color-surface-raised)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' },
      '.cm-textfield': { background: 'var(--color-surface-field)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' },
      '.cm-button': { background: 'var(--color-tint)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' }
    }, { dark: appearance === 'dark' })
  ], [loaded, path, t, readOnly, appearance])

  const basicSetup = useMemo(() => ({
    lineNumbers: true,
    foldGutter: !readOnly,
    highlightActiveLine: !readOnly,
    highlightActiveLineGutter: !readOnly,
    autocompletion: !readOnly,
    history: !readOnly,
    lintKeymap: false,
    tabSize: 2
  }), [readOnly])

  return (
    <div className="file-code-editor selectable">
      <CodeMirror
        key={path}
        value={value}
        onChange={onChange}
        height="100%"
        theme={appearance}
        extensions={extensions}
        basicSetup={basicSetup}
        readOnly={readOnly}
        editable={!readOnly}
        indentWithTab={!readOnly}
      />
      {loaded?.path === path && loaded.failed && (
        <p className="file-code-editor-warning" role="status">{t('editor.highlightUnavailable')}</p>
      )}
    </div>
  )
}
