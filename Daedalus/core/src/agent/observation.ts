import type { TaskState, PlanStep } from '../contracts.ts';
import type { Observation } from './types.ts';

/**
 * Observation handler: normalize tool output into state (PLAN.md Phase 3).
 * Marks the active plan step done on success, records evidence, and surfaces
 * errors on failure so stop conditions can react.
 */
export function handleObservation(observation: Observation, state: TaskState): TaskState {
  if (observation.kind === 'tool_result') {
    const { result } = observation;
    const evidence = `${result.status}: ${result.output.slice(0, 500)}`;
    const steps = state.steps.map((step): PlanStep => {
      if (step.status !== 'active') return step;
      return result.status === 'ok'
        ? { ...step, status: 'done', evidence: [...step.evidence, evidence] }
        : { ...step, evidence: [...step.evidence, evidence] };
    });
    const nextActive = steps.findIndex((s) => s.status === 'pending');
    const withNext = nextActive >= 0 ? steps.map((s, i) => (i === nextActive ? { ...s, status: 'active' as const } : s)) : steps;
    return {
      ...state,
      steps: withNext,
      last_observation: evidence,
      last_error: result.status === 'ok' ? undefined : `${result.status}: ${result.output.slice(0, 200)}`,
      plan: { ...state.plan, steps: withNext, status: withNext.every((s) => s.status === 'done' || s.status === 'skipped') ? 'complete' : state.plan.status },
    };
  }
  if (observation.kind === 'assistant') {
    const text = typeof observation.message.content === 'string' ? observation.message.content : '';
    return { ...state, last_observation: text };
  }
  return { ...state, last_observation: JSON.stringify(observation.event) };
}