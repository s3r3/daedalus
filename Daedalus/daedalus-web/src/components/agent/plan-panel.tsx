import { useMemo } from 'react'
import { Badge } from '../ui/badge'
import { Spinner } from '../common/spinner'
import { EmptyState, Panel } from '../common/panel'
import { useTaskEvents } from '../../state/hooks'
import { currentStep, planSteps } from '../../state/selectors'
import { toneForResult } from './status-tone'

const STEP_ICON: Record<string, string> = { done: '✓', skipped: '–', active: '', pending: '○' }

/** The plan checklist with live status and evidence (PLAN.md Phase 8). */
export function PlanPanel() {
  const events = useTaskEvents()
  const steps = useMemo(() => planSteps(events), [events])
  const active = useMemo(() => currentStep(events), [events])

  return (
    <Panel
      title="plan"
      data-testid="plan-panel"
      action={steps.length > 0 ? <Badge tone="primary">{steps.length} steps</Badge> : null}
      bodyClassName="overflow-y-auto"
    >
      {steps.length === 0 ? (
        <EmptyState title="No plan yet" hint="The plan appears here before the agent takes its first action." />
      ) : (
        <ol className="flex flex-col gap-1" data-testid="plan-steps">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className={`flex items-start gap-2 rounded px-1.5 py-1 text-[11px] ${step.status === 'active' ? 'bg-surface' : ''}`}
              data-testid="plan-step"
              data-status={step.status}
            >
              <span className="mt-[1px] w-4 shrink-0 text-center text-muted">
                {step.status === 'active' ? <Spinner label={`step ${index + 1} running`} /> : STEP_ICON[step.status]}
              </span>
              <span className="flex-1">
                <span className={step.status === 'done' ? 'text-muted line-through' : 'text-foreground'}>
                  {index + 1}. {step.intent}
                </span>
                {step.evidence.length > 0 ? (
                  <span className="mt-0.5 flex flex-col gap-0.5 text-[10px] text-muted">
                    {step.evidence.map((evidence) => (
                      <span key={evidence} className="truncate">
                        ↳ {evidence}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <Badge tone={toneForResult(step.status)}>{step.status}</Badge>
            </li>
          ))}
        </ol>
      )}

      {active ? (
        <p className="mt-2 border-t border-line pt-1.5 text-[10px] uppercase tracking-wider text-muted" data-testid="current-step">
          current step · {active.intent}
        </p>
      ) : null}
    </Panel>
  )
}