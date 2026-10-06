import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep, TaskSpec } from '../contracts.ts';
import type { Observation } from './types.ts';

/** The canned sequential pipeline used when a goal carries no done-criteria. */
export const DEFAULT_PLAN_STEPS = [
  'Inspect the repository structure relevant to the goal',
  'Make the code changes required by the goal',
  'Run the project validation checks',
];

const DEFAULT_STEPS = DEFAULT_PLAN_STEPS;

/**
 * True when every step intent comes from the canned default pipeline. Such a
 * chain is three names for ONE loop's phases (explore → edit → validate over
 * the same goal and the same context), not three independent work items —
 * the orchestrator runs it directly instead of fanning it out into children
 * that each re-derive the shared context (see orchestrator.ts).
 */
export function isDefaultPipeline(intents: string[]): boolean {
  return intents.length > 0 && intents.every((intent) => DEFAULT_STEPS.includes(intent));
}

/** Planner: TaskSpec -> ordered, amendable checklist (PLAN.md §3.1). */
export async function createPlan(spec: TaskSpec): Promise<Plan> {
  const intents = spec.done_criteria.length > 0
    ? spec.done_criteria.map((c) => `Satisfy: ${c}`)
    : DEFAULT_STEPS;
  const steps: PlanStep[] = intents.map((intent, index) => ({
    id: `${spec.id}-step-${index + 1}`,
    intent,
    status: index === 0 ? 'active' : 'pending',
    evidence: [],
  }));
  return { id: randomUUID(), task_id: spec.id, steps, version: 1, status: 'active' };
}

/**
 * Replan: amend the checklist after an observation (Phase 6 turns this into a
 * richer strategy; here it appends a remediation step and bumps the version).
 */
export async function replan(spec: TaskSpec, current: Plan, observation: Observation): Promise<Plan> {
  const reason = observation.kind === 'tool_result' ? observation.result.status : 'replan requested';
  const step: PlanStep = {
    id: `${spec.id}-step-${current.steps.length + 1}`,
    intent: `Recover from ${reason}`,
    status: 'pending',
    evidence: [],
  };
  return {
    ...current,
    steps: [...current.steps, step],
    version: current.version + 1,
    status: 'active',
  };
}