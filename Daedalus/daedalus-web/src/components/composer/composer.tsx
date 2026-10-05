import { useState, type FormEvent } from 'react'
import { Play } from 'lucide-react'
import { Button } from '../ui/button'
import { Textarea } from '../ui/input'
import { useDaedalusStore } from '../../state/taskStore'
import { api } from '../../api/client'

/**
 * Task composer (PLAN.md §3.4: "task created → composer collapses"). The web
 * interface submits a goal + workspace; Daedalus Core does the interpreting.
 */
export function Composer() {
  const composer = useDaedalusStore((state) => state.composer)
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const activeTaskId = useDaedalusStore((state) => state.taskId)
  const setComposer = useDaedalusStore((state) => state.setComposer)
  const setTask = useDaedalusStore((state) => state.setTask)
  const [touched, setTouched] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const goal = composer.goal.trim()
    if (goal.length === 0) {
      setTouched(true)
      return
    }
    setComposer({ submitting: true, error: null })
    try {
      const created = await api.createTask({
        goal,
        repo_path: workspaceRoot,
        auto_approve: composer.autoApprove,
        max_iterations: composer.maxIterations,
      })
      setTask(created.id, goal)
      setComposer({ submitting: false, goal })
    } catch (error) {
      setComposer({ submitting: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={`flex flex-col gap-2 border-b border-line bg-surface-base px-3 py-2 ${activeTaskId ? 'motion-composer-collapse' : ''}`}
      data-testid="composer"
    >
      <Textarea
        aria-label="task goal"
        data-testid="composer-input"
        rows={2}
        placeholder="Describe the coding task… e.g. add a health endpoint and a test for it"
        value={composer.goal}
        onChange={(event) => setComposer({ goal: event.target.value })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          <input
            type="checkbox"
            className="size-3 accent-primary"
            checked={composer.autoApprove}
            onChange={(event) => setComposer({ autoApprove: event.target.checked })}
          />
          auto-approve
        </label>

        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          max iterations
          <input
            type="number"
            min={1}
            max={100}
            aria-label="max iterations"
            className="h-6 w-16 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={composer.maxIterations}
            onChange={(event) => setComposer({ maxIterations: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>

        <Button type="submit" size="sm" className="ml-auto" disabled={composer.submitting} data-testid="composer-submit">
          <Play />
          {composer.submitting ? 'submitting…' : 'run task'}
        </Button>
      </div>

      {touched && composer.goal.trim().length === 0 ? (
        <p role="alert" className="text-[11px] text-error">
          a task description is required
        </p>
      ) : null}
      {composer.error ? (
        <p role="alert" className="text-[11px] text-error">
          {composer.error}
        </p>
      ) : null}
    </form>
  )
}