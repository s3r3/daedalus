import { useEffect, useState } from 'react'
import { Circle, Moon, Sun } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { pendingApprovals, taskStatus } from '../../state/selectors'
import { useTaskEvents } from '../../state/hooks'
import { useTheme } from '../../theme/theme'
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
  const setTasks = useDaedalusStore((state) => state.setTasks)
  const taskEvents = useTaskEvents()
  const { theme, toggle } = useTheme()
  const [refreshing, setRefreshing] = useState(false)

  const status = taskStatus(taskEvents, pendingApprovals(taskEvents).length)

  useEffect(() => {
    let cancelled = false
    api
      .listTasks()
      .then((response) => {
        if (!cancelled) setTasks(response.tasks)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [setTasks, taskId])

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
                {task.id.slice(0, 8)} · {task.goal ?? task.status}
              </option>
            ))}
          </select>
        </label>

        <Button variant="outline" size="sm" onClick={() => void refreshTasks()} disabled={refreshing} aria-label="refresh tasks">
          refresh
        </Button>

        {taskId ? (
          <Button variant="ghost" size="sm" onClick={() => void cancelTask()}>
            cancel
          </Button>
        ) : null}

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
    const snapshot = await api.task(taskId)
    store.seedEvents(snapshot.events ?? [])
    store.setReport(snapshot.report ?? null)
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