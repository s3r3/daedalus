import { useMemo, useState } from 'react'
import type { FinalReport } from '@daedalus/core'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { outcomeOf, reportFromEvents, validation } from '../../state/selectors'
import { STATUS_TONE, type TaskStatus } from '../agent/status-tone'

const METRIC_LABELS: Record<string, string> = {
  turns: 'turns',
  tool_calls: 'tool calls',
  events: 'events',
  commands: 'commands',
  files_changed: 'files changed',
  recoveries: 'recoveries',
  replans: 'replans',
  approvals: 'approvals',
  checks_passed: 'checks passed',
  checks_failed: 'checks failed',
  duration_ms: 'duration (ms)',
}

/** Files changed across the task, derived from FILE_CHANGED events. */
export function FilesChangedPanel() {
  const events = useTaskEvents()
  const changes = useMemo(
    () =>
      events.flatMap((event) =>
        event.type === 'FILE_CHANGED'
          ? [
              {
                path: (event.payload as { path: string }).path,
                operation: (event.payload as { operation: string }).operation,
                added: (event.payload as { added: number }).added,
                removed: (event.payload as { removed: number }).removed,
              },
            ]
          : [],
      ),
    [events],
  )
  const unique = [...new Map(changes.map((change) => [change.path, change])).values()]

  return (
    <Panel title="files changed" data-testid="files-changed-panel" action={<Badge tone="neutral">{unique.length}</Badge>} bodyClassName="flex flex-col gap-1">
      {unique.length === 0 ? (
        <EmptyState title="No files changed" hint="Files the agent writes are listed here with add/remove counts." />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {unique.map((change) => (
            <li key={change.path} className="flex items-center gap-1.5 text-[11px]" data-testid="files-changed-entry">
              <Badge tone={change.operation === 'created' ? 'success' : 'warning'}>{change.operation}</Badge>
              <span className="truncate text-foreground">{change.path}</span>
              <span className="ml-auto text-[10px]">
                <span className="text-success">+{change.added}</span> <span className="text-error">-{change.removed}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Validation summary: the checks that produced the verdict. */
export function ValidationSummary() {
  const events = useTaskEvents()
  const { result } = useMemo(() => validation(events), [events])

  return (
    <Panel title="validation summary" data-testid="validation-summary-panel" bodyClassName="flex flex-col gap-1">
      {!result ? (
        <EmptyState title="No validation evidence" hint="The final report lists every check with its command and verdict." />
      ) : (
        <ul className="flex flex-col gap-0.5 text-[11px]">
          {result.checks.map((check) => (
            <li key={check.name} className="flex items-center gap-1.5" data-testid="validation-summary-check">
              <Badge tone={check.status === 'pass' ? 'success' : check.status === 'fail' ? 'error' : 'neutral'}>{check.status}</Badge>
              <span className="text-foreground">{check.name}</span>
              <span className="truncate text-[10px] text-muted">{check.cmd}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * Final report: outcome, evidence, and metrics. The diff body expands once the
 * task completes (§3.4 "task complete → report card expands to reveal the diff").
 */
export function FinalReportView({ report }: { report: FinalReport | null }) {
  const events = useTaskEvents()
  const taskId = useActiveTaskId() ?? 'task'
  const derived = useMemo(() => reportFromEvents(taskId, events, report), [events, report, taskId])
  const outcome = outcomeOf(events)
  const [showDiff, setShowDiff] = useState(false)

  if (!derived) {
    return (
      <Panel title="final report" data-testid="final-report-panel">
        <EmptyState title="No report yet" hint="A report is produced when the task completes, with evidence and metrics." />
      </Panel>
    )
  }

  const status: TaskStatus = derived.outcome === 'success' ? 'done' : derived.outcome === 'partial' ? 'partial' : 'failed'
  const patch = derived.diff

  return (
    <Panel
      title="final report"
      data-testid="final-report-panel"
      action={<Badge tone={STATUS_TONE[status]}>{derived.outcome}</Badge>}
      bodyClassName="flex flex-col gap-2"
    >
      <div className="motion-report-expand flex flex-col gap-1 text-[11px]">
        {outcome ? <p className="text-muted">reason: {outcome.reason}</p> : null}

        <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5" data-testid="report-metrics">
          {Object.entries(derived.metrics).map(([key, value]) => (
            <li key={key} className="flex justify-between gap-2 border-b border-line/60 py-0.5" data-testid="report-metric" data-metric={key}>
              <span className="text-muted">{METRIC_LABELS[key] ?? key}</span>
              <span className="text-foreground">{value}</span>
            </li>
          ))}
        </ul>

        {derived.evidence.length > 0 ? (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted">evidence</p>
            <ul className="flex flex-col gap-0.5" data-testid="report-evidence">
              {derived.evidence.map((item) => (
                <li key={item} className="truncate text-[10px] text-foreground">
                  • {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {patch.length > 0 ? (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setShowDiff((value) => !value)} data-testid="report-diff-toggle">
            {showDiff ? 'hide diff' : `show diff (${derived.metrics.files_changed ?? 0} files)`}
          </Button>
        ) : null}

        {showDiff && patch.length > 0 ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface p-2 text-[10px] text-foreground" data-testid="report-diff">
            {patch}
          </pre>
        ) : null}
      </div>
    </Panel>
  )
}