import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PermissionKey } from '@daedalus/core'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { pendingApprovals } from '../../state/selectors'

/**
 * Human-in-the-loop gate (PLAN.md §3.0, §3.6). The card appears inline from an
 * APPROVAL_REQUESTED event and the agent stays blocked on the harness until a
 * decision arrives here; APPROVAL_DECIDED lands in the timeline and unblocks it.
 */
export function ApprovalCard() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const pending = pendingApprovals(events)
  const [busy, setBusy] = useState<string | null>(null)
  const [remember, setRemember] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (!taskId || pending.length === 0) return null
  const current = pending[0]
  if (!current) return null

  const decide = async (decision: 'grant' | 'deny'): Promise<void> => {
    setBusy(decision)
    setFailure(null)
    try {
      const response = await api.approve(taskId, current.key as PermissionKey, decision, remember && decision === 'grant')
      if (!response.success) setFailure('the request expired before the decision arrived')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      role="alertdialog"
      aria-label="approval required"
      data-testid="approval-card"
      className="motion-approval-rise rounded-md border-2 border-warning bg-warning/10 px-3 py-2"
    >
      <div className="flex items-center gap-1.5 text-warning">
        <ShieldAlert className="size-4" />
        <strong className="text-xs uppercase tracking-wider">approval required</strong>
        <Badge tone="warning">{current.policy}</Badge>
        {pending.length > 1 ? <Badge tone="warning">+{pending.length - 1} queued</Badge> : null}
      </div>

      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted">tool</dt>
        <dd className="text-foreground">{current.key.tool}</dd>
        <dt className="text-muted">action</dt>
        <dd className="text-foreground">{current.key.action}</dd>
        <dt className="text-muted">path</dt>
        <dd className="truncate text-foreground">{current.key.path ?? '—'}</dd>
      </dl>

      <label className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        <input type="checkbox" className="size-3 accent-primary" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        remember for this task
      </label>

      <div className="mt-2 flex gap-2">
        <Button variant="success" size="sm" disabled={busy !== null} onClick={() => void decide('grant')} data-testid="approval-allow">
          allow
        </Button>
        <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void decide('deny')} data-testid="approval-deny">
          deny
        </Button>
      </div>

      {failure ? <p className="mt-1 text-[10px] text-error">{failure}</p> : null}
    </section>
  )
}