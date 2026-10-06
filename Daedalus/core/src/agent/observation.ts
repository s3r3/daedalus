import type { TaskState, PlanStep } from '../contracts.ts';
import type { Observation } from './types.ts';

const INSPECTION_INTENT = /\b(inspect|read|checks?|explore|review|list|find|locate|examine|audit|investigate|reproduce|validate|validation)\b/i;

/**
 * Observation handler: normalize tool output into state (PLAN.md Phase 3).
 * Marks the active plan step done on success, records evidence, and surfaces
 * errors on failure so stop conditions can react.
 *
 * Edit-progress guard: a successful read-only tool result is evidence, not
 * implementation progress. It may complete an inspection step, but it must not
 * silently satisfy a step that requires changing or executing something. When
 * a tool definition does not declare `meta.mutating`, the historical behaviour
 * is preserved for older stubs/tests.
 */
export function handleObservation(observation: Observation, state: TaskState): TaskState {
  if (observation.kind === 'tool_result') {
    const { result } = observation;
    const evidence = `${result.status}: ${result.output.slice(0, 500)}`;
    // Model-facing observation: the full result text. The agent loop shapes
    // every result to the tool-output caps (head+tail + spill marker) before
    // it gets here, so a blind head slice is no longer needed — it would cut
    // off the tail and the marker, which are the parts that stop re-runs.
    // Step evidence above stays a short excerpt for the persisted plan.
    const observationText = `${result.status}: ${result.output}`;
    const active = state.steps.find((step) => step.status === 'active');
    const mutating = result.meta?.mutating;
    const readOnlyCannotComplete = result.status === 'ok'
      && mutating === false
      && active !== undefined
      && !INSPECTION_INTENT.test(active.intent);

    if (readOnlyCannotComplete) {
      const hint = 'Read-only inspection does not complete this implementation step. Use a mutating tool (write_file, edit_file, create_dir) or run_command before marking it done; validation will verify the change.';
      const steps = state.steps.map((step): PlanStep => step.status === 'active'
        ? { ...step, evidence: [...step.evidence, evidence, hint] }
        : step);
      return {
        ...state,
        steps,
        last_observation: `${observationText}\n${hint}`,
        last_error: undefined,
        plan: { ...state.plan, steps, status: state.plan.status },
      };
    }

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
      last_observation: observationText,
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
