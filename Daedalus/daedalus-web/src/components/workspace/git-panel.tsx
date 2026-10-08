import { useEffect, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Panel } from '../common/panel'
import { api } from '../../api/client'
import type { WorkspaceGitStatus } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'

const STATUS_TONE: Record<WorkspaceGitStatus['files'][number]['status'], 'success' | 'warning' | 'info' | 'error' | 'neutral'> = {
  added: 'success',
  modified: 'warning',
  untracked: 'info',
  deleted: 'error',
  renamed: 'info',
  changed: 'warning',
}

/**
 * Worktree state for the open workspace, from the server's read of the
 * user's own git: branch + every changed file, with a per-file revert
 * to HEAD. Reverting asks first (it discards uncommitted edits), and
 * untracked files get no button — the server refuses them rather than
 * deleting a file the agent created. Hidden entirely outside a repo.
 */
export function GitPanel() {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null)
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const value = await api.gitStatus(root)
        if (!cancelled) setStatus(value)
      } catch {
        if (!cancelled) setStatus(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, revision])

  if (!root || !status?.isRepo) return null

  const revert = async (path: string): Promise<void> => {
    try {
      await api.gitRevert(root, path)
      setNote(`reverted ${path} to HEAD`)
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setConfirmPath(null)
      bumpWorkspaceRevision()
    }
  }

  return (
    <Panel
      title="git"
      data-testid="git-panel"
      action={
        <>
          {status.branch ? <Badge tone="primary">{status.branch}</Badge> : null}
          <Badge tone="neutral">{status.files.length} changed</Badge>
        </>
      }
      bodyClassName="flex flex-col gap-1"
    >
      {status.files.length === 0 ? (
        <p className="text-[11px] text-muted">working tree clean</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {status.files.map((file) => (
            <li key={file.path} className="flex items-center gap-1.5 text-[11px]" data-testid="git-file" data-status={file.status}>
              <Badge tone={STATUS_TONE[file.status]}>{file.status}</Badge>
              <span className="min-w-0 flex-1 truncate text-foreground">{file.path}</span>
              {file.status !== 'untracked' ? (
                confirmPath === file.path ? (
                  <span className="flex items-center gap-1">
                    <span className="text-[10px] text-warning">discard edits?</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => void revert(file.path)} aria-label={`confirm revert ${file.path}`}>
                      revert
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmPath(null)} aria-label={`cancel revert ${file.path}`}>
                      keep
                    </Button>
                  </span>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirmPath(file.path)} aria-label={`revert ${file.path}`}>
                    revert
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {note ? (
        <p className="text-[10px] text-muted" data-testid="git-note">
          {note}
        </p>
      ) : null}
    </Panel>
  )
}
