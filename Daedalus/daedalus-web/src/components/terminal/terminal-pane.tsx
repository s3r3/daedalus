import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Plus, RotateCcw, Square, X } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { commands, type CommandView } from '../../state/selectors'
import { TERMINAL_HEIGHT, loadTerminalHeight, saveTerminalHeight } from '../../state/prefs'
import { terminalTheme, type ITheme } from '../../theme/terminal-theme'
import { api } from '../../api/client'
import type { TerminalSession } from '../../api/types'

/**
 * Terminal surface (PLAN.md §3.6): a tab strip over server-side sessions.
 * The `agent` tab is the read-only harness log it has always been (the
 * agent owns its processes; COMMAND_* from the active task render here).
 * `user` tabs are the human's own interactive shells: they keep running
 * (a dev server stays up) until the human closes the tab; the agent can
 * never write into, signal, or kill one. Height is the user's: dragged by
 * the handle on the top edge, persisted, double-click resets.
 */
export function TerminalPane() {
  const events = useTaskEvents()
  const views = useMemo(() => commands(events), [events])
  const running = views.filter((view) => view.status === 'running')
  const last = views.at(-1)

  const root = useDaedalusStore((state) => state.workspace.root)
  const sessions = useDaedalusStore((state) => state.terminals.sessions)
  const activeId = useDaedalusStore((state) => state.terminals.activeId)
  const buffers = useDaedalusStore((state) => state.terminals.buffers)
  const subscribe = useDaedalusStore((state) => state.terminals.subscribe)
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0]

  const [height, setHeight] = useState<number>(() => loadTerminalHeight())
  const heightRef = useRef(height)
  heightRef.current = height
  const historiesRef = useRef(new Map<string, { lines: string[]; cursor: number }>())

  // Session list for this workspace (the server ensures the agent sink).
  useEffect(() => {
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const response = await api.terminals(root)
        if (!cancelled) useDaedalusStore.getState().setTerminalSessions(response.terminals)
      } catch {
        /* gateway unreachable: the tab strip simply stays empty */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root])

  // Reopening a tab replays its buffered history over the socket.
  useEffect(() => {
    if (active?.id) subscribe?.(active.id)
  }, [active?.id, subscribe])

  const createUserSession = async (): Promise<void> => {
    if (!root) return
    try {
      const { terminal } = await api.createTerminal({ root })
      const store = useDaedalusStore.getState()
      store.upsertTerminalSession(terminal)
      store.setActiveTerminal(terminal.id)
    } catch {
      /* surfaced by the empty strip; nothing else to do */
    }
  }

  const closeSession = async (session: TerminalSession): Promise<void> => {
    try {
      await api.deleteTerminal(session.id)
    } catch {
      /* already gone server-side; drop it locally too */
    }
    useDaedalusStore.getState().removeTerminalSession(session.id)
  }

  const restartSession = async (session: TerminalSession): Promise<void> => {
    await closeSession(session)
    await createUserSession()
  }

  const clampHeight = (value: number): number => Math.min(TERMINAL_HEIGHT.max, Math.max(TERMINAL_HEIGHT.min, Math.round(value)))

  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    const onMove = (move: globalThis.PointerEvent): void => {
      // The handle is on the pane's top edge: dragging up grows it.
      setHeight(clampHeight(startHeight + startY - move.clientY))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      saveTerminalHeight(heightRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let next: number | undefined
    if (event.key === 'ArrowUp') next = heightRef.current + step
    else if (event.key === 'ArrowDown') next = heightRef.current - step
    else if (event.key === 'Home') next = TERMINAL_HEIGHT.min
    else if (event.key === 'End') next = TERMINAL_HEIGHT.max
    if (next === undefined) return
    event.preventDefault()
    const clamped = clampHeight(next)
    setHeight(clamped)
    saveTerminalHeight(clamped)
  }

  const resetHeight = (): void => {
    setHeight(TERMINAL_HEIGHT.default)
    saveTerminalHeight(TERMINAL_HEIGHT.default)
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="resize terminal panel"
        aria-valuemin={TERMINAL_HEIGHT.min}
        aria-valuemax={TERMINAL_HEIGHT.max}
        aria-valuenow={height}
        tabIndex={0}
        data-testid="terminal-resize-handle"
        onPointerDown={startResize}
        onDoubleClick={resetHeight}
        onKeyDown={onResizeKeyDown}
        className="group flex h-2 shrink-0 cursor-ns-resize touch-none items-center justify-center rounded hover:bg-primary/20 focus:bg-primary/20 focus:outline-none"
        title="Drag to resize the terminal panel (double-click resets, arrow keys work too)"
      >
        <span className="h-0.5 w-10 rounded bg-line group-hover:bg-primary" />
      </div>
      <Panel
        title="terminal"
        data-testid="terminal-panel"
        action={
          active?.kind === 'user' ? (
            active.status === 'running' ? (
              <Badge tone="info" data-testid="terminal-running">
                <Spinner label="process running" /> running
              </Badge>
            ) : (
              <Badge tone="error" data-testid="terminal-exit">
                exit {active.exitCode ?? 'n/a'}
              </Badge>
            )
          ) : running.length > 0 ? (
            <Badge tone="info" data-testid="terminal-running">
              <Spinner label="process running" /> {running.length} running
            </Badge>
          ) : last ? (
            <Badge tone={last.status === 'ok' ? 'success' : 'error'} data-testid="terminal-exit">
              exit {last.exitCode ?? 'n/a'}
            </Badge>
          ) : (
            <Badge tone="neutral">idle</Badge>
          )
        }
        className="shrink-0"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
        style={{ height: `${height}px` }}
      >
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="terminal sessions" data-testid="terminal-tabs">
          {sessions.map((session) => (
            <span
              key={session.id}
              className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                active?.id === session.id ? 'border-primary text-foreground' : 'border-line text-muted'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active?.id === session.id}
                data-testid="terminal-tab"
                data-kind={session.kind}
                data-session-id={session.id}
                className="flex items-center gap-1.5"
                onClick={() => useDaedalusStore.getState().setActiveTerminal(session.id)}
              >
                {session.title}
                {session.kind === 'agent' ? <Badge tone="info">agent</Badge> : null}
                {session.status === 'exited' ? <Badge tone="error">exit {session.exitCode ?? '?'}</Badge> : null}
              </button>
              {session.kind === 'user' ? (
                <button
                  type="button"
                  aria-label={`close ${session.title}`}
                  data-testid="terminal-close"
                  data-session-id={session.id}
                  className="rounded p-0.5 hover:bg-surface"
                  onClick={() => void closeSession(session)}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
          <button
            type="button"
            aria-label="new terminal"
            data-testid="terminal-new"
            className="flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-primary hover:text-foreground"
            onClick={() => void createUserSession()}
          >
            <Plus className="size-3" /> new
          </button>
        </div>

        {active?.kind === 'user' ? (
          <UserTerminal
            key={active.id}
            session={active}
            buffer={buffers[active.id] ?? ''}
            histories={historiesRef.current}
            onRestart={(session) => void restartSession(session)}
          />
        ) : views.length === 0 ? (
          <EmptyState title="No commands yet" hint="Process output streams here as the harness runs commands." />
        ) : (
          <>
            <ProcessStatus running={running.length} lastExitCode={last?.exitCode ?? null} lastStatus={last?.status ?? null} />
            <CommandStream views={views} />
          </>
        )}
      </Panel>
    </>
  )
}

/**
 * One interactive user shell: streamed output plus an input line. The
 * server echoes submitted lines into the transcript; ↑/↓ walk this
 * session's own history. Ctrl+C is a button (the input keeps real Ctrl+C
 * for copy) and sends SIGINT to the process group.
 */
function UserTerminal({
  session,
  buffer,
  histories,
  onRestart,
}: {
  session: TerminalSession
  buffer: string
  histories: Map<string, { lines: string[]; cursor: number }>
  onRestart: (session: TerminalSession) => void
}) {
  const [draft, setDraft] = useState('')
  const outputRef = useRef<HTMLPreElement>(null)
  const running = session.status === 'running'

  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [buffer])

  const history = (): { lines: string[]; cursor: number } => {
    let entry = histories.get(session.id)
    if (!entry) {
      entry = { lines: [], cursor: 0 }
      histories.set(session.id, entry)
    }
    return entry
  }

  const submit = async (): Promise<void> => {
    const line = draft
    setDraft('')
    const entry = history()
    if (line.trim().length > 0) entry.lines.push(line)
    entry.cursor = entry.lines.length
    try {
      await api.terminalInput(session.id, `${line}\n`)
    } catch {
      /* exited between render and send; the tab badge shows it */
    }
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const entry = history()
      if (entry.lines.length === 0) return
      event.preventDefault()
      entry.cursor = event.key === 'ArrowUp' ? Math.max(0, entry.cursor - 1) : Math.min(entry.lines.length, entry.cursor + 1)
      setDraft(entry.lines[entry.cursor] ?? '')
    }
  }

  const interrupt = async (): Promise<void> => {
    try {
      await api.terminalSignal(session.id, 'SIGINT')
    } catch {
      /* already exited */
    }
  }

  return (
    <>
      <pre
        ref={outputRef}
        data-testid="terminal-user-output"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-base p-2 font-mono text-[11px] text-foreground"
      >
        {buffer}
      </pre>
      {running ? (
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[11px] text-muted">$</span>
          <input
            aria-label={`input for ${session.title}`}
            data-testid="terminal-input"
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 font-mono text-[11px] text-foreground"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="type a command — Enter runs it (e.g. npm run dev)"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="terminal-interrupt"
            aria-label="send Ctrl+C"
            title="Send SIGINT (Ctrl+C)"
            onClick={() => void interrupt()}
          >
            <Square className="fill-current" /> Ctrl+C
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted" data-testid="terminal-exited">
          <span>
            process exited{session.exitCode === null ? '' : ` with code ${session.exitCode}`} — this shell is closed.
          </span>
          <Button type="button" variant="outline" size="sm" data-testid="terminal-restart" onClick={() => onRestart(session)}>
            <RotateCcw /> restart
          </Button>
        </div>
      )}
    </>
  )
}

export function ProcessStatus({
  running,
  lastExitCode,
  lastStatus,
}: {
  running: number
  lastExitCode: number | null
  lastStatus: string | null
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider text-muted" data-testid="process-status">
      {running > 0 ? (
        <span className="flex items-center gap-1 text-info">
          <Spinner label="process running" /> running ({running})
        </span>
      ) : (
        <span>process idle</span>
      )}
      <span className="ml-auto">
        last exit: <span className="text-foreground">{lastExitCode ?? '—'}</span>
        {lastStatus ? <span className="ml-1">({lastStatus})</span> : null}
      </span>
    </div>
  )
}

type TerminalHandle = {
  write: (data: string) => void
  dispose: () => void
  options: { theme?: ITheme }
}

/**
 * Streams COMMAND_OUTPUT into an xterm.js terminal. xterm is lazy-loaded and
 * the pane degrades to the accessible text log below when it cannot mount.
 */
function CommandStream({ views }: { views: CommandView[] }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalHandle | null>(null)
  const writtenRef = useRef<Record<string, number>>({})
  const [ready, setReady] = useState(0)
  const theme = useDaedalusStore((state) => state.theme)

  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        await import('@xterm/xterm/css/xterm.css')
        if (disposed || !hostRef.current) return
        const terminal = new Terminal({
          convertEol: true,
          disableStdin: true,
          cursorBlink: false,
          fontSize: 11,
          scrollback: 5000,
          theme: terminalTheme(),
        })
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(host)
        fit.fit()
        terminalRef.current = terminal
        setReady((value) => value + 1)
      } catch {
        host.setAttribute('data-xterm', 'unavailable')
      }
    })()

    return () => {
      disposed = true
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) terminal.options.theme = terminalTheme()
  }, [theme, ready])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    for (const view of views) {
      const written = writtenRef.current[view.callId] ?? 0
      if (view.output.length <= written && view.command.length > 0 && written > 0) continue
      if (written === 0) terminal.write(`$ ${view.command}\r\n`)
      const chunk = view.output.slice(written)
      if (chunk.length > 0) terminal.write(chunk.replace(/\n/g, '\r\n'))
      writtenRef.current[view.callId] = view.output.length
      if (view.finishedAt !== undefined && writtenRef.current[`${view.callId}:exit`] !== 1) {
        terminal.write(`\r\n[exit ${view.exitCode ?? view.status}]\r\n`)
        writtenRef.current[`${view.callId}:exit`] = 1
      }
    }
  }, [views, ready])

  return (
    <>
      <div
        ref={hostRef}
        data-testid="terminal-surface"
        className="min-h-0 flex-1 overflow-hidden rounded border border-line bg-surface-base p-1 text-foreground"
      />
      <output className="sr-only" data-testid="terminal-log">
        {views.map((view) => `${view.command}\n${view.output}\n[exit ${view.exitCode ?? 'running'}]`).join('\n')}
      </output>
    </>
  )
}
