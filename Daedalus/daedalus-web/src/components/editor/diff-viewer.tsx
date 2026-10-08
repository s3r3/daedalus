import { useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { EmptyState, Panel } from '../common/panel'
import { useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { fileChanges } from '../../state/selectors'
import type { FileChange } from '../../api/types'

/**
 * Diff viewer: added/removed lines per file, derived from FILE_CHANGED events.
 * Lines animate in once and then stay static (§3.4 rule 5). The selected
 * file can also be opened in the editor from here (the old Files Changed
 * panel's one unique action, kept when that panel was removed as a
 * duplicate of this list).
 */
export function DiffViewer() {
  const events = useTaskEvents()
  const changes = useMemo(() => fileChanges(events), [events])
  const [selected, setSelected] = useState<string | null>(null)
  const root = useDaedalusStore((state) => state.workspace.root)
  const setWorkspace = useDaedalusStore((state) => state.setWorkspace)
  const setOpenFile = useDaedalusStore((state) => state.setOpenFile)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [openError, setOpenError] = useState<string | null>(null)
  const [revertNote, setRevertNote] = useState<string | null>(null)

  const revertChangedFile = async (path: string): Promise<void> => {
    if (!root) return
    try {
      await api.gitRevert(root, path)
      setRevertNote(`reverted ${path} to HEAD — the diff above stays as the task record`)
    } catch (error) {
      setRevertNote(error instanceof Error ? error.message : String(error))
    }
    bumpWorkspaceRevision()
  }

  const openChangedFile = async (path: string): Promise<void> => {
    if (!root) {
      setOpenError('Choose a workspace before opening a changed file.')
      return
    }
    setOpenError(null)
    setWorkspace({ path, loading: true, error: null })
    setOpenFile(path)
    try {
      const file = await api.file(root, path)
      setWorkspace({ content: file.content ?? '', size: file.size, loading: false, kind: file.kind ?? 'text', imageSrc: file.src ?? null, mediaType: file.mediaType ?? null })
    } catch (error) {
      setWorkspace({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

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

      {openError ? (
        <p role="alert" className="text-[11px] text-error">
          {openError}
        </p>
      ) : null}

      {revertNote ? (
        <p className="text-[10px] text-muted" data-testid="diff-revert-note">
          {revertNote}
        </p>
      ) : null}

      {active ? (
        <FileDiff
          key={active.path}
          change={active}
          onOpen={(path) => void openChangedFile(path)}
          onRevert={active.operation !== 'created' ? (path) => void revertChangedFile(path) : undefined}
        />
      ) : null}
    </Panel>
  )
}

export function FileDiff({ change, onOpen, onRevert }: { change: FileChange; onOpen?: (path: string) => void; onRevert?: (path: string) => void }) {
  const [revertArmed, setRevertArmed] = useState(false)
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="diff-body">
      <div className="flex items-center gap-2 py-1 text-[10px] text-muted">
        <Badge tone={change.operation === 'created' ? 'success' : 'warning'}>{change.operation}</Badge>
        <span>{change.path}</span>
        {onOpen ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpen(change.path)}
            aria-label={`open changed file ${change.path}`}
          >
            open in editor
          </Button>
        ) : null}
        {onRevert ? (
          revertArmed ? (
            <span className="flex items-center gap-1">
              <span className="text-warning">discard edits?</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRevertArmed(false)
                  onRevert(change.path)
                }}
                aria-label={`confirm revert changed file ${change.path}`}
              >
                revert
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRevertArmed(false)} aria-label={`cancel revert changed file ${change.path}`}>
                keep
              </Button>
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setRevertArmed(true)} aria-label={`revert changed file ${change.path}`}>
              revert
            </Button>
          )
        ) : null}
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