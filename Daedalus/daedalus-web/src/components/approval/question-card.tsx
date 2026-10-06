import { useEffect, useState, type KeyboardEvent } from 'react'
import { CircleQuestionMark } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { pendingQuestions } from '../../state/selectors'

/**
 * The agent's question, inline in the chat (Plan mode's ask_user; Claude
 * Code's AskUserQuestion / Cline's ask_followup_question). The card appears
 * from a QUESTION_REQUESTED event and the agent stays blocked until an
 * answer arrives here; QUESTION_ANSWERED lands in the transcript as the
 * receipt. Options answer with one click (or the number keys); the LAST
 * affordance is always "type your own" unless the agent disabled free text.
 */
export function QuestionCard() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const pending = pendingQuestions(events)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [freeOpen, setFreeOpen] = useState(false)
  const [freeText, setFreeText] = useState('')

  const current = pending[0]
  const currentId = current?.question.id

  // Each new question starts with clean card-local state.
  useEffect(() => {
    setBusy(false)
    setFailure(null)
    setFreeOpen(false)
    setFreeText('')
  }, [currentId])

  if (!taskId || !current) return null
  const info = current.question

  const answer = async (text: string): Promise<void> => {
    if (busy || text.trim().length === 0) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await api.answerQuestion(taskId, info.id, text)
      if (!response.success) setFailure('the question expired before the answer arrived')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // Keys typed into the free-text field belong to that field.
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
    const n = Number(event.key)
    if (Number.isInteger(n) && n >= 1 && n <= info.options.length) {
      event.preventDefault()
      const option = info.options[n - 1]
      if (option) void answer(option.label)
    }
  }

  return (
    <section
      role="alertdialog"
      aria-label="question from the agent"
      data-testid="question-card"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="motion-approval-rise rounded-md border-2 border-info bg-info/10 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-info">
        <CircleQuestionMark className="size-4" />
        <strong className="text-xs uppercase tracking-wider">the agent asks</strong>
        {info.mode ? <Badge tone="neutral">{info.mode} mode</Badge> : null}
        {pending.length > 1 ? <Badge tone="warning">+{pending.length - 1} queued</Badge> : null}
      </div>

      <p className="mt-1.5 text-[12px] font-medium text-foreground" data-testid="question-text">
        {info.question}
      </p>

      <div className="mt-2 flex flex-col gap-1.5">
        {info.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            disabled={busy}
            onClick={() => void answer(option.label)}
            data-testid={`question-option-${index}`}
            className="flex items-start gap-2 rounded border border-line bg-surface px-2 py-1.5 text-left hover:border-primary disabled:opacity-60"
          >
            <span className="mt-[1px] flex size-4 shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-semibold text-muted">
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-medium text-foreground">{option.label}</span>
              {option.description ? <span className="block text-[10px] text-muted">{option.description}</span> : null}
            </span>
          </button>
        ))}
      </div>

      {info.allowFreeText ? (
        freeOpen ? (
          <div className="mt-2 flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted" htmlFor="question-free-input">
              your own answer (sent to the agent verbatim)
            </label>
            <textarea
              id="question-free-input"
              data-testid="question-free-input"
              rows={2}
              className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-foreground"
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              placeholder="Type your own answer…"
            />
            <div className="flex gap-2">
              <Button
                variant="success"
                size="sm"
                disabled={busy || freeText.trim().length === 0}
                onClick={() => void answer(freeText.trim())}
                data-testid="question-free-submit"
              >
                send answer
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setFreeOpen(false)}>
                back
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setFreeOpen(true)}
            data-testid="question-free-toggle"
            className="mt-2 text-[11px] font-medium text-info underline-offset-2 hover:underline disabled:opacity-60"
          >
            Type your own answer…
          </button>
        )
      ) : (
        <p className="mt-2 text-[10px] text-muted">This question takes one of the options above — free-text answers are off.</p>
      )}

      {failure ? <p className="mt-1 text-[10px] text-error">{failure}</p> : null}
    </section>
  )
}
