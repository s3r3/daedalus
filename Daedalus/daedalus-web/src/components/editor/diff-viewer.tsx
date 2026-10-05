import { useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import { EmptyState, Panel } from '../common/panel'
import { useTaskEvents } from '../../state/hooks'
import { fileChanges } from '../../state/selectors'
import type { FileChange } from '../../api/types'

/**
 * Diff viewer: added/removed lines per file, derived from FILE_CHANGED events.
 * Lines animate in once and then stay static (§3.4 rule 5).
 */
export function DiffViewer() {
  const events = useTaskEvents()
  const changes = useMemo(() => fileChanges(events), [events])
  const [selected, setSelected] = useState<string | null>(null)

  if (changes.length === 0) {
    return (
      <Panel title="diff" data-testid="diff-panel">
        <EmptyState title="No file changes yet" hint="Every file the agent writes appears here as a live diff." />
      </Panel>
    )
  }

  const active = changes.find((change) => change.path === selected) ?? changes[0]

  return (
    <Panel
      title="diff"
      data-testid="diff-panel"
      action={<Badge tone="primary">{changes.length} files</Badge>}
      bodyClassName="flex min-h-0 flex-col gap-2"
    >
      <ul className="flex flex-wrap gap-1" data-testid="diff-files">
        {changes.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              onClick={() => setSelected(change.path)}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                change.path === active?.path ? 'border-primary text-primary' : 'border-line text-muted'
              }`}
              data-testid="diff-file"
            >
              {change.path} <span className="text-success">+{change.added}</span>{' '}
              <span className="text-error">-{change.removed}</span>
            </button>
          </li>
        ))}
      </ul>

      {active ? <FileDiff change={active} /> : null}
    </Panel>
  )
}

export function FileDiff({ change }: { change: FileChange }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="diff-body">
      <div className="flex items-center gap-2 py-1 text-[10px] text-muted">
        <Badge tone={change.operation === 'created' ? 'success' : 'warning'}>{change.operation}</Badge>
        <span>{change.path}</span>
        <span className="ml-auto">
          +{change.added} / -{change.removed}
        </span>
      </div>
      <pre className="rounded border border-line bg-surface p-1.5 text-[10px] leading-4">
        {change.lines.map((line, index) => (
          <span
            key={`${index}-${line.kind}`}
            className={`motion-diff-line block whitespace-pre-wrap break-words ${
              line.kind === 'add' ? 'bg-success/15 text-success' : line.kind === 'remove' ? 'bg-error/15 text-error' : 'text-muted'
            }`}
            data-diff-kind={line.kind}
          >
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            {line.text}
          </span>
        ))}
      </pre>
    </div>
  )
}