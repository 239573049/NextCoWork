import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Workspace } from '../../../../shared/domain/workspace'
import {
  createTerminal,
  getTerminalBuffer,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  writeTerminal
} from '../../services/terminal'
import type { InnerTab } from '../../../../shared/domain/tab'

const LIGHT_THEME = {
  background: '#faf9f5',
  foreground: '#2d332f',
  cursor: '#2d4739',
  cursorAccent: '#faf9f5',
  selectionBackground: '#d9e3dd',
  black: '#202522',
  red: '#b33f31',
  green: '#2d6d4a',
  yellow: '#8b6d2d',
  blue: '#3b6895',
  magenta: '#805b86',
  cyan: '#2f7580',
  white: '#f7f7f3',
  brightBlack: '#69716c',
  brightRed: '#c95846',
  brightGreen: '#3e9163',
  brightYellow: '#aa8841',
  brightBlue: '#5d86b5',
  brightMagenta: '#a278aa',
  brightCyan: '#58a1a8',
  brightWhite: '#ffffff'
}

const DARK_THEME = {
  ...LIGHT_THEME,
  background: '#1e2020',
  foreground: '#ececec',
  cursor: '#36d285',
  cursorAccent: '#1e2020',
  selectionBackground: '#3c5146',
  black: '#111312',
  white: '#e6e9e7',
  brightWhite: '#ffffff'
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

export function TerminalView({ tab, workspace }: { tab: Extract<InnerTab, { kind: 'terminal' }>; workspace: Workspace }): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'starting' | 'connected' | 'exited' | 'error'>('starting')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 5000,
      theme: isDarkTheme() ? DARK_THEME : LIGHT_THEME
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    xtermRef.current = terminal
    fitRef.current = fit

    const fitAndResize = (): void => {
      if (cancelled) return
      try {
        fit.fit()
        if (terminal.cols > 0 && terminal.rows > 0) resizeTerminal(tab.ref.terminalId, terminal.cols, terminal.rows)
      } catch {
        // xterm can be measured while its panel is animating from 0px; the next observer tick retries.
      }
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    requestAnimationFrame(fitAndResize)

    let hydrated = false
    let lastSeq = 0
    const queued: Array<{ seq: number; chunk: string }> = []
    const offData = onTerminalData(({ id, seq, chunk }) => {
      if (id !== tab.ref.terminalId || cancelled || seq <= lastSeq) return
      if (!hydrated) {
        queued.push({ seq, chunk })
        return
      }
      lastSeq = seq
      terminal.write(chunk)
    })
    const offExit = onTerminalExit(({ id, code }) => {
      if (id !== tab.ref.terminalId || cancelled) return
      setStatus('exited')
      terminal.write(`\r\n\x1b[90m[终端已退出，退出码 ${code}]\x1b[0m\r\n`)
    })
    const dataDisposable = terminal.onData((data) => writeTerminal(tab.ref.terminalId, data))

    void (async () => {
      try {
        const info = await createTerminal({
          workspaceId: workspace.id,
          id: tab.ref.terminalId,
          cwd: workspace.rootPath,
          cols: terminal.cols || 100,
          rows: terminal.rows || 28
        })
        if (cancelled) return
        const buffer = await getTerminalBuffer(info.id)
        if (cancelled) return
        if (buffer.data.length > 0) terminal.write(buffer.data)
        lastSeq = buffer.seq
        hydrated = true
        for (const item of queued.sort((a, b) => a.seq - b.seq)) {
          if (item.seq <= lastSeq) continue
          lastSeq = item.seq
          terminal.write(item.chunk)
        }
        queued.length = 0
        setStatus(info.alive ? 'connected' : 'exited')
        fitAndResize()
      } catch (error) {
        if (cancelled) return
        setStatus('error')
        terminal.write(`\x1b[31m无法连接终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
      }
    })()

    return () => {
      cancelled = true
      observer.disconnect()
      offData()
      offExit()
      dataDisposable.dispose()
      terminal.dispose()
      xtermRef.current = null
      fitRef.current = null
    }
  }, [tab.ref.terminalId, workspace.id, workspace.rootPath])

  return (
    <div className="terminal-surface flex min-h-0 flex-1 flex-col" data-terminal-status={status}>
      <div ref={hostRef} className="terminal-host min-h-0 flex-1 px-3 py-2" />
    </div>
  )
}
