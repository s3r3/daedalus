import { useEffect, useState } from 'react'
import { ListChecks, Play, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import type { WorkspacePlan } from '../../api/types'
import { useActiveTaskId, useTaskEvents } from '../../state/hooks'
import { loadDismissedPlans, saveDismissedPlans } from '../../state/prefs'
import { useDaedalusStore } from '../../state/taskStore'
import { planDocuments } from '../../state/selectors'
import { executePlanDocument } from './execute-plan'

/**
 * Persistent plan chips above the composer: Plan mode writes its documents
 * to .daedalus/plans/<slug>/, but those files never surface in the @-mention
 * picker (hidden entries are pruned) and the Approve & Execute bar exists
 * only inside the finished Plan task's chat. This bar closes that gap: it
 * lists every plan the workspace has (GET /workspace/plans), one chip per
 * plan, so a plan outlives the task that drafted it. Clicking a chip marks
 * it ACTIVE (exactly one at a time; clicking again releases it); Execute on
 * the active chip launches the follow-up Auto task through the shared
 * execute-plan launch, identical to ExecutePlanBar. The trash icon hides a
 * chip from this bar (remembered per workspace); files on disk stay until
 * the user deletes them — the chip is a view, not a delete.
 */
export function PlanChipsBar() {
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const events = useTaskEvents()
  const taskId = useActiveTaskId()
  const [plans, setPlans] = useState<WorkspacePlan[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setDismissed(loadDismissedPlans(workspaceRoot))
    setActiveSlug(null)
    setFailure(null)
  }, [workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot) {
      setPlans([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await api.plans(workspaceRoot)
        if (!cancelled) setPlans(response.plans)
      } catch {
        if (!cancelled) setPlans([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  const visible = plans.filter((plan) => !dismissed.includes(plan.slug))
  const activePlan = visible.find((plan) => plan.slug === activeSlug) ?? null

  if (!workspaceRoot || visible.length === 0) return null

  // When the plan on screen is one the task behind the chat produced, the
  // follow-up carries plan_task_id exactly like ExecutePlanBar; a plan
  // drafted in an earlier session has no producing task on screen, so it
  // launches from its document path alone.
  const slugOf = (path: string): string | null => {
    const match = /^\.daedalus\/plans\/([^/]+)\//.exec(path)
    return match ? match[1]! : null
  }
  const onScreenSlug = planDocuments(events)
    .map(slugOf)
    .find((slug): slug is string => slug !== null && slug === activeSlug)

  const dismiss = (slug: string): void => {
    const next = [...new Set([...dismissed, slug])]
    setDismissed(next)
    saveDismissedPlans(workspaceRoot, next)
    if (activeSlug === slug) setActiveSlug(null)
  }

  const execute = async (): Promise<void> => {
    if (!activePlan || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const planDoc = activePlan.documents.find((path) => path.toLowerCase().endsWith('plan.md')) ?? activePlan.documents[0]
      await executePlanDocument({
        workspaceRoot,
        planDoc: planDoc!,
        ...(onScreenSlug && taskId ? { planTaskId: taskId } : {}),
      })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="plan-chips-bar"
      aria-label="workspace plans"
      className="flex flex-col gap-1 border-b border-line bg-surface px-3 py-1.5"
    >
      <div className="flex items-center gap-2 overflow-x-auto">
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
          <ListChecks className="size-3.5" /> plans
        </span>
        <ul className="flex min-w-0 items-center gap-1.5" data-testid="plan-chips">
          {visible.map((plan) => {
            const active = plan.slug === activeSlug
            return (
              <li key={plan.slug} className="shrink-0">
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                    active ? 'border-primary bg-primary/10 font-semibold text-foreground' : 'border-line text-muted'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    data-testid="plan-chip"
                    data-slug={plan.slug}
                    title={plan.title ?? plan.slug}
                    className="max-w-[14rem] truncate text-left"
                    onClick={() => {
                      setActiveSlug(active ? null : plan.slug)
                      setFailure(null)
                    }}
                  >
                    {plan.title ?? plan.slug}
                  </button>
                  <button
                    type="button"
                    aria-label={`dismiss plan ${plan.slug}`}
                    data-testid="plan-chip-dismiss"
                    data-slug={plan.slug}
                    title="Hide this plan from the bar (the files stay on disk)"
                    className="text-muted hover:text-error"
                    onClick={() => dismiss(plan.slug)}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
        {activePlan ? (
          <Button
            size="sm"
            disabled={busy}
            data-testid="plan-chip-execute"
            className="ml-auto shrink-0"
            onClick={() => void execute()}
          >
            <Play className="size-3.5" /> {busy ? 'starting…' : 'Execute plan'}
          </Button>
        ) : null}
      </div>
      {failure ? (
        <p className="text-[10px] text-error" data-testid="plan-chip-error">
          {failure}
        </p>
      ) : null}
    </section>
  )
}
