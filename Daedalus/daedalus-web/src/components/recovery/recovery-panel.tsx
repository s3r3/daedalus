import { useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Panel } from '../common/panel'
import { useTaskEvents } from '../../state/hooks'
import { errors, recoveries, replanCount, type ErrorEntry } from '../../state/selectors'

/**
 * Failure surface: the task's classified errors (model / tool /
 * validation / task), RECOVERY_STARTED attempts, and the REPLAN_CREATED
 * count — one failed task is one state, not two panels.
 *
 * Rendered only when errors were recorded or a recovery/replan actually
 * happened: an always-on "no failures" box is decoration, not
 * information. The error entries stay expandable, exactly as before.
 */
export function FailurePanel() {
  const events = useTaskEvents()
  const entries = useMemo(() => errors(events), [events])
  const attempts = useMemo(() => recoveries(events), [events])
  const replans = useMemo(() => replanCount(events), [events])
  const [expanded, setExpanded] = useState<number | null>(null)

  if (entries.length === 0 && attempts.length === 0 && replans === 0) return null

  return (
    <Panel
      title="failure"
      data-testid="failure-panel"
      action={
        <Badge tone="error" data-testid="failure-count">
          {entries.length} errors · {attempts.length} retries · {replans} replans
        </Badge>
      }
      bodyClassName="flex flex-col gap-1.5"
    >
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="failure-errors">
          {entries.map((entry) => (
            <ErrorRow
              key={`${entry.seq}-${entry.type}`}
              entry={entry}
              expanded={expanded === entry.seq}
              onToggle={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
            />
          ))}
        </ul>
      ) : null}

      {attempts.map((attempt, index) => (
        <div
          key={`${attempt.reason}-${index}`}
          data-testid="recovery-attempt"
          className="motion-retry-enter rounded border border-line px-1.5 py-1 text-[11px]"
        >
          <div className="flex items-center gap-1.5">
            <Badge tone="warning">{attempt.strategy}</Badge>
            <span className="text-foreground">{attempt.reason}</span>
            <span className="ml-auto text-[10px] text-muted">attempt {attempt.attempt}</span>
          </div>
        </div>
      ))}
      {replans > 0 ? (
        <p className="text-[10px] text-muted" data-testid="replan-indicator">
          plan revised {replans}× (REPLAN_CREATED)
        </p>
      ) : null}
    </Panel>
  )
}

function ErrorRow({ entry, expanded, onToggle }: { entry: ErrorEntry; expanded: boolean; onToggle: () => void }) {
  return (
    <li className="rounded border border-line px-1.5 py-1 text-[11px]" data-testid="error-entry" data-error-type={entry.type}>
      <div className="flex items-center gap-1.5">
        <Badge tone="error">{entry.type}</Badge>
        <span className="min-w-0 flex-1 truncate text-foreground">{entry.message}</span>
        <Button variant="ghost" size="sm" onClick={onToggle} aria-label={`toggle details for error ${entry.seq}`}>
          {expanded ? 'hide' : 'detail'}
        </Button>
      </div>
      {expanded ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-[10px] text-muted">
          seq {entry.seq} · {entry.ts}
          {entry.context ? `\n${entry.context}` : ''}
        </p>
      ) : null}
    </li>
  )
}
