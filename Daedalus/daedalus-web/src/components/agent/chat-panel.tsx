import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowDown, CircleQuestionMark, ShieldAlert, Square } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { api } from '../../api/client'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { CHAT_HEIGHT, loadChatHeight, saveChatHeight } from '../../state/prefs'
import { chatTranscript, pendingApprovals, pendingQuestions, taskStatus, type ChatEntry } from '../../state/selectors'
import { ApprovalCard } from '../approval/approval-card'
import { QuestionCard } from '../approval/question-card'
import { ExecutePlanBar } from './execute-plan-bar'
import { STATUS_TONE, type Tone } from './status-tone'

/**
 * The conversation, chat-style: your prompt, the model's thoughts and replies,
 * tool calls with their short results, and status lines — the same recorded
 * event log the CLI prints, rendered next to Diff/Attachments so a running
 * task reads like a conversation instead of a raw timeline. Facts come from
 * `chatTranscript()`; this panel owns only scroll behaviour, its (user-sized)
 * height, and the Stop control for the run it is showing.
 */
export function ChatPanel() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const thinking = useDaedalusStore((state) => state.composer.thinking)
  const entries = useMemo(() => chatTranscript(events, thinking), [events, thinking])
  const pending = useMemo(() => pendingApprovals(events), [events])
  const questions = useMemo(() => pendingQuestions(events), [events])
  const status = taskStatus(events, pending.length, questions.length)
  const running = status === 'running' || status === 'awaiting-approval' || status === 'awaiting-answer'

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)
  const [stopping, setStopping] = useState(false)

  // The panel's height is the user's, not the content's: dragged once,
  // persisted, restored. The column below simply flows underneath.
  const [height, setHeight] = useState<number>(() => loadChatHeight())
  const heightRef = useRef(height)
  heightRef.current = height

  // A newly selected task starts pinned to its newest entry.
  useEffect(() => {
    pinnedRef.current = true
    setPinned(true)
  }, [taskId])

  // A fresh run (or a finished one) clears any stale "stopping…" label.
  useEffect(() => {
    if (!running) setStopping(false)
  }, [running, taskId])

  // Follow the tail only while the reader is at the bottom; scrolling up to
  // re-read history is never yanked back by incoming events.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [entries, status])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinnedRef.current = atBottom
    setPinned(atBottom)
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }

  const stop = async (): Promise<void> => {
    if (!taskId || stopping) return
    setStopping(true)
    try {
      await api.cancelTask(taskId)
      // The terminal TASK_COMPLETED lands within one poll cycle and flips
      // `running` off, which clears this label via the effect above.
    } catch {
      setStopping(false)
    }
  }

  const clampHeight = (value: number): number => Math.min(CHAT_HEIGHT.max, Math.max(CHAT_HEIGHT.min, Math.round(value)))

  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    const onMove = (move: globalThis.PointerEvent): void => {
      setHeight(clampHeight(startHeight + move.clientY - startY))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      saveChatHeight(heightRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let next: number | undefined
    if (event.key === 'ArrowDown') next = heightRef.current + step
    else if (event.key === 'ArrowUp') next = heightRef.current - step
    else if (event.key === 'Home') next = CHAT_HEIGHT.min
    else if (event.key === 'End') next = CHAT_HEIGHT.max
    if (next === undefined) return
    event.preventDefault()
    const clamped = clampHeight(next)
    setHeight(clamped)
    saveChatHeight(clamped)
  }

  return (
    <Panel
      title="chat"
      data-testid="chat-panel"
      className="shrink-0"
      bodyClassName="min-h-0"
      action={
        <span className="flex items-center gap-1">
          {running && taskId ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void stop()}
              disabled={stopping}
              data-testid="chat-stop"
              aria-label={`stop task ${taskId}`}
            >
              <Square className="fill-current" />
              {stopping ? 'stopping…' : 'stop'}
            </Button>
          ) : null}
          <Badge tone="neutral">{entries.length}</Badge>
          <Badge tone={STATUS_TONE[status]} data-testid="chat-status">
            {status}
          </Badge>
        </span>
      }
    >
      {!taskId || entries.length === 0 ? (
        <EmptyState title="No conversation yet" hint="Run a task to see the conversation here." />
      ) : (
        <div className="relative">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="overflow-y-auto pr-1"
            style={{ height: `${height}px` }}
            data-testid="chat-scroll"
          >
            <ol className="flex flex-col gap-1.5" data-testid="chat-entries">
              {entries.map((entry) => (
                <ChatRow key={entry.seq} entry={entry} />
              ))}
              {status === 'running' ? (
                <li className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-muted" data-testid="chat-working">
                  <Spinner label="agent working" /> agent is working…
                </li>
              ) : null}
            </ol>
          </div>

          {!pinned ? (
            <button
              type="button"
              onClick={jumpToLatest}
              data-testid="chat-jump-latest"
              className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-[10px] font-semibold text-foreground shadow hover:border-primary"
            >
              <ArrowDown className="size-3" /> jump to latest
            </button>
          ) : null}

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="resize chat panel"
            aria-valuemin={CHAT_HEIGHT.min}
            aria-valuemax={CHAT_HEIGHT.max}
            aria-valuenow={height}
            tabIndex={0}
            data-testid="chat-resize-handle"
            onPointerDown={startResize}
            onKeyDown={onResizeKeyDown}
            className="group flex h-3 cursor-ns-resize touch-none items-center justify-center border-t border-transparent hover:border-line focus:border-primary focus:outline-none"
            title="Drag to resize the chat panel (arrow keys work too)"
          >
            <span className="h-0.5 w-10 rounded bg-line group-hover:bg-primary" />
          </div>
        </div>
      )}

      {pending.length > 0 ? (
        <div className="mt-2 border-t border-line pt-2">
          <ApprovalCard />
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning" data-testid="chat-approval-pending">
            <ShieldAlert className="mt-[1px] size-3.5 shrink-0" />
            <span>
              waiting for approval: {pending[0]?.key.tool} [{pending[0]?.key.action}]
              {pending[0]?.key.path ? ` ${pending[0].key.path}` : ''} — allow or decline it in the card above, or type a
              reply in the composer to decline with that note.
            </span>
          </p>
        </div>
      ) : null}

      {questions.length > 0 ? (
        <div className="mt-2 border-t border-line pt-2">
          <QuestionCard />
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-info" data-testid="chat-question-pending">
            <CircleQuestionMark className="mt-[1px] size-3.5 shrink-0" />
            <span>waiting for your answer — the agent resumes as soon as you answer above.</span>
          </p>
        </div>
      ) : null}

      <ExecutePlanBar />
    </Panel>
  )
}

function ChatRow({ entry }: { entry: ChatEntry }) {
  switch (entry.role) {
    case 'user':
      return (
        <li className="rounded bg-surface px-2 py-1.5" data-testid="chat-entry" data-role="user">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-primary">you</span>
          <p className="whitespace-pre-wrap break-words text-[11px] text-foreground">{entry.text}</p>
        </li>
      )
    case 'assistant':
      return (
        <li className="px-1 py-0.5" data-testid="chat-entry" data-role="assistant">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-muted">daedalus</span>
          <p className="whitespace-pre-wrap break-words text-[11px] text-foreground">{entry.text}</p>
        </li>
      )
    case 'thought':
      return (
        <li className="px-1 py-0.5" data-testid="chat-entry" data-role="thought">
          {entry.text.length > 280 ? (
            <details>
              <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-wider text-muted">thinking</summary>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] italic text-muted">{entry.text}</p>
            </details>
          ) : (
            <>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted">thinking</span>
              <p className="whitespace-pre-wrap break-words text-[11px] italic text-muted">{entry.text}</p>
            </>
          )}
        </li>
      )
    case 'tool':
      return (
        <li className="rounded border border-line px-2 py-1.5" data-testid="chat-entry" data-role="tool" data-tool={entry.tool}>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-foreground">{entry.tool}</span>
            {entry.status === 'running' ? (
              <Spinner label={`${entry.tool} running`} />
            ) : (
              <Badge tone={toneForChatStatus(entry.status)}>{entry.status ?? 'done'}</Badge>
            )}
          </div>
          {entry.text ? <p className="mt-0.5 break-words font-mono text-[10px] text-muted">{entry.text}</p> : null}
          {entry.detail ? (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-surface px-1.5 py-1 text-[10px] text-foreground">
              {entry.detail}
            </pre>
          ) : entry.status === 'running' ? (
            <p className="mt-0.5 text-[10px] text-muted">awaiting result…</p>
          ) : null}
        </li>
      )
    case 'approval':
      return (
        <li className="flex items-start gap-1.5 rounded border border-warning/50 bg-warning/10 px-2 py-1.5" data-testid="chat-entry" data-role="approval">
          <ShieldAlert className="mt-[1px] size-3.5 shrink-0 text-warning" />
          <span className="min-w-0">
            <span className="block break-words text-[11px] text-foreground">{entry.text}</span>
            {entry.detail ? <span className="block text-[10px] text-muted">{entry.detail}</span> : null}
          </span>
        </li>
      )
    default:
      return (
        <li className="flex items-center justify-center gap-1.5 px-1 py-0.5 text-center" data-testid="chat-entry" data-role="status">
          <Badge tone={toneForChatStatus(entry.status)}>{entry.text}</Badge>
          {entry.detail ? <span className="min-w-0 truncate text-[10px] text-muted">{entry.detail}</span> : null}
        </li>
      )
  }
}

function toneForChatStatus(status: ChatEntry['status']): Tone {
  switch (status) {
    case 'ok':
      return 'success'
    case 'error':
      return 'error'
    case 'warning':
    case 'denied':
    case 'timeout':
      return 'warning'
    case 'running':
    case 'info':
      return 'info'
    default:
      return 'neutral'
  }
}
