import { useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { useTaskEvents } from '../../state/hooks'
import { errors, recoveries, replanCount, type ErrorEntry } from '../../state/selectors'

/**
 * Recovery + error surfaces: RECOVERY_STARTED attempts, REPLAN_CREATED
 * revisions, and the classified errors (model / tool / validation / task).
 */
export function RecoveryPanel() {
  const events = useTaskEvents()
  const attempts = useMemo(() => recoveries(events), [events])
  const replans = useMemo(() => replanCount(events), [events])

  return (
    <Panel
      title="recovery"
      data-testid="recovery-panel"
      action={
        <Badge tone={attempts.length + replans > 0 ? 'warning' : 'neutral'} data-testid="recovery-count">
          {attempts.length} retries · {replans} replans
        </Badge>
      }
      bodyClassName="flex flex-col gap-1.5"
    >
      {attempts.length === 0 && replans === 0 ? (
        <EmptyState title="No recovery needed" hint="Retries and replans appear here when the agent hits a failure." />
      ) : (
        <>
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
        </>
      )}
    </Panel>
  )
}

export function ErrorPanel() {
  const events = useTaskEvents()
  const entries = useMemo(() => errors(events), [events])
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <Panel
      title="errors"
      data-testid="error-panel"
      action={<Badge tone={entries.length > 0 ? 'error' : 'neutral'}>{entries.length}</Badge>}
      bodyClassName="flex flex-col gap-1"
    >
      {entries.length === 0 ? (
        <EmptyState title="No errors recorded" hint="Model failures, tool errors, and failed checks are listed here." />
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <ErrorRow key={`${entry.seq}-${entry.type}`} entry={entry} expanded={expanded === entry.seq} onToggle={() => setExpanded(expanded === entry.seq ? null : entry.seq)} />
          ))}
        </ul>
      )}
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