import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowDown, CircleQuestionMark, MessageSquarePlus, ShieldAlert, Square } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { api } from '../../api/client'
import type { ConversationTurn } from '../../api/types'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { CHAT_HEIGHT, loadChatHeight, saveChatHeight, saveActiveConversationId } from '../../state/prefs'
import { approvalId, chatTranscript, pendingApprovals, pendingQuestions, taskStatus, taskUsage, type ChatEntry } from '../../state/selectors'
import { ApprovalCard } from '../approval/approval-card'
import { QuestionCard } from '../approval/question-card'
import { ExecutePlanBar } from './execute-plan-bar'
import { STATUS_TONE, type Tone } from './status-tone'

type ChatRowModel =
  | { kind: 'entry'; entry: ChatEntry }
  | { kind: 'turn'; turn: ConversationTurn; index: number }

/**
 * The conversation, chat-style: your prompt, the model's thoughts and replies,
 * tool calls with their short results, and status lines — the same recorded
 * event log the CLI prints, rendered next to Diff/Attachments so a running
 * task reads like a conversation instead of a raw timeline. Facts come from
 * `chatTranscript()`; this panel owns only scroll behaviour, its (user-sized)
 * height, and the Stop control for the run it is showing.
 *
 * When a chat conversation is active, the panel renders the whole session:
 * recorded turns in order, with the live task's event segment expanded in
 * place of its own two turns (the segment carries the same prompt/replies in
 * full detail). Tasks finished earlier in the session show as their recorded
 * user prompt + Daedalus summary — that compact history is also what the
 * next prompt carries as context.
 */
export function ChatPanel() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const thinking = useDaedalusStore((state) => state.composer.thinking)
  const conversation = useDaedalusStore((state) => state.conversation)
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const setConversation = useDaedalusStore((state) => state.setConversation)
  const setComposer = useDaedalusStore((state) => state.setComposer)
  const entries = useMemo(() => chatTranscript(events, thinking), [events, thinking])
  const pending = useMemo(() => pendingApprovals(events), [events])
  const questions = useMemo(() => pendingQuestions(events), [events])
  const status = taskStatus(events, pending.length, questions.length)
  const usage = useMemo(() => taskUsage(events), [events])
  const running = status === 'running' || status === 'awaiting-approval' || status === 'awaiting-answer'

  const rows = useMemo<ChatRowModel[]>(() => {
    if (!conversation) return entries.map((entry) => ({ kind: 'entry' as const, entry }))
    const out: ChatRowModel[] = []
    let segmentInserted = false
    conversation.turns.forEach((turn, index) => {
      if (turn.task_id && turn.task_id === taskId) {
        if (turn.role === 'user') {
          if (entries.length > 0) {
            for (const entry of entries) out.push({ kind: 'entry', entry })
            segmentInserted = true
          } else {
            // Submitted a moment ago: no events yet, show the prompt itself.
            out.push({ kind: 'turn', turn, index })
          }
        }
        // The active task's assistant turn is rendered by its own segment.
        return
      }
      out.push({ kind: 'turn', turn, index })
    })
    // The selected task predates (or is missing from) the conversation —
    // keep its segment visible after the recorded turns.
    if (taskId && entries.length > 0 && !segmentInserted) {
      for (const entry of entries) out.push({ kind: 'entry', entry })
    }
    return out
  }, [conversation, entries, taskId])

  // When the live task completes, the server records its assistant turn;
  // pull the fresh conversation so the summary joins the session here too.
  const completed = useMemo(() => events.some((event) => event.type === 'TASK_COMPLETED'), [events])
  const conversationId = conversation?.id
  useEffect(() => {
    if (!completed || !conversationId || !workspaceRoot) return
    let cancelled = false
    const timer = setTimeout(() => {
      void api
        .getConversation(workspaceRoot, conversationId)
        .then(({ conversation: fresh }) => {
          if (!cancelled) setConversation(fresh)
        })
        .catch(() => undefined)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [completed, conversationId, workspaceRoot, setConversation])

  // "New chat": a fresh conversation on the server, a clean panel here, and
  // the persisted pointer moved so a reload stays on the new session.
  const startNewChat = async (): Promise<void> => {
    const root = workspaceRoot || conversation?.root
    useDaedalusStore.setState({ taskId: null, events: [], report: null, taskAttachments: [] })
    setComposer({ goal: '', error: null })
    if (!root) {
      setConversation(null)
      return
    }
    try {
      const { conversation: fresh } = await api.createConversation(root)
      setConversation(fresh)
      saveActiveConversationId(root, fresh.id)
    } catch {
      setConversation(null)
      saveActiveConversationId(root, null)
    }
  }

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

  // The pending cards are the transcript's last blocks, so their head ids are
  // scroll dependencies on purpose: a request landing while the reader is
  // pinned scrolls the card itself into view, not just the receipt line.
  const pendingHeadId = pending[0] ? (pending[0].approval?.id ?? approvalId(pending[0].key)) : null
  const questionHeadId = questions[0]?.question.id ?? null
  const waiting = pending.length > 0 || questions.length > 0

  // Follow the tail only while the reader is at the bottom; scrolling up to
  // re-read history is never yanked back by incoming events.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [rows, status, pendingHeadId, questionHeadId])

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void startNewChat()}
            data-testid="new-chat"
            aria-label="start a new chat conversation"
            title="Start a fresh conversation (the previous one stays saved on the server)"
          >
            <MessageSquarePlus />
            new chat
          </Button>
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
          <Badge tone="neutral">{rows.length}</Badge>
          <Badge tone={STATUS_TONE[status]} data-testid="chat-status">
            {status}
          </Badge>
        </span>
      }
    >
      {rows.length === 0 && !waiting ? (
        <EmptyState title="No conversation yet" hint="Run a task to see the conversation here." />
      ) : (
        <div className="relative">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="overflow-y-auto pr-1"
            style={{ height: `${height}px`, maxHeight: 'calc(100vh - 16rem)' }}
            data-testid="chat-scroll"
          >
            <ol className="flex flex-col gap-1.5" data-testid="chat-entries">
              {rows.map((row) =>
                row.kind === 'entry' ? (
                  <ChatRow key={`event-${row.entry.seq}`} entry={row.entry} />
                ) : (
                  <ChatTurnRow key={`turn-${row.index}`} turn={row.turn} />
                ),
              )}
              {status === 'running' ? (
                <li className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-muted" data-testid="chat-working">
                  <Spinner label="agent working" /> agent is working…
                </li>
              ) : null}

              {/* Pending cards are transcript blocks, not panel furniture:
                  they render inside this scroll region as its last items, so
                  the panel keeps its bounded height no matter how tall a card
                  is, and its buttons are always reachable by this scroll. */}
              {pending.length > 0 ? (
                <li data-testid="chat-approval-block">
                  <ApprovalCard />
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning" data-testid="chat-approval-pending">
                    <ShieldAlert className="mt-[1px] size-3.5 shrink-0" />
                    <span>
                      waiting for approval: {pending[0]?.key.tool} [{pending[0]?.key.action}]
                      {pending[0]?.key.path ? ` ${pending[0].key.path}` : ''} — allow or decline it in the card above, or type a
                      reply in the composer to decline with that note.
                    </span>
                  </p>
                </li>
              ) : null}

              {questions.length > 0 ? (
                <li data-testid="chat-question-block">
                  <QuestionCard />
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-info" data-testid="chat-question-pending">
                    <CircleQuestionMark className="mt-[1px] size-3.5 shrink-0" />
                    <span>waiting for your answer — the agent resumes as soon as you answer above.</span>
                  </p>
                </li>
              ) : null}
            </ol>
          </div>

          {!pinned && waiting ? (
            <button
              type="button"
              onClick={jumpToLatest}
              data-testid="chat-waiting-chip"
              className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full border border-warning bg-warning/20 px-2 py-1 text-[10px] font-semibold text-foreground shadow hover:border-warning"
            >
              <ArrowDown className="size-3" /> {pending.length > 0 ? 'waiting for approval' : 'waiting for your answer'} — jump to the
              card
            </button>
          ) : !pinned ? (
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

      {usage.requests > 0 ? (
        <p className="mt-2 border-t border-line pt-1.5 font-mono text-[10px] text-muted" data-testid="chat-token-usage">
          {usage.reported > 0
            ? `tokens ${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out · ${formatCount(usage.totalTokens)} total · ${usage.requests} request${usage.requests === 1 ? '' : 's'}${usage.reported < usage.requests ? ` (usage reported for ${usage.reported} of ${usage.requests})` : ''}`
            : `${usage.requests} model request${usage.requests === 1 ? '' : 's'} · token usage not reported by the provider`}
        </p>
      ) : null}


      <ExecutePlanBar />
    </Panel>
  )
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** A recorded conversation turn (finished task or fast-path exchange in this session). */
function ChatTurnRow({ turn }: { turn: ConversationTurn }) {
  if (turn.role === 'user') {
    return (
      <li className="rounded bg-surface px-2 py-1.5" data-testid="chat-entry" data-role="user" data-turn="recorded">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-primary">you</span>
        <p className="whitespace-pre-wrap break-words text-[11px] text-foreground">{turn.text}</p>
      </li>
    )
  }
  return (
    <li className="px-1 py-0.5" data-testid="chat-entry" data-role="assistant" data-turn="recorded">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted">daedalus</span>
      <p className="whitespace-pre-wrap break-words text-[11px] text-foreground">{turn.text}</p>
    </li>
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
