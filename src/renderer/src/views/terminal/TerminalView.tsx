import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Play, ShieldCheck, X } from 'lucide-react'
import type { Workspace } from '../../../../shared/domain/workspace'
import type { TerminalIntent } from '../../../../shared/domain/terminal'
import {
  createTerminal,
  prepareTerminal,
  approveTerminal,
  getTerminalBuffer,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  writeTerminal
} from '../../services/terminal'
import type { InnerTab } from '../../../../shared/domain/tab'
import { Button } from '../../components/ui/Button'
import { useI18n } from '../../i18n'
import { connectionErrorKey } from '../../services/connections'

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
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'starting' | 'connected' | 'exited' | 'error' | 'awaiting-approval' | 'declined'>('starting')
  const [intent, setIntent] = useState<TerminalIntent | null>(null)
  const startRef = useRef<((approval?: string) => Promise<void>) | null>(null)
  const pendingIntent = useRef<TerminalIntent | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let connected = false
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
        if (connected && terminal.cols > 0 && terminal.rows > 0) resizeTerminal(tab.ref.terminalId, terminal.cols, terminal.rows)
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
      connected = false
      setStatus('exited')
      terminal.write(`\r\n\x1b[90m[${t('ssh.terminal.exited', { code })}]\x1b[0m\r\n`)
    })
    const dataDisposable = terminal.onData((data) => { if (connected) writeTerminal(tab.ref.terminalId, data) })

    const hydrateBuffer = async (): Promise<void> => {
      if (hydrated) return
      const buffer = await getTerminalBuffer(tab.ref.terminalId).catch(() => null)
      if (cancelled) return
      if (buffer && buffer.data.length > 0) terminal.write(buffer.data)
      lastSeq = buffer?.seq ?? 0
      hydrated = true
      for (const item of queued.sort((left, right) => left.seq - right.seq)) {
        if (item.seq <= lastSeq) continue
        lastSeq = item.seq
        terminal.write(item.chunk)
      }
      queued.length = 0
    }
    const start = async (approval?: string): Promise<void> => {
      if (cancelled) return
      setStatus('starting')
      try {
        const request = {
          workspaceId: workspace.id,
          id: tab.ref.terminalId,
          cwd: approval ? pendingIntent.current?.cwd ?? workspace.rootPath : workspace.rootPath,
          cols: terminal.cols || 100,
          rows: terminal.rows || 28
        }
        const prepared = approval ? { kind: 'ready' as const, terminal: await createTerminal({ ...request, approval }) } : await prepareTerminal(request)
        if (cancelled) {
          if (prepared.kind === 'approval') void approveTerminal(prepared.intent.id, false).catch(() => {})
          return
        }
        await hydrateBuffer()
        if (cancelled) return
        if (prepared.kind === 'approval') {
          pendingIntent.current = prepared.intent
          setIntent(prepared.intent)
          setStatus('awaiting-approval')
          return
        }
        pendingIntent.current = null
        setIntent(null)
        const info = prepared.terminal
        connected = info.alive
        setStatus(info.alive ? 'connected' : 'exited')
        fitAndResize()
      } catch (error) {
        if (cancelled) return
        connected = false
        await hydrateBuffer()
        setStatus('error')
        terminal.write(`\x1b[31m${t('ssh.terminal.failed', { error: t(connectionErrorKey(error)) })}\x1b[0m\r\n`)
      }
    }
    startRef.current = start
    void start()

    return () => {
      cancelled = true
      startRef.current = null
      if (pendingIntent.current) void approveTerminal(pendingIntent.current.id, false).catch(() => {})
      pendingIntent.current = null
      observer.disconnect()
      offData()
      offExit()
      dataDisposable.dispose()
      terminal.dispose()
      xtermRef.current = null
      fitRef.current = null
    }
  }, [tab.ref.terminalId, workspace.id, workspace.rootPath, t])

  const approve = async (): Promise<void> => {
    if (!intent || status !== 'awaiting-approval') return
    setStatus('starting')
    try {
      const grant = await approveTerminal(intent.id, true)
      if (grant) await startRef.current?.(grant)
    } catch (error) {
      setStatus('error')
      xtermRef.current?.write(`\r\n${t(connectionErrorKey(error))}\r\n`)
    }
  }
  const decline = (): void => {
    if (intent) void approveTerminal(intent.id, false).catch(() => {})
    pendingIntent.current = null
    setIntent(null)
    setStatus('declined')
  }

  return (
    <div className="terminal-surface flex min-h-0 flex-1 flex-col" data-terminal-status={status}>
      {status === 'awaiting-approval' && intent && (
        <div className="shrink-0 border-b border-border px-4 py-3 text-[12px]">
          <div className="mb-2 flex items-center gap-2 text-fg"><ShieldCheck size={15} />{t('ssh.terminal.title')}</div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-fg-muted">
            <dt>{t('ssh.terminal.connection')}</dt><dd className="break-all">{intent.connection}</dd>
            <dt>{t('ssh.terminal.cwd')}</dt><dd className="break-all font-mono">{intent.cwd}</dd>
            <dt>{t('ssh.terminal.shell')}</dt><dd className="break-all font-mono">{intent.shell}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="accent" icon={<ShieldCheck size={13} />} onClick={() => { void approve() }}>{t('ssh.terminal.allow')}</Button>
            <Button size="sm" icon={<X size={13} />} onClick={decline}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}
      {(status === 'error' || status === 'exited' || status === 'declined') && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <Button size="sm" icon={<Play size={13} />} onClick={() => { void startRef.current?.() }}>{t(status === 'declined' ? 'ssh.terminal.request' : 'ssh.terminal.restart')}</Button>
        </div>
      )}
      <div ref={hostRef} className="terminal-host min-h-0 flex-1 px-3 py-2" />
    </div>
  )
}
