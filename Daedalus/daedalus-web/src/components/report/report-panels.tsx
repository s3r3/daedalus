import { useMemo, useState } from 'react'
import type { FinalReport } from '@daedalus/core'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, Panel } from '../common/panel'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { attachmentsFromEvents, childTasks, outcomeOf, reportFromEvents } from '../../state/selectors'
import { ToolResultImage } from '../agent/tool-result-image'
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
  child_tasks: 'subagent tasks',
  child_tasks_done: 'subagents done',
  child_tasks_failed: 'subagents failed',
  model_requests: 'model requests',
  tokens_input: 'tokens in',
  tokens_output: 'tokens out',
  tokens_total: 'tokens total',
  token_requests_reported: 'requests reporting usage',
  checks_passed: 'checks passed',
  checks_failed: 'checks failed',
  compressed_outputs: 'outputs compressed',
  output_chars_before_compression: 'output chars before compression',
  output_chars_after_compression: 'output chars after compression',
  duration_ms: 'duration (ms)',
}

/** Attachments recorded for the active task, from ATTACHMENT_ADDED events or the task attachment endpoint. */
export function AttachmentsPanel() {
  const events = useTaskEvents()
  const fetched = useDaedalusStore((state) => state.taskAttachments)
  const attachments = useMemo(() => {
    const merged = new Map<string, ReturnType<typeof attachmentsFromEvents>[number]>()
    for (const attachment of [...attachmentsFromEvents(events), ...fetched]) merged.set(attachment.id, attachment)
    return [...merged.values()]
  }, [events, fetched])

  // Rendered only when the task actually has attachments: an always-on
  // "No attachments" box is decoration, not information.
  if (attachments.length === 0) return null

  return (
    <Panel title="attachments" data-testid="attachments-panel" action={<Badge tone="neutral">{attachments.length}</Badge>} bodyClassName="flex flex-col gap-1">
        <ul className="flex flex-col gap-0.5">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-1.5 text-[11px]" data-testid="attachment-entry" data-kind={attachment.kind}>
              {attachment.kind === 'image' && attachment.workspacePath ? <ToolResultImage path={attachment.workspacePath} thumb /> : null}
              <Badge tone={attachment.kind === 'image' ? 'info' : 'neutral'}>{attachment.kind}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{attachment.name}</span>
                <span className="block truncate text-[10px] text-muted">{attachment.workspacePath}</span>
              </span>
              <span className="text-[10px] text-muted">{attachment.size} B</span>
            </li>
          ))}
        </ul>
    </Panel>
  )
}

/** Child tasks the agent delegated to via the spawn_subagent tool, from child-task events. */
export function ChildTasksPanel() {
  const events = useTaskEvents()
  const children = useMemo(() => childTasks(events), [events])

  // Rendered only when the agent actually delegated: an always-on
  // "No child tasks" box is decoration, not information.
  if (children.length === 0) return null

  return (
    <Panel title="child tasks" data-testid="child-tasks-panel" action={<Badge tone="neutral">{children.length}</Badge>} bodyClassName="flex flex-col gap-1">
        <ul className="flex flex-col gap-0.5">
          {children.map((child) => (
            <li key={child.id} className="rounded border border-line px-1.5 py-1 text-[11px]" data-testid="child-task-entry" data-status={child.status}>
              <div className="flex items-center gap-1.5">
                <Badge tone={child.status === 'done' ? 'success' : child.status === 'failed' ? 'error' : child.status === 'running' ? 'info' : 'neutral'}>{child.status}</Badge>
                <span className="truncate text-foreground">{child.label ?? child.goal}</span>
              </div>
              {child.result_summary ? <p className="mt-0.5 text-[10px] text-muted">{child.result_summary}</p> : null}
              {typeof child.usage?.total_tokens === 'number' ? (
                <p className="text-[10px] text-muted" data-testid="child-task-usage">
                  tokens {child.usage.total_tokens} total
                  {typeof child.usage.input_tokens === 'number' ? ` (${child.usage.input_tokens} in · ${child.usage.output_tokens ?? 0} out)` : ''} · {child.usage.requests}{' '}
                  requests
                </p>
              ) : null}
              {child.budget ? (
                <p className="text-[10px] text-muted">
                  budget: {child.budget.max_iterations} iterations / {child.budget.max_errors} errors
                </p>
              ) : null}
            </li>
          ))}
        </ul>
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