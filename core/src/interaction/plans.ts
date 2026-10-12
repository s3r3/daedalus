import {
  ARCHITECTURE_DOCUMENT_TEMPLATE,
  DESIGN_DOCUMENT_TEMPLATE,
  PLAN_DOCUMENT_TEMPLATE,
  PRD_DOCUMENT_TEMPLATE,
  TASKS_DOCUMENT_TEMPLATE,
  isPlanDocumentPath,
} from './modes.ts';
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

/**
 * The Plan mode document set, in report order: plan.md first (the
 * approval document execution keys off), then its companions — PRD.md
 * (what & why), architecture.md (how, technically), design.md (how it
 * looks), tasks.md (the execution contract). All five live under
 * `.daedalus/plans/<slug>/`.
 */
export const PLAN_DOCUMENT_FILES = ['plan.md', 'PRD.md', 'architecture.md', 'design.md', 'tasks.md'] as const;

/** Did this FILE_CHANGED (or change-set path) land a real plan document? */
export function isPlanDocumentChange(path: unknown): path is string {
  if (!isPlanDocumentPath(path)) return false;
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  return name !== undefined && (PLAN_DOCUMENT_FILES as readonly string[]).includes(name);
}

/** Did the change set include a specific plan document (e.g. the approval's plan.md)? */
export function hasPlanDocument(paths: Iterable<unknown>, name: string): boolean {
  for (const path of paths) {
    if (!isPlanDocumentChange(path)) continue;
    const writtenName = path.split('/').filter(Boolean).at(-1);
    if (writtenName === name) return true;
  }
  return false;
}

/**
 * Parse a tasks.md execution contract into step intents, in order:
 * checkbox items (`- [ ] …` / `- [x] …`) win when present; a bare
 * numbered/bulleted checklist is the fallback. Returns [] for prose.
 */
export function parseTasksDocument(content: string): string[] {
  const items: string[] = [];
  let sawCheckbox = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const checkbox = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(rawLine);
    if (checkbox?.[1]) {
      sawCheckbox = true;
      items.push(checkbox[1].trim());
      continue;
    }
    if (!sawCheckbox) {
      const plain = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(rawLine);
      if (plain?.[1] && !/^\[[ xX]\]/.test(plain[1].trim())) items.push(plain[1].trim());
    }
  }
  return items.filter((item) => item.length > 0);
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
 * Render the whole harness-assembled document SET: the same honesty as
 * renderAssembledPlan, extended to the five plan documents. Sections
 * the harness has no data for say so explicitly ("(not recorded)") —
 * the skeletons exist so the approved-plan flow always has documents
 * to execute against, never to dress up missing work as finished spec.
 */
export function renderAssembledPlanDocuments(input: {
  goal: string;
  plan?: Plan;
  decisions: PlanDecision[];
}): Array<{ name: string; content: string }> {
  const title = input.goal.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? 'Plan';
  const heading = title.length > 90 ? `${title.slice(0, 87)}…` : title;
  const header = [
    `> Assembled by the Daedalus harness from the plan steps and the recorded`,
    `> question/answer pairs because the model finished without writing`,
    `> the plan documents itself. Review before executing.`,
  ].join('\n');
  const steps = input.plan?.steps ?? [];
  const stepLines = steps.length > 0
    ? steps.map((step, index) => `${index + 1}. ${step.intent}`)
    : ['1. (no structured steps were recorded for this plan)'];
  const decisions = renderDecisionLines(input.decisions);
  const taskLines = steps.length > 0
    ? steps.map((step) => `- [ ] ${step.intent}`)
    : ['- [ ] (no structured tasks were recorded for this plan)'];
  return [
    { name: 'plan.md', content: renderAssembledPlan(input) },
    {
      name: 'PRD.md',
      content: [
        `# PRD: ${heading}`,
        '',
        header,
        '',
        '## Goal',
        input.goal.trim(),
        '',
        '## Users & roles',
        '- (not recorded — the model recorded no roles; confirm before executing)',
        '',
        '## Features',
        ...stepLines.map((line) => `- ${line.replace(/^\d+\.\s*/, '')}`),
        '',
        '## Scope / Non-goals',
        '- In scope: the steps listed in plan.md.',
        '- Non-goals: anything not named in the steps.',
        '',
        '## Core entities',
        '- (not recorded)',
        '',
        '## Constraints & assumptions',
        '- (not recorded beyond the Decisions below)',
        '',
        '## Decisions',
        ...decisions,
        '',
      ].join('\n'),
    },
    {
      name: 'architecture.md',
      content: [
        `# Architecture: ${heading}`,
        '',
        header,
        '',
        '## Stack',
        '- (not recorded — the model recorded no stack decision)',
        '',
        '## Components / modules',
        ...stepLines.map((line) => `- ${line.replace(/^\d+\.\s*/, '')}`),
        '',
        '## Data model',
        '- (not recorded)',
        '',
        '## Storage & state',
        '(not recorded)',
        '',
        '## Routes / pages',
        '- (not recorded)',
        '',
        '## Target files',
        '- (not recorded — execution derives them from tasks.md)',
        '',
      ].join('\n'),
    },
    {
      name: 'design.md',
      content: [
        `# Design: ${heading}`,
        '',
        header,
        '',
        '## Screens',
        '- (not recorded — the model recorded no screens)',
        '',
        '## Visual style',
        '- (not recorded)',
        '',
        '## Interactions & states',
        '- (not recorded)',
        '',
        '## Responsive notes',
        '- (not recorded)',
        '',
      ].join('\n'),
    },
    {
      name: 'tasks.md',
      content: [
        `# Tasks: ${heading}`,
        '',
        header,
        '',
        ...taskLines,
        '- [ ] Run the project validation and confirm every check passes',
        '',
      ].join('\n'),
    },
  ];
}

/** The templates of the four companion documents, for repair turns and tests. */
export const PLAN_DOCUMENT_TEMPLATES: Record<string, string> = {
  'PRD.md': PRD_DOCUMENT_TEMPLATE,
  'architecture.md': ARCHITECTURE_DOCUMENT_TEMPLATE,
  'design.md': DESIGN_DOCUMENT_TEMPLATE,
  'plan.md': PLAN_DOCUMENT_TEMPLATE,
  'tasks.md': TASKS_DOCUMENT_TEMPLATE,
};

/**
 * The single repair-turn directive injected when a plan task is about to
 * finish without a plan document: the templates, where to write them, and the
 * decisions recorded so far so the model does not have to re-ask anything.
 */
export function planDocumentRepairDirective(input: {
  goal: string;
  decisions: PlanDecision[];
}): string {
  const decisions = renderDecisionLines(input.decisions).join('\n');
  const folder = `.daedalus/plans/${planSlugFromGoal(input.goal)}`;
  return [
    'You are about to finish plan mode WITHOUT writing the plan documents — the plan document set is the deliverable of this mode, so the task cannot complete yet.',
    `Write the set now in ${folder}/ (create the folder with create_dir first), one write_file per document:`,
    '',
    `- PRD.md — follow this template EXACTLY:\n\n${PRD_DOCUMENT_TEMPLATE}`,
    '',
    `- architecture.md — follow this template EXACTLY:\n\n${ARCHITECTURE_DOCUMENT_TEMPLATE}`,
    '',
    `- design.md — follow this template EXACTLY:\n\n${DESIGN_DOCUMENT_TEMPLATE}`,
    '',
    `- plan.md — the approval summary; follow this template EXACTLY:\n\n${PLAN_DOCUMENT_TEMPLATE}`,
    '',
    `- tasks.md — the execution contract; follow this template EXACTLY:\n\n${TASKS_DOCUMENT_TEMPLATE}`,
    '',
    'Decisions recorded so far (copy these into the Decisions sections; do not ask anything again):',
    decisions,
    '',
    'Fill Goal and Scope from the original request and the workspace you explored. Every task names the concrete file(s) it touches. Do not start implementing anything — the documents are the only output of this turn.',
  ].join('\n');
}
