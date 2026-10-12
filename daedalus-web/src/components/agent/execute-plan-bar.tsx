import { useState } from 'react'
import { ListChecks, Play } from 'lucide-react'
import { Button } from '../ui/button'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { pendingApprovals, pendingQuestions, planDocuments, taskStatus } from '../../state/selectors'
import { executePlanDocument } from './execute-plan'

/**
 * Approve & Execute: when a Plan task finishes with plan documents
 * written (.daedalus/plans/<slug>/plan.md, named in its closing
 * PLAN_CREATED), the chat offers to run the plan for real. The follow-up
 * task carries plan_task_id, so the plan's steps ride into the executor's
 * prompt, and its goal names the plan file itself. The launch itself lives
 * in execute-plan.ts so the persistent plan chips above the composer run
 * the identical creation.
 */
export function ExecutePlanBar() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const [busy, setBusy] = useState<'auto' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const status = taskStatus(events, pendingApprovals(events).length, pendingQuestions(events).length)
  const documents = planDocuments(events)
  const planDoc = documents.find((path) => path.toLowerCase().endsWith('plan.md')) ?? documents[0]

  if (!taskId || !planDoc || (status !== 'done' && status !== 'partial')) return null

  const execute = async (mode: 'auto'): Promise<void> => {
    setBusy(mode)
    setFailure(null)
    try {
      await executePlanDocument({ workspaceRoot, planDoc, planTaskId: taskId })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      data-testid="execute-plan-bar"
      aria-label="approve and execute the plan"
      className="mt-2 flex flex-col gap-1.5 rounded-md border-2 border-success bg-success/10 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-success">
        <ListChecks className="size-4" />
        <strong className="text-xs uppercase tracking-wider">approve &amp; execute</strong>
      </div>
      <p className="text-[11px] text-foreground">
        Plan ready in <span className="font-mono">{planDoc}</span>. Run it now — the plan carries into the executor.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="success"
          size="sm"
          disabled={busy !== null}
          onClick={() => void execute('auto')}
          data-testid="execute-plan-auto"
        >
          <Play className="size-3.5" /> Execute with Auto
        </Button>
      </div>
      {failure ? <p className="text-[10px] text-error">{failure}</p> : null}
    </section>
  )
}
