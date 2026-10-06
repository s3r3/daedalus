import { PLAN_DOCUMENT_TEMPLATE, isPlanDocumentPath } from './modes.ts';
import type { Event, Plan } from '../contracts.ts';

/**
 * Plan-document guarantee (Plan mode).
 *
 * A plan-mode task's deliverable is a FILE under `.daedalus/plans/**`, but a
 * weak model can end its reply without ever writing it — and until now the
 * harness happily completed the task with an empty diff and no plan anywhere.
 * Two mechanisms make the file exist, honestly:
 *
 * 1. ONE repair turn: when the loop is about to finish a plan task with no
 *    plan document on disk, the model gets a single extra turn whose only
 *    job is to write the plan file (template + the Q&A decisions so far).
 * 2. Deterministic assembly: if the run still produced nothing, the harness
 *    itself writes `.daedalus/plans/<slug>/plan.md` from the structured plan
 *    steps and the recorded question/answer pairs. The final report's
 *    evidence says plainly that the harness assembled it — it is never
 *    dressed up as the model's own work. A document the model DID write is
 *    never overwritten.
 */

/** One recorded question/answer pair from a plan task's event log. */
export type PlanDecision = {
  question: string;
  /** The user's answer verbatim; undefined when none arrived. */
  answer?: string;
  /** 'answered' | 'timeout' | 'cancelled' (mirrors QUESTION_ANSWERED). */
  outcome: string;
};

const MAX_SLUG_CHARS = 40;

/** Deterministic kebab-case slug from the goal, for the harness-assembled path. */
export function planSlugFromGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  return slug || 'plan';
}

/** Relative path of the harness-assembled plan document for a goal. */
export function assembledPlanPath(goal: string): string {
  return `.daedalus/plans/${planSlugFromGoal(goal)}/plan.md`;
}

/** Did this FILE_CHANGED (or change-set path) land a real plan document? */
export function isPlanDocumentChange(path: unknown): path is string {
  if (!isPlanDocumentPath(path)) return false;
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  return name === 'plan.md' || name === 'PRD.md';
}

/** Question/answer pairs recorded in an event log, in order. */
export function planDecisionsFromEvents(events: Event[]): PlanDecision[] {
  const decisions: PlanDecision[] = [];
  for (const event of events) {
    if (event.type !== 'QUESTION_ANSWERED') continue;
    const payload = event.payload as { question?: unknown; answer?: unknown; outcome?: unknown };
    if (typeof payload.question !== 'string' || payload.question.trim() === '') continue;
    decisions.push({
      question: payload.question,
      ...(typeof payload.answer === 'string' && payload.answer !== '' ? { answer: payload.answer } : {}),
      outcome: typeof payload.outcome === 'string' ? payload.outcome : 'answered',
    });
  }
  return decisions;
}

/** `- question → answer` lines for the Decisions section; assumptions marked. */
export function renderDecisionLines(decisions: PlanDecision[]): string[] {
  if (decisions.length === 0) return ['- (no questions asked)'];
  return decisions.map((decision) => {
    if (decision.answer !== undefined) return `- ${decision.question} → ${decision.answer}`;
    if (decision.outcome === 'timeout') return `- ${decision.question} → (assumed) no answer arrived before the timeout; the working assumption is recorded in the plan steps`;
    return `- ${decision.question} → (assumed) unanswered (${decision.outcome}); no user decision recorded`;
  });
}

/**
 * Render the harness-assembled plan document: the prompt template filled
 * with the task's structured steps and recorded decisions. Deliberately
 * plain and complete rather than pretty — it exists so a plan task always
 * leaves a reviewable file, and its header says who assembled it.
 */
export function renderAssembledPlan(input: {
  goal: string;
  plan?: Plan;
  decisions: PlanDecision[];
}): string {
  const title = input.goal.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? 'Plan';
  const steps = input.plan?.steps ?? [];
  const lines: string[] = [
    `# ${title.length > 90 ? `${title.slice(0, 87)}…` : title}`,
    '',
    '> Assembled by the Daedalus harness from the plan steps and the recorded',
    '> question/answer pairs because the model finished without writing',
    '> plan.md itself. Review before executing.',
    '',
    '## Goal',
    input.goal.trim(),
    '',
    '## Scope / Non-goals',
    '- In scope: the steps listed below.',
    '- Non-goals: anything not named in the steps.',
    '',
    '## Decisions',
    ...renderDecisionLines(input.decisions),
    '',
    '## Steps',
    ...(steps.length > 0
      ? steps.map((step, index) => `${index + 1}. ${step.intent}`)
      : ['1. (no structured steps were recorded for this plan)']),
    '',
    '## Acceptance criteria',
    '- Every step above is implemented and the project validation passes.',
    '',
  ];
  return lines.join('\n');
}

/**
 * The single repair-turn directive injected when a plan task is about to
 * finish without a plan document: the template, where to write it, and the
 * decisions recorded so far so the model does not have to re-ask anything.
 */
export function planDocumentRepairDirective(input: {
  goal: string;
  decisions: PlanDecision[];
}): string {
  const decisions = renderDecisionLines(input.decisions).join('\n');
  return [
    'You are about to finish plan mode WITHOUT writing the plan document — the plan file is the deliverable of this mode, so the task cannot complete yet.',
    `Write it now: create the folder with create_dir, then write_file ${assembledPlanPath(input.goal)} following this template EXACTLY:`,
    '',
    PLAN_DOCUMENT_TEMPLATE,
    '',
    'Decisions recorded so far (copy these into the Decisions section; do not ask anything again):',
    decisions,
    '',
    'Fill Goal and Scope from the original request and the workspace you explored. Every step names the concrete file(s) it touches. Do not start implementing anything — the plan file is the only output of this turn.',
  ].join('\n');
}
