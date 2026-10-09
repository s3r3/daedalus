import { randomUUID } from 'node:crypto';
import type { Plan, PlanStep, TaskSpec } from '../contracts.ts';
import { detectCreationGoal, scaffoldApprovalChain, type ScaffoldMatch } from './scaffold.ts';
import type { Observation } from './types.ts';

/** The canned sequential pipeline used when a goal carries no done-criteria. */
export const DEFAULT_PLAN_STEPS = [
  'Inspect the repository structure relevant to the goal',
  'Make the code changes required by the goal',
  'Run the project validation checks',
];

const DEFAULT_STEPS = DEFAULT_PLAN_STEPS;

/**
 * Plan steps for a scaffold goal, derived from the recipe's declared
 * chain so the narration matches the actual next step. The canned
 * pipeline announced "Run the project validation checks" right after a
 * generator finished — while the install had not even run (Farid's live
 * run) — because three generic phases know nothing of the recipe's
 * generate → install → write → build sequence. One loop runs these
 * phases too; only the labels change.
 */
export function scaffoldPlanSteps(match: ScaffoldMatch): string[] {
  const { recipe, targetDir } = match;
  if (recipe.category === 'database') {
    return [
      `Write the ${recipe.framework} Compose stack into ${targetDir}/`,
      'Start the stack (docker compose up -d)',
      'Verify the stack is running (docker compose ps)',
    ];
  }
  const chain = scaffoldApprovalChain(match);
  const steps = [`Run the official ${recipe.framework} generator into ${targetDir}/`];
  const install = chain.find((step) => step.step === 'install');
  if (install) steps.push(`Install dependencies (${install.display} in ${targetDir}/)`);
  steps.push('Write the requested content into the generated project');
  const build = chain.find((step) => step.step === 'build');
  if (build) steps.push(`Build to verify (${build.display} in ${targetDir}/)`);
  return steps;
}

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

/** The Slide domain's canned pipeline (used when a slide goal carries no done-criteria). */
export const SLIDE_PLAN_STEPS = [
  'Generate the deck outline with the slide pipeline (skeleton deck persisted)',
  'Confirm the outline and design direction with the user (Standard checkpoint)',
  'Fill every slide with the pipeline (resumable per slide)',
  'Validate the deck and export the .pptx',
];

/** Planner: TaskSpec -> ordered, amendable checklist (PLAN.md §3.1). */
export async function createPlan(spec: TaskSpec): Promise<Plan> {
  // A scaffold goal with no explicit criteria narrates the recipe's own
  // sequence (generate → install → write → build) instead of the canned
  // pipeline — see scaffoldPlanSteps. Explicit done-criteria always win.
  const scaffold = spec.done_criteria.length === 0 ? detectCreationGoal(spec.goal, spec.done_criteria).scaffold : undefined;
  const intents = spec.done_criteria.length > 0
    ? spec.done_criteria.map((c) => `Satisfy: ${c}`)
    : spec.domain === 'slide'
      ? SLIDE_PLAN_STEPS
      : scaffold
        ? scaffoldPlanSteps(scaffold)
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