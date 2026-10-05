import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '../ui/badge'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { commands, type CommandView } from '../../state/selectors'
import { terminalTheme, type ITheme } from '../../theme/terminal-theme'

/**
 * Terminal surface (PLAN.md §3.6): streamed COMMAND_OUTPUT plus the process
 * status from COMMAND_STARTED / COMMAND_FINISHED. The agent owns the process;
 * this pane is a read-only log of what the harness ran.
 */
export function TerminalPane() {
  const events = useTaskEvents()
  const views = useMemo(() => commands(events), [events])
  const running = views.filter((view) => view.status === 'running')
  const last = views.at(-1)

  return (
    <Panel
      title="terminal"
      data-testid="terminal-panel"
      action={
        running.length > 0 ? (
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
      className="min-h-[180px] shrink-0"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
    >
      {views.length === 0 ? (
        <EmptyState title="No commands yet" hint="Process output streams here as the harness runs commands." />
      ) : (
        <>
          <ProcessStatus running={running.length} lastExitCode={last?.exitCode ?? null} lastStatus={last?.status ?? null} />
          <CommandStream views={views} />
        </>
      )}
    </Panel>
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