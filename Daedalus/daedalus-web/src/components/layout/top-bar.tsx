import { useEffect, useMemo, useState } from 'react'
import { Circle, Moon, Settings, Sun } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { latestContextPercent, pendingApprovals, pendingQuestions, taskStatus } from '../../state/selectors'
import { useTaskEvents } from '../../state/hooks'
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

  const cancelTask = async (): Promise<void> => {
    if (!taskId) return
    try {
      await api.cancelTask(taskId)
    } catch {
      /* cancellation is best effort; the stream reports the outcome */
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
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
          <span className="hidden sm:inline">task</span>
          <select
            aria-label="select task"
            className="h-7 max-w-[220px] rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={taskId ?? ''}
            onChange={(event) => {
              if (event.target.value !== '') void selectTask(event.target.value)
            }}
          >
            <option value="">new task…</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.id.slice(0, 8)} · {task.mode ? `${task.mode} · ` : ''}{task.title ?? task.goal ?? task.status}
              </option>
            ))}
          </select>
        </label>

        <Button variant="outline" size="sm" onClick={() => void refreshTasks()} disabled={refreshing} aria-label="refresh tasks">
          refresh
        </Button>

        {taskId && (status === 'running' || status === 'awaiting-approval' || status === 'awaiting-answer') ? (
          <Button variant="danger" size="sm" onClick={() => void cancelTask()} data-testid="topbar-stop" aria-label="stop the running task">
            ■ stop
          </Button>
        ) : null}

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
}

function connectionTone(connection: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (connection === 'open') return 'success'
  if (connection === 'connecting' || connection === 'reconnecting') return 'warning'
  if (connection === 'closed') return 'error'
  return 'neutral'
}