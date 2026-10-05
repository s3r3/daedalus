import { useEffect, useMemo, useRef } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Badge } from '../ui/badge'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { chatTranscript, pendingApprovals, taskStatus, type ChatEntry } from '../../state/selectors'
import { STATUS_TONE, type Tone } from './status-tone'

/**
 * The conversation, chat-style: your prompt, the model's thoughts and replies,
 * tool calls with their short results, and status lines — the same recorded
 * event log the CLI prints, rendered next to Diff/Attachments so a running
 * task reads like a conversation instead of a raw timeline. Facts come from
 * `chatTranscript()`; this panel owns only scroll behaviour.
 */
export function ChatPanel() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const thinking = useDaedalusStore((state) => state.composer.thinking)
  const entries = useMemo(() => chatTranscript(events, thinking), [events, thinking])
  const pending = useMemo(() => pendingApprovals(events), [events])
  const status = taskStatus(events, pending.length)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // A newly selected task starts pinned to its newest entry.
  useEffect(() => {
    pinnedRef.current = true
  }, [taskId])

  // Follow the tail only while the reader is at the bottom; scrolling up to
  // re-read history is never yanked back by incoming events.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [entries, status])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <Panel
      title="chat"
      data-testid="chat-panel"
      className="shrink-0"
      bodyClassName="min-h-0"
      action={
        <span className="flex items-center gap-1">
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
        <div ref={scrollRef} onScroll={onScroll} className="max-h-[320px] overflow-y-auto pr-1" data-testid="chat-scroll">
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
      )}

      {pending.length > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 border-t border-line pt-2 text-[11px] text-warning" data-testid="chat-approval-pending">
          <ShieldAlert className="mt-[1px] size-3.5 shrink-0" />
          <span>
            waiting for approval: {pending[0]?.key.tool} [{pending[0]?.key.action}]
            {pending[0]?.key.path ? ` ${pending[0].key.path}` : ''} — approve or deny it in the approval card.
          </span>
        </p>
      ) : null}
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
