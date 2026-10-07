import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Run a finished plan for real (Approve & Execute; the plan chips above the
 * composer reuse the same launch). The follow-up task is created EXACTLY
 * like ExecutePlanBar does: its goal names the plan file, it carries
 * `plan_task_id` when the plan-producing task is known (core injects that
 * task's steps as a constraint), and it continues the active chat
 * conversation for this workspace when one exists, so the run is the next
 * turn of the same session. `planTaskId` is the producing task — known for
 * the on-screen finished Plan task, and derived the same way by the chips;
 * when unknown the run still launches from the document path alone.
 *
 * Returns the created task id. Throws through so callers own the busy and
 * error presentation (ExecutePlanBar's transient bar, the chips' row).
 */
export async function executePlanDocument(options: { workspaceRoot: string; planDoc: string; planTaskId?: string | null }): Promise<string> {
  const { workspaceRoot, planDoc } = options
  const store = useDaedalusStore.getState()
  const goal = `Execute the approved plan in ${planDoc}`
  // Executing the plan is the next turn of the same chat conversation
  // when one is active, so the follow-up keeps the session's memory.
  const activeConversation = store.conversation && store.conversation.root === workspaceRoot ? store.conversation : null
  const created = await api.createTask({
    goal,
    repo_path: workspaceRoot,
    mode: 'auto',
    ...(options.planTaskId ? { plan_task_id: options.planTaskId } : {}),
    auto_approve: store.composer.autoApprove,
    provider_id: store.composer.providerId || undefined,
    model: store.composer.model || undefined,
    thinking: store.composer.thinking,
    ...(activeConversation ? { conversation_id: activeConversation.id } : {}),
  })
  store.setTask(created.id, goal)
  if (activeConversation) {
    store.setConversation({
      ...activeConversation,
      turns: [
        ...activeConversation.turns,
        { role: 'user', text: goal, task_id: created.id, mode: 'auto', ts: new Date().toISOString() },
      ],
    })
  }
  store.setComposer({ mode: 'auto', goal: '' })
  return created.id
}
