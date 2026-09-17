/**
 * 画布 —— 跑在主窗口的 `ncw-plugin://acme.excalidraw` iframe 里。
 *
 * ## 它和宿主之间只有三句话
 *
 * ```
 * ──ncw:doc:ready──▶   我起来了,把文件给我
 * ◀──ncw:doc:open───   给你:{ path, data }
 * ──ncw:doc:save───▶   存这份:{ data }
 * ```
 *
 * ★ **报文里没有路径。** 写哪个文件由宿主按 Tab 绑定决定(见
 * `shell/PluginViewFrame.tsx` 的文档通道)。这不是省事,是这条通道的
 * 能力上界:画布是第三方代码,它说不出「写 ../../.ssh/id_rsa」这句话。
 *
 * ## 为什么自己管保存节流
 *
 * Excalidraw 的 `onChange` 在拖动期间每帧都触发。原样转发等于每帧一次写盘,
 * 而每次写盘都要过一遍主进程的路径校验与乐观锁。这里攒 800ms 再存一次;
 * 真正要紧的那次(关 Tab)由宿主的脏状态挽留兜底。
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'

/** 攒够这么久没有新改动才落盘。 */
const SAVE_DEBOUNCE_MS = 800

interface Scene {
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

function parseScene(raw: string): Scene {
  try {
    const parsed = JSON.parse(raw) as Partial<Scene>
    return {
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      /*
        ★ `collaborators` 必须**丢掉**。Excalidraw 存盘时会把它写成一个对象,
        而运行期它要的是 Map —— 原样塞回去会在第一次渲染就抛
        「collaborators.forEach is not a function」,而堆栈里一个字都不提文件。
      */
      appState: stripRuntimeOnly(parsed.appState),
      files: typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {}
    }
  } catch {
    // 文件坏了不等于要清空它:给一张空画布,但**不主动保存** ——
    // 用户还有机会去恢复那份文件。
    return { elements: [], appState: {}, files: {} }
  }
}

function stripRuntimeOnly(appState: unknown): Record<string, unknown> {
  if (typeof appState !== 'object' || appState === null) return {}
  const { collaborators: _collaborators, ...rest } = appState as Record<string, unknown>
  return rest
}

function App(): React.ReactElement {
  const [scene, setScene] = useState<Scene | null>(null)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const timerRef = useRef<number | null>(null)
  /** 上一次存下去的内容。用来判断「真的变了吗」—— 见 save()。 */
  const savedRef = useRef<string>('')

  // 宿主 → 画布
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; data?: string }
      if (data?.type !== 'ncw:doc:open') return
      const raw = typeof data.data === 'string' ? data.data : ''
      savedRef.current = raw
      setScene(parseScene(raw))
    }
    window.addEventListener('message', onMessage)
    // ★ 监听**先挂**再报 ready:反过来的话,宿主回得够快就会丢掉那一条。
    window.parent.postMessage({ type: 'ncw:doc:ready' }, '*')
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  const save = useCallback(() => {
    const api = apiRef.current
    if (api === null) return
    const next = JSON.stringify(
      {
        type: 'excalidraw',
        version: 2,
        source: 'nextcowork-plugin:acme.excalidraw',
        elements: api.getSceneElements(),
        appState: stripRuntimeOnly(api.getAppState()),
        files: api.getFiles()
      },
      null,
      2
    )
    /*
      ★ 内容没变就不写。`onChange` 连选中、平移、缩放都会触发,
      不比一次的话,用户只是看了看图,文件的 mtime 就变了 ——
      而那会让 Agent 那边误判「这个文件刚被改过」。
    */
    if (next === savedRef.current) return
    savedRef.current = next
    window.parent.postMessage({ type: 'ncw:doc:save', data: next }, '*')
  }, [])

  const onChange = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(save, SAVE_DEBOUNCE_MS)
  }, [save])

  /*
    关窗之前把攒着的那次落下去。
    ★ 用 `pagehide` 而不是 `beforeunload`:iframe 里的 `beforeunload`
    在很多情况下根本不触发,而 `pagehide` 会。
  */
  useEffect(() => {
    const flush = (): void => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      save()
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [save])

  // 文件还没到 —— 给一张空白底,不给 spinner:它一闪而过反而更像卡住了。
  if (scene === null) return <div className="ncw-loading" />

  return (
    <Excalidraw
      excalidrawAPI={(api) => { apiRef.current = api }}
      initialData={{ elements: scene.elements as never, appState: scene.appState as never, files: scene.files as never, scrollToContent: true }}
      onChange={onChange}
      // 宿主已经有自己的标题栏与菜单,这里关掉 Excalidraw 自带的那一套多余入口
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true } }}
      langCode={document.documentElement.lang === 'en' ? 'en' : 'zh-CN'}
    />
  )
}

const container = document.getElementById('root')
if (container !== null) createRoot(container).render(<StrictMode><App /></StrictMode>)