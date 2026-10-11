import { useEffect, useMemo, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import type { TaskCheckpoint, WorkspaceGitStatus } from '../../api/types'
import { EmptyState, Panel } from '../common/panel'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { fileChanges } from '../../state/selectors'
import type { FileChange } from '../../api/types'

type GitFileStatus = WorkspaceGitStatus['files'][number]['status']

const STATUS_TONE: Record<GitFileStatus, 'success' | 'warning' | 'info' | 'error' | 'neutral'> = {
  added: 'success',
  modified: 'warning',
  untracked: 'info',
  deleted: 'error',
  renamed: 'info',
  changed: 'warning',
}

/**
 * Changes: the one surface for "what changed" — the task's live diffs
 * (from FILE_CHANGED events) plus the worktree's git state (branch +
 * per-file status, from the server's read of the user's own git).
 *
 * Every control the old GitPanel had lives here now: the branch badge,
 * the changed-file status badges, and the per-file revert to HEAD
 * (two-step — discarding uncommitted edits must never be one stray
 * click; untracked files get no revert, the server refuses them rather
 * than deleting a file the agent created). The git-specific parts stay
 * hidden outside a git repo, exactly like the old panel; the task diff
 * list keeps its own empty state regardless.
 */
export function DiffViewer() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const changes = useMemo(() => fileChanges(events), [events])
  const [selected, setSelected] = useState<string | null>(null)
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const setWorkspace = useDaedalusStore((state) => state.setWorkspace)
  const setOpenFile = useDaedalusStore((state) => state.setOpenFile)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [openError, setOpenError] = useState<string | null>(null)
  const [revertNote, setRevertNote] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null)
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([])
  const [restoreArmed, setRestoreArmed] = useState(false)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)

  useEffect(() => {
    if (!root) {
      setGitStatus(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const value = await api.gitStatus(root)
        if (!cancelled) setGitStatus(value)
      } catch {
        if (!cancelled) setGitStatus(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, revision])

  const inRepo = Boolean(root && gitStatus?.isRepo)
  const gitByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>()
    if (inRepo) for (const file of gitStatus?.files ?? []) map.set(file.path, file.status)
    return map
  }, [gitStatus, inRepo])
  const gitOnly = useMemo(
    () => (inRepo ? (gitStatus?.files ?? []).filter((file) => !changes.some((change) => change.path === file.path)) : []),
    [changes, gitStatus, inRepo],
  )

  // Checkpoints the task recorded before mutating files (the CLI
  // `restore` command's data). Refreshed with the workspace revision so
  // a restore visibly empties the list.
  useEffect(() => {
    if (!taskId) {
      setCheckpoints([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const value = await api.checkpoints(taskId)
        if (!cancelled) setCheckpoints(value.checkpoints)
      } catch {
        if (!cancelled) setCheckpoints([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, revision])

  const restoreCheckpoints = async (): Promise<void> => {
    if (!taskId) return
    try {
      const outcome = await api.restoreTask(taskId, root ?? undefined)
      setRestoreNote(
        `rewound ${outcome.restored.length} file(s) to their pre-task state, deleted ${outcome.deleted.length} task-created file(s)`,
      )
    } catch (error) {
      setRestoreNote(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoreArmed(false)
      setCheckpoints([])
      bumpWorkspaceRevision()
    }
  }

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

  if (changes.length === 0 && gitOnly.length === 0 && checkpoints.length === 0) {
    return (
      <Panel title="changes" data-testid="changes-panel">
        <EmptyState title="No file changes yet" hint="Every file the agent writes appears here as a live diff." />
      </Panel>
    )
  }

  const active = changes.find((change) => change.path === selected) ?? changes[0]

  return (
    <Panel
      title="changes"
      data-testid="changes-panel"
      action={
        <span className="flex items-center gap-1">
          {inRepo && gitStatus?.branch ? <Badge tone="primary">{gitStatus.branch}</Badge> : null}
          <Badge tone="primary">{changes.length} files</Badge>
        </span>
      }
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
              {gitByPath.get(change.path) ? <Badge tone={STATUS_TONE[gitByPath.get(change.path) as GitFileStatus]}>{gitByPath.get(change.path)}</Badge> : null}
              {change.path} <span className="text-success">+{change.added}</span>{' '}
              <span className="text-error">-{change.removed}</span>
            </button>
          </li>
        ))}
      </ul>

      {gitOnly.length > 0 ? (
        <ul className="flex flex-col gap-0.5" data-testid="changes-git-only">
          {gitOnly.map((file) => (
            <GitOnlyRow
              key={file.path}
              path={file.path}
              status={file.status}
              onOpen={() => void openChangedFile(file.path)}
              onRevert={file.status !== 'untracked' ? () => void revertChangedFile(file.path) : undefined}
            />
          ))}
        </ul>
      ) : null}

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

      {checkpoints.length > 0 ? (
        <div className="border-t border-line pt-2" data-testid="changes-checkpoints">
          <div className="mb-1 flex items-center gap-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted">checkpoints</p>
            <Badge tone="neutral">{checkpoints.length}</Badge>
            <span className="ml-auto">
              {restoreArmed ? (
                <span className="flex items-center gap-1">
                  <span className="text-[10px] text-warning">rewind {checkpoints.length} file(s)?</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void restoreCheckpoints()}
                    aria-label="confirm restore task checkpoints"
                  >
                    restore
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRestoreArmed(false)} aria-label="cancel restore task checkpoints">
                    keep
                  </Button>
                </span>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setRestoreArmed(true)} aria-label="restore task checkpoints">
                  restore
                </Button>
              )}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.path} className="flex items-center gap-1.5 text-[11px]" data-testid="checkpoint-file">
                <Badge tone={checkpoint.created ? 'info' : 'neutral'}>{checkpoint.created ? 'created' : 'backed up'}</Badge>
                <span className="min-w-0 flex-1 truncate text-foreground">{checkpoint.path}</span>
              </li>
            ))}
          </ul>
          {restoreNote ? (
            <p className="mt-1 text-[10px] text-muted" data-testid="changes-restore-note">
              {restoreNote}
            </p>
          ) : null}
        </div>
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

/** A worktree-changed file the task never recorded: git status, open, revert — no diff body. */
function GitOnlyRow({
  path,
  status,
  onOpen,
  onRevert,
}: {
  path: string
  status: GitFileStatus
  onOpen: () => void
  onRevert?: () => void
}) {
  const [revertArmed, setRevertArmed] = useState(false)
  return (
    <li className="flex items-center gap-1.5 text-[11px]" data-testid="git-file" data-status={status}>
      <Badge tone={STATUS_TONE[status]}>{status}</Badge>
      <span className="min-w-0 flex-1 truncate text-foreground">{path}</span>
      <Button type="button" variant="outline" size="sm" onClick={onOpen} aria-label={`open changed file ${path}`}>
        open in editor
      </Button>
      {onRevert ? (
        revertArmed ? (
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-warning">discard edits?</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRevertArmed(false)
                onRevert()
              }}
              aria-label={`confirm revert ${path}`}
            >
              revert
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRevertArmed(false)} aria-label={`cancel revert ${path}`}>
              keep
            </Button>
          </span>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setRevertArmed(true)} aria-label={`revert ${path}`}>
            revert
          </Button>
        )
      ) : null}
    </li>
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
