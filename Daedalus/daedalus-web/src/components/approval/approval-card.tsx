import { useEffect, useState, type KeyboardEvent } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ApprovalPreview, PermissionKey } from '@daedalus/core'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { approvalId, pendingApprovals } from '../../state/selectors'

/**
 * Human-in-the-loop gate, inline in the chat. The card appears from an
 * APPROVAL_REQUESTED event and the agent stays blocked on the harness until a
 * decision arrives here; APPROVAL_DECIDED lands in the transcript as the
 * receipt and unblocks it. The preview is the exact artifact being approved —
 * verbatim command, full file content, or unified diff — never truncated.
 */
export function ApprovalCard() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const pending = pendingApprovals(events)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editedCommand, setEditedCommand] = useState('')
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')

  const current = pending[0]
  const currentId = current ? (current.approval?.id ?? approvalId(current.key)) : null

  // Each new request starts with clean card-local state.
  useEffect(() => {
    setBusy(null)
    setFailure(null)
    setEditing(false)
    setDeclining(false)
    setNote('')
    setEditedCommand(current?.approval?.preview.kind === 'command' ? current.approval.preview.command : '')
  }, [currentId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!taskId || !current) return null

  const approval = current.approval
  const preview = approval?.preview
  const rememberPattern = approval?.rememberPattern

  const decide = async (
    action: 'allow' | 'remember' | 'edited' | 'decline',
    extra?: { note?: string; editedArgs?: Record<string, unknown> },
  ): Promise<void> => {
    if (busy) return
    setBusy(action)
    setFailure(null)
    try {
      // Older event logs (written before id-addressed approvals) have no
      // approval payload; those still decide through the legacy key endpoint.
      const response = approval
        ? await api.decideApproval(
            taskId,
            approval.id,
            action === 'allow' || action === 'edited' ? 'allow' : action === 'remember' ? 'allow_remember' : 'decline',
            { ...(extra?.note ? { note: extra.note } : {}), ...(extra?.editedArgs ? { editedArgs: extra.editedArgs } : {}) },
          )
        : await api.approve(taskId, current.key as PermissionKey, action === 'decline' ? 'deny' : 'grant', action === 'remember')
      if (!response.success) setFailure('the request expired before the decision arrived')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // Keys typed into the edit/note fields belong to those fields.
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
    if (event.key === 'Enter') {
      event.preventDefault()
      void decide('allow')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDeclining(true)
    }
  }

  const requester = approval?.requestedBy
  const fromChild = Boolean(requester?.parentTaskId && requester.parentTaskId !== requester.taskId)

  return (
    <section
      role="alertdialog"
      aria-label="approval required"
      data-testid="approval-card"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="motion-approval-rise flex max-h-[80vh] flex-col rounded-md border-2 border-warning bg-warning/10 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-warning">
        <ShieldAlert className="size-4" />
        <strong className="text-xs uppercase tracking-wider">approval required</strong>
        <Badge tone="warning">{current.key.tool}</Badge>
        {approval?.mode ? <Badge tone="neutral">{approval.mode} mode</Badge> : <Badge tone="neutral">{current.policy}</Badge>}
        {pending.length > 1 ? <Badge tone="warning">+{pending.length - 1} queued</Badge> : null}
      </div>

      {/* The preview scrolls inside the card; the header above and the action
          row below stay put, so the buttons remain visible however large the
          untruncated preview is. */}
      <div className="min-h-0 overflow-y-auto" data-testid="approval-card-scroll">
        <p className="mt-1 text-[11px] text-muted" data-testid="approval-requester">
          {fromChild
            ? `requested by child task ${requester?.taskId} (child of ${requester?.parentTaskId})`
            : `requested by task ${requester?.taskId ?? current.key.taskId}`}
        </p>

        {preview ? <ApprovalPreviewView preview={preview} /> : null}

        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          <dt className="text-muted">action</dt>
          <dd className="text-foreground">{current.key.action}</dd>
          <dt className="text-muted">target</dt>
          <dd className="truncate text-foreground">{previewTarget(preview) ?? current.key.path ?? '—'}</dd>
        </dl>
      </div>

      {editing && preview?.kind === 'command' ? (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted" htmlFor="approval-edit-input">
            edited command (split on whitespace when it runs)
          </label>
          <input
            id="approval-edit-input"
            data-testid="approval-edit-input"
            className="h-7 rounded border border-line bg-surface px-2 font-mono text-[11px] text-foreground"
            value={editedCommand}
            onChange={(event) => setEditedCommand(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="success"
              size="sm"
              disabled={busy !== null || editedCommand.trim().length === 0}
              onClick={() => void decide('edited', { editedArgs: parseCommandLine(editedCommand) })}
              data-testid="approval-edit-confirm"
            >
              run edited command
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setEditing(false)}>
              back
            </Button>
          </div>
        </div>
      ) : declining ? (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted" htmlFor="approval-note">
            note for the agent (sent verbatim — tell it what to do instead)
          </label>
          <textarea
            id="approval-note"
            data-testid="approval-note"
            rows={2}
            className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-foreground"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. run the tests for the server package only"
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide('decline', note.trim() ? { note: note.trim() } : undefined)}
              data-testid="approval-decline-confirm"
            >
              decline{note.trim() ? ' with note' : ''}
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setDeclining(false)}>
              back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="success" size="sm" disabled={busy !== null} onClick={() => void decide('allow')} data-testid="approval-allow">
            allow once <kbd className="ml-1 text-[9px] opacity-70">Enter</kbd>
          </Button>
          {rememberPattern ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide('remember')}
              data-testid="approval-remember"
              title="Remembered grants last only for this server session and are cleared when the server restarts."
            >
              allow &amp; remember: {rememberPattern.label}
            </Button>
          ) : null}
          {preview?.kind === 'command' ? (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setEditing(true)} data-testid="approval-edit">
              edit &amp; allow
            </Button>
          ) : null}
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null}
            onClick={() => setDeclining(true)}
            data-testid="approval-deny"
          >
            decline <kbd className="ml-1 text-[9px] opacity-70">Esc</kbd>
          </Button>
        </div>
      )}

      {rememberPattern ? (
        <p className="mt-1 text-[10px] text-muted">
          “allow &amp; remember” re-allows only future <strong>{rememberPattern.label}</strong> requests — for this server
          session only; restarting the server forgets it.
        </p>
      ) : null}

      {approval?.chain ? (
        <p className="mt-1 text-[10px] text-muted" data-testid="approval-chain-note">
          scaffold chain ({approval.chain.id}): approving this covers the rest of the recipe chain for this task (
          {approval.chain.covers.join(' → ')}). Declining still declines only this call.
        </p>
      ) : null}

      {failure ? <p className="mt-1 text-[10px] text-error">{failure}</p> : null}
    </section>
  )
}

function previewTarget(preview: ApprovalPreview | undefined): string | undefined {
  if (!preview) return undefined
  if (preview.kind === 'write' || preview.kind === 'edit') return preview.path
  if (preview.kind === 'command') return preview.cwd ?? 'workspace'
  return undefined
}

function ApprovalPreviewView({ preview }: { preview: ApprovalPreview }) {
  const text =
    preview.kind === 'command'
      ? `$ ${preview.command}`
      : preview.kind === 'write'
        ? preview.content
        : preview.kind === 'edit'
          ? preview.patch
          : JSON.stringify(preview.args ?? {}, null, 2)
  const label =
    preview.kind === 'command'
      ? 'command (verbatim)'
      : preview.kind === 'write'
        ? `new content of ${preview.path}`
        : preview.kind === 'edit'
          ? `diff for ${preview.path}`
          : 'arguments'
  return (
    <figure className="mt-2">
      <figcaption className="text-[10px] uppercase tracking-wider text-muted">{label}</figcaption>
      <pre
        data-testid="approval-preview"
        className="mt-0.5 max-h-64 overflow-auto whitespace-pre rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-foreground"
      >
        {text}
      </pre>
    </figure>
  )
}

/** Split an edited command line the same way the preview renders it: argv on whitespace. */
export function parseCommandLine(line: string): Record<string, unknown> {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  const [command, ...args] = tokens
  return { command: command ?? '', args }
}
