import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Circle, Moon, Settings, Sun } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { saveActiveConversationId } from '../../state/prefs'
import { latestContextPercent, pendingApprovals, pendingQuestions, taskStatus } from '../../state/selectors'
import { useTaskEvents } from '../../state/hooks'
import { DomainSwitch } from './domain-switch'
import { useTheme } from '../../theme/theme'
import { MODE_LABELS, modeCssVar } from '../../theme/theme'
import { STATUS_TONE } from '../agent/status-tone'

/**
 * Top bar: identity, gateway connection health, task history, theme switch.
 * The connection badge is the honest answer to "is the event stream live?".
 */
export function TopBar() {
  const connection = useDaedalusStore((state) => state.connection)
  const reconnectAttempt = useDaedalusStore((state) => state.reconnectAttempt)
  const tasks = useDaedalusStore((state) => state.tasks)
  const taskId = useDaedalusStore((state) => state.taskId)
  const composer = useDaedalusStore((state) => state.composer)
  const settingsOpen = useDaedalusStore((state) => state.settingsOpen)
  const setSettingsOpen = useDaedalusStore((state) => state.setSettingsOpen)
  const setTasks = useDaedalusStore((state) => state.setTasks)
  const setSession = useDaedalusStore((state) => state.setSession)
  const setComposer = useDaedalusStore((state) => state.setComposer)
  const seedEvents = useDaedalusStore((state) => state.seedEvents)
  const setReport = useDaedalusStore((state) => state.setReport)
  const taskEvents = useTaskEvents()
  const { theme, toggle } = useTheme()
  const [refreshing, setRefreshing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyFilter, setHistoryFilter] = useState('')
  // Anchor for the portaled history dropdown, measured from the wrapper
  // around the history button (see the portal render below for why it
  // cannot simply be absolutely positioned inside this header).
  const historyAnchorRef = useRef<HTMLDivElement>(null)
  const [historyAnchor, setHistoryAnchor] = useState<{ top: number; right: number } | null>(null)
  const updateHistoryAnchor = useCallback((): void => {
    const rect = historyAnchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setHistoryAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
  }, [])
  const toggleHistory = (): void => {
    if (historyOpen) {
      setHistoryOpen(false)
    } else {
      updateHistoryAnchor()
      setHistoryOpen(true)
    }
  }
  const historyTasks = useMemo(() => {
    const needle = historyFilter.trim().toLowerCase()
    if (!needle) return tasks
    return tasks.filter((task) => [task.id, task.title ?? '', task.goal ?? '', task.mode ?? '', task.status].join(' ').toLowerCase().includes(needle))
  }, [tasks, historyFilter])

  // While the history dropdown is open, keep the portal anchored to its
  // button (the layout can shift under it) and close on Escape from
  // anywhere — focus may sit in the filter input or on a task row, so
  // listen on the document rather than only on the panel.
  useEffect(() => {
    if (!historyOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHistoryOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updateHistoryAnchor)
    window.addEventListener('scroll', updateHistoryAnchor, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updateHistoryAnchor)
      window.removeEventListener('scroll', updateHistoryAnchor, true)
    }
  }, [historyOpen, updateHistoryAnchor])

  const status = taskStatus(taskEvents, pendingApprovals(taskEvents).length, pendingQuestions(taskEvents).length)
  const contextPercent = useMemo(() => latestContextPercent(taskEvents), [taskEvents])

  useEffect(() => {
    let cancelled = false
    const loadTasks = (): void => {
      api
        .listTasks()
        .then((response) => {
          if (!cancelled) setTasks(response.tasks)
        })
        .catch(() => undefined)
    }
    loadTasks()
    // CLI-origin tasks are written by another process into the same local
    // store; refreshing the list makes them appear in this picker without a
    // page reload. Selection still loads the full snapshot on demand.
    const timer = setInterval(loadTasks, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [setTasks])

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await api.task(taskId)
        if (cancelled) return
        seedEvents(snapshot.events ?? [])
        setReport(snapshot.report ?? null)
        const running = snapshot.running || snapshot.task?.running === true
        if (running) timer = setTimeout(() => void poll(), 2_000)
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 2_000)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [seedEvents, setReport, taskId])

  const refreshTasks = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const response = await api.listTasks()
      setTasks(response.tasks)
    } catch {
      /* the header stays usable without the task list */
    } finally {
      setRefreshing(false)
    }
  }

  const toggleThinking = async (): Promise<void> => {
    const next = !composer.thinking
    try {
      const response = await api.updateSession({ thinking: next })
      setSession(response.session)
    } catch {
      setComposer({ thinking: next })
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-base px-3 py-2" data-testid="top-bar">
      <div className="flex items-center gap-2">
        <strong className="text-sm tracking-[0.2em] text-primary">DAEDALUS</strong>
        <span className="hidden text-[10px] uppercase tracking-wider text-muted sm:inline">agentic coding framework</span>
      </div>

      <DomainSwitch />

      <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />

      <Badge tone={connectionTone(connection)} data-testid="connection-badge">
        <Circle className="size-2 fill-current" />
        {connection === 'reconnecting' && reconnectAttempt > 0 ? `reconnecting (${reconnectAttempt})` : connection}
      </Badge>

      <Badge tone={STATUS_TONE[status]} data-testid="task-status-badge">
        {status}
      </Badge>

      <span
        className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ borderColor: modeCssVar(composer.mode), color: modeCssVar(composer.mode) }}
        data-testid="topbar-mode-badge"
        data-mode={composer.mode}
        title="Agent mode (Shift+Tab in the composer cycles modes)"
      >
        {MODE_LABELS[composer.mode]}
      </span>

      <span className="hidden max-w-[260px] truncate text-[10px] text-muted xl:inline" data-testid="topbar-model-summary">
        {composer.providerId || composer.model ? `${composer.providerId ? `${composer.providerId}/` : ''}${composer.model || 'default model'}` : 'default provider/model'}
        {composer.autoApprove ? ' · auto-approve' : ''}
        {` · thinking ${composer.thinking ? 'on' : 'off'}`}
      </span>

      <Button
        variant={composer.thinking ? 'default' : 'outline'}
        size="sm"
        onClick={() => void toggleThinking()}
        aria-label="toggle thinking"
        data-testid="topbar-thinking-toggle"
        title="Show or hide provider THOUGHT events in the timeline"
      >
        thinking {composer.thinking ? 'on' : 'off'}
      </Button>

      {typeof contextPercent === 'number' ? (
        <Badge
          tone={contextPercent >= 90 ? 'error' : contextPercent >= 70 ? 'warning' : 'neutral'}
          data-testid="topbar-context-meter"
          title="Estimated context-window usage of the latest model request"
        >
          ctx {contextPercent}%
        </Badge>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="relative" ref={historyAnchorRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleHistory}
            aria-label="task history"
            aria-expanded={historyOpen}
            data-testid="topbar-history-button"
          >
            history{tasks.length ? ` (${tasks.length})` : ''}
          </Button>
          {/* The dropdown renders through a portal into document.body: the
              composer below this header is position:relative with z-30 and,
              while a task runs, carries a transform from its collapse
              animation — both put it in the root stacking contest, where as
              the later DOM node it painted over this absolutely-positioned
              panel no matter the z-index declared inside the header (the
              same stacking-context trap that once hid the composer's own
              model picker). Portaling out of the header sidesteps the
              contest entirely: backdrop and panel sit at z-40, above the
              composer (z-30) and below the settings dialog (z-50), with the
              panel position:fixed and anchored to the button's rect. */}
          {historyOpen && historyAnchor
            ? createPortal(
                <>
                  <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setHistoryOpen(false)} />
                  <div
                    className="fixed z-40 flex max-h-[70vh] w-[340px] max-w-[86vw] flex-col rounded-md border border-line bg-surface p-1.5 shadow-lg"
                    style={{ top: historyAnchor.top, right: historyAnchor.right }}
                    data-testid="task-history"
                  >
                <input
                  aria-label="filter tasks"
                  placeholder="filter by title, goal, or id…"
                  value={historyFilter}
                  onChange={(event) => setHistoryFilter(event.target.value)}
                  className="mb-1 h-7 w-full rounded border border-line bg-surface-base px-1.5 text-[11px] text-foreground"
                />
                {historyTasks.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-muted">{tasks.length === 0 ? 'no tasks recorded yet' : 'no tasks match'}</p>
                ) : (
                  <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
                    {historyTasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          data-testid="history-task"
                          data-task-id={task.id}
                          onClick={() => {
                            setHistoryOpen(false)
                            void selectTask(task.id)
                          }}
                          className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-surface-base ${
                            task.id === taskId ? 'border border-primary' : 'border border-transparent'
                          }`}
                        >
                          <Badge tone={task.running ? 'info' : summaryTone(task.status)}>{task.running ? 'running' : task.status}</Badge>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">{task.title ?? task.goal ?? task.id.slice(0, 8)}</span>
                            <span className="block truncate text-[10px] text-muted">
                              {task.id.slice(0, 8)}
                              {task.mode ? ` · ${task.mode}` : ''}
                              {` · ${task.event_count} events`}
                              {timeAgo(task.updated_at ?? task.created_at) ? ` · ${timeAgo(task.updated_at ?? task.created_at)}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                  </div>
                </>,
                document.body,
              )
            : null}
        </div>

        <Button variant="outline" size="sm" onClick={() => void refreshTasks()} disabled={refreshing} aria-label="refresh tasks">
          refresh
        </Button>

        <Button
          variant={settingsOpen ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-label="toggle settings and providers"
          data-testid="settings-toggle"
        >
          <Settings /> settings
        </Button>

        <Button variant="ghost" size="icon" onClick={toggle} aria-label={`switch to ${theme === 'daedalus-dark' ? 'light' : 'dark'} theme`}>
          {theme === 'daedalus-dark' ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  )
}

async function selectTask(taskId: string): Promise<void> {
  const store = useDaedalusStore.getState()
  store.setTask(taskId)
  try {
    const [snapshot, attachments] = await Promise.allSettled([api.task(taskId), api.taskAttachments(taskId)])
    if (snapshot.status === 'fulfilled') {
      store.seedEvents(snapshot.value.events ?? [])
      store.setReport(snapshot.value.report ?? null)
    } else {
      throw snapshot.reason
    }
    if (attachments.status === 'fulfilled') store.setTaskAttachments(attachments.value.attachments)
  } catch (error) {
    store.setError(error instanceof Error ? error.message : String(error))
  }
  // A task created inside a chat conversation opens that conversation, so
  // picking it from the list lands in its session instead of stranding the
  // user on the task's events alone.
  const summary = store.tasks.find((task) => task.id === taskId)
  const conversationId = summary?.conversation_id
  const root = summary?.repo_path ?? store.workspace.root
  if (conversationId && root) {
    try {
      const { conversation } = await api.getConversation(root, conversationId)
      store.setConversation(conversation)
      saveActiveConversationId(root, conversation.id)
    } catch {
      /* the task view alone remains usable */
    }
  }
}

/** Badge tone for a task-summary status word (core state, not the live derived status). */
function summaryTone(status: string): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  if (status === 'done' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'partial' || status === 'stopped') return 'warning'
  if (status === 'running') return 'info'
  return 'neutral'
}

/** "5m ago" style stamp for the history list; empty for unparseable input. */
function timeAgo(ts: string | null | undefined): string {
  if (!ts) return ''
  const then = Date.parse(ts)
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function connectionTone(connection: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (connection === 'open') return 'success'
  if (connection === 'connecting' || connection === 'reconnecting') return 'warning'
  if (connection === 'closed') return 'error'
  return 'neutral'
}