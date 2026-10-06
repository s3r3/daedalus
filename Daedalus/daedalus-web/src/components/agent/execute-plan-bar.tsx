import { useState } from 'react'
import { ListChecks, Play } from 'lucide-react'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { pendingApprovals, pendingQuestions, planDocuments, taskStatus } from '../../state/selectors'

/**
 * Approve & Execute: when a Plan task finishes with plan documents
 * written (.daedalus/plans/<slug>/plan.md, named in its closing
 * PLAN_CREATED), the chat offers to run the plan for real. The follow-up
 * task carries plan_task_id, so the plan's steps ride into the executor's
 * prompt, and its goal names the plan file itself.
 */
export function ExecutePlanBar() {
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const composer = useDaedalusStore((state) => state.composer)
  const setTask = useDaedalusStore((state) => state.setTask)
  const setComposer = useDaedalusStore((state) => state.setComposer)
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
      const goal = `Execute the approved plan in ${planDoc}`
      // Executing the plan is the next turn of the same chat conversation
      // when one is active, so the follow-up keeps the session's memory.
      const store = useDaedalusStore.getState()
      const activeConversation =
        store.conversation && store.conversation.root === workspaceRoot ? store.conversation : null
      const created = await api.createTask({
        goal,
        repo_path: workspaceRoot,
        mode,
        plan_task_id: taskId,
        auto_approve: composer.autoApprove,
        provider_id: composer.providerId || undefined,
        model: composer.model || undefined,
        thinking: composer.thinking,
        ...(activeConversation ? { conversation_id: activeConversation.id } : {}),
      })
      setTask(created.id, goal)
      if (activeConversation) {
        store.setConversation({
          ...activeConversation,
          turns: [
            ...activeConversation.turns,
            { role: 'user', text: goal, task_id: created.id, mode, ts: new Date().toISOString() },
          ],
        })
      }
      setComposer({ mode, goal: '' })
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
