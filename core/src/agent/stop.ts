import type { TaskState } from '../contracts.ts';
import type { StopCondition, StopPolicy, StopReason } from './types.ts';

/**
 * Stop conditions (PLAN.md Phase 3): bounded iterations, explicit abort,
 * no-progress guard (identical consecutive observations), plus caller conditions.
 */
export function evaluateStopConditions(state: TaskState, iteration: number, policy: StopPolicy): StopReason | undefined {
  if (iteration >= policy.max_iterations) return 'max_iterations';
  if (state.last_error === 'aborted' || state.last_error === 'stop requested') return 'aborted';
  if (state.status === 'done') return 'completed';
  for (const condition of policy.conditions ?? []) {
    const reason = condition(state, iteration);
    if (reason) return reason;
  }
  return undefined;
}

/** No-progress guard: same observation repeated N times means the loop is stuck. */
export function noProgressCondition(threshold = 3): StopCondition {
  let last: string | undefined;
  let repeats = 0;
  return (state) => {
    const current = state.last_observation ?? '';
    if (current && current === last) repeats++;
    else { repeats = 0; last = current; }
    return repeats >= threshold ? 'no_progress' : undefined;
  };
}