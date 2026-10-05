import { useMemo } from 'react'
import { Badge } from '../ui/badge'
import { ScrollArea } from '../ui/scroll-area'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { activity, toolCalls } from '../../state/selectors'
import { KIND_TONE, toneForResult } from './status-tone'

const KIND_LABEL: Record<string, string> = {
  thought: 'thought',
  action: 'action',
  observation: 'observation',
  plan: 'plan',
  validation: 'validation',
  recovery: 'recovery',
  approval: 'approval',
  file: 'file',
  completion: 'task',
  error: 'error',
  system: 'system',
  attachment: 'attach',
  orchestration: 'child',
}

/**
 * Agent activity: thought → action → observation, plus tool call/result views.
 * Rows come straight from the event log; the newest event is auto-scrolled into
 * view unless the user has scrolled away from the tail.
 */
export function ActivityTimeline() {
  const events = useTaskEvents()
  const thinking = useDaedalusStore((state) => state.composer.thinking)
  const entries = useMemo(() => activity(events, thinking), [events, thinking])
  const calls = useMemo(() => toolCalls(events), [events])

  return (
    <Panel
      title="activity"
      data-testid="activity-panel"
      action={<Badge tone="neutral">{entries.length}</Badge>}
      bodyClassName="min-h-0"
    >
      {entries.length === 0 ? (
        <EmptyState title="No activity yet" hint="Every model thought, tool call, and observation is recorded here." />
      ) : (
        <ScrollArea className="h-full max-h-[320px]">
          <ol className="flex flex-col gap-0.5" data-testid="activity-entries">
            {entries.map((entry) => (
              <li
                key={`${entry.seq}-${entry.kind}`}
                className={`flex items-start gap-1.5 rounded px-1.5 py-1 text-[11px] ${
                  entry.status === 'running' ? 'motion-tool-pulse motion-tool-shimmer' : ''
                }`}
                data-testid="activity-entry"
                data-kind={entry.kind}
              >
                <span className="w-[52px] shrink-0 text-right text-[9px] uppercase tracking-wider text-muted">{KIND_LABEL[entry.kind]}</span>
                <span className="mt-[1px]">
                  {entry.status === 'running' ? (
                    <Spinner label={`${entry.title} running`} />
                  ) : (
                    <Badge tone={KIND_TONE[entry.kind] ?? 'neutral'}>{entry.title.slice(0, 22)}</Badge>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{entry.title}</span>
                  {entry.detail ? <span className="block truncate text-[10px] text-muted">{entry.detail}</span> : null}
                </span>
                {entry.status && entry.status !== 'running' && entry.status !== 'info' ? (
                  <Badge tone={toneForResult(entry.status)}>{entry.status}</Badge>
                ) : null}
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}

      {calls.length > 0 ? <ToolCallList calls={calls} /> : null}
    </Panel>
  )
}

/** Tool calls and their results, with expandable output. */
function ToolCallList({ calls }: { calls: ReturnType<typeof toolCalls> }) {
  return (
    <div className="mt-2 border-t border-line pt-2" data-testid="tool-calls">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">tool calls</p>
      <ul className="flex flex-col gap-1">
        {calls.map((view) => {
          const status = view.result?.status ?? 'running'
          return (
            <li key={view.call.id} className="rounded border border-line px-1.5 py-1 text-[11px]" data-testid="tool-call" data-tool={view.call.tool}>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-foreground">{view.call.tool}</span>
                {status === 'running' ? <Spinner label={`${view.call.tool} running`} /> : <Badge tone={toneForResult(status)}>{status}</Badge>}
                <span className="ml-auto text-[9px] text-muted">#{view.startedSeq}</span>
              </div>
              {view.call.args && Object.keys(view.call.args as object).length > 0 ? (
                <pre className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted">
                  {JSON.stringify(view.call.args)}
                </pre>
              ) : null}
              {view.result ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted">
                    output{view.result.truncated ? ' (truncated)' : ''}
                  </summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-surface px-1.5 py-1 text-[10px] text-foreground">
                    {view.result.output}
                  </pre>
                </details>
              ) : (
                <p className="mt-1 text-[10px] text-muted">awaiting result…</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
