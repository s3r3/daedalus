import { randomUUID } from 'node:crypto';
import type { ChildTask, ChildTaskBudget, ChildTaskErrorReason, Event, TaskSpec } from '../contracts.ts';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import { DEFAULT_PLAN_STEPS, createPlan } from '../agent/planner.ts';

export type ChildTaskInput = {
  goal: string;
  mode?: ChildTask['mode'];
  budget?: ChildTaskBudget;
  /** File-defined subagent (.daedalus/agents/<name>.md) that runs this child, if any. */
  agent?: string;
  /** Run this child in an isolated git worktree instead of the shared workspace. */
  isolation?: 'worktree';
};

/** One file a child changed, with line counts — the distilled shape of a diff. */
export type ChildFileChange = { path: string; added?: number; removed?: number };

export type ChildTaskExecution = {
  status: ChildTask['status'];
  summary?: string;
  diff?: string;
  iterations?: number;
  errors?: number;
  /** Typed failure for the parent when the child did not complete. */
  error_reason?: ChildTaskErrorReason;
  /** Files this child changed (distilled-summary input; the diff itself stays in the child's log). */
  files_changed?: ChildFileChange[];
  /** The child run's own report evidence lines (distilled-summary input). */
  evidence?: string[];
};

/** What the runner hands the executor alongside the child itself. */
export type ChildRunContext = {
  /**
   * Distilled results of the children that already finished, under a
   * "## findings from previous steps" heading (capped). A later child acts
   * on these instead of re-reading everything a sibling already inspected.
   */
  priorFindings?: string;
};

export type ChildTaskExecutor = (child: ChildTask, context: ChildRunContext) => Promise<ChildTaskExecution>;

export type OrchestratorResult = {
  parent_task_id: string;
  children: ChildTask[];
  status: 'done' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  diff: string;
  no_progress: boolean;
  budget_exceeded: boolean;
  /** Legible budget math for the final report: `child budgets: 8/8, 5/12 …; pool 13/25`. */
  budget_summary: string;
};

/**
 * Hard cap on a child's distilled summary. The child's full story lives in
 * its own task log; what travels into the parent's context, the findings
 * handoff, and the parent report is a postcard, not the whole diary.
 */
export const MAX_CHILD_SUMMARY_CHARS = 1_500;

/** Per-line clip inside a distilled summary (evidence lines and closers). */
const SUMMARY_LINE_CHARS = 400;

/** Cap on the accumulated findings handed to a later child. */
const MAX_FINDINGS_CHARS = 6_000;

/** Text that opens with a tool-result status prefix is a raw observation, never a summary. */
const OBSERVATION_PREFIX = /^(ok|error|denied|timeout):/;

function clipLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Distill a child's raw execution into the ONLY summary shape a parent ever
 * sees: an outcome line, the changed files with line counts, up to two
 * evidence lines, and — only when it is a genuine closing sentence rather
 * than a tool-observation dump — one closing line from the child itself.
 * Hard-capped at MAX_CHILD_SUMMARY_CHARS with a truncation marker.
 *
 * The incident this fixes: the child's `last_observation` was the raw text
 * of its final tool call (e.g. `ok: ` + an entire file it just read), and
 * that got injected as the "summary" into the parent context, the next
 * children's prompts, and the final report — thousands of wasted tokens.
 */
export function distillChildSummary(input: {
  status: ChildTask['status'];
  errorReason?: ChildTaskErrorReason;
  /** Free text from the executor (may be a raw observation dump — sanitized here). */
  summary?: string;
  filesChanged?: ChildFileChange[];
  evidence?: string[];
}): string {
  const lines: string[] = [];
  lines.push(input.errorReason ? `${input.status} (${input.errorReason})` : input.status);

  const files = (input.filesChanged ?? []).filter((file) => typeof file.path === 'string' && file.path.length > 0);
  if (files.length > 0) {
    lines.push(`changed: ${files.map((file) => `${file.path} (+${file.added ?? 0}/-${file.removed ?? 0})`).join(', ')}`);
  }

  for (const evidence of (input.evidence ?? []).slice(0, 2)) {
    const line = clipLine(evidence ?? '', SUMMARY_LINE_CHARS);
    if (line) lines.push(line);
  }

  const closing = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (closing && !OBSERVATION_PREFIX.test(closing)) {
    const firstLine = clipLine(closing.split('\n').find((line) => line.trim().length > 0) ?? '', SUMMARY_LINE_CHARS);
    if (firstLine && !lines.includes(firstLine)) lines.push(firstLine);
  }

  let text = lines.join('\n');
  if (text.length > MAX_CHILD_SUMMARY_CHARS) {
    const marker = '\n…[summary truncated]';
    text = `${text.slice(0, MAX_CHILD_SUMMARY_CHARS - marker.length)}${marker}`;
  }
  return text;
}

/**
 * The small-task bypass decision (incident: a one-page "add images + CSS"
 * goal fanned out into three sequential full agent loops — inspect,
 * implement, validate — that each re-read the same files and starved one
 * shared budget; 609s and a budget_exceeded death for a single-loop job).
 *
 * Fan-out pays only when the children are genuinely independent work
 * (multiple done-criteria). Fewer than two children, or exactly the canned
 * sequential pipeline (the default inspect → implement → validate steps
 * over one goal — sequential dependents sharing all context), runs as ONE
 * agent loop on the parent task instead. Caller-provided child lists are
 * never second-guessed here; this judges decompositions only.
 */
export function shouldRunDirect(spec: TaskSpec, decomposed: ChildTask[], stepIntents: string[]): boolean {
  if (decomposed.length < 2) return true;
  if (spec.done_criteria.length > 1) return false;
  return stepIntents.length > 0 && stepIntents.every((intent) => DEFAULT_PLAN_STEPS.includes(intent));
}

/** Appended to every decomposed child's goal: the return contract. */
const CHILD_SUMMARY_CONTRACT =
  'Finish with a short summary of the outcome — what changed or what you found, with file paths and line counts — and never paste file contents into the summary.';

/** Appended to implementation children: the change-evidence demand. */
const CHILD_IMPLEMENTATION_CONTRACT =
  'This step requires a real change: use a mutating tool (write_file, edit_file, create_dir) or run_command; read-only inspection alone does not complete it.';

const INSPECTION_STEP = /\b(inspect|read|explore|review|list|find|locate|examine|audit|investigate|reproduce)\b/i;

/** Implementation steps demand change evidence; inspect/validate steps only the summary contract. */
function childContractFor(intent: string): string {
  return INSPECTION_STEP.test(intent) || /\b(valid|verif|test|check)\b/i.test(intent)
    ? CHILD_SUMMARY_CONTRACT
    : `${CHILD_IMPLEMENTATION_CONTRACT}\n${CHILD_SUMMARY_CONTRACT}`;
}

export function childTaskFromInput(parentTaskId: string, input: ChildTaskInput): ChildTask {
  return {
    id: randomUUID(),
    parent_task_id: parentTaskId,
    goal: input.goal,
    mode: input.mode,
    status: 'pending',
    budget: input.budget,
    created_at: new Date().toISOString(),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
  };
}

/**
 * Deterministic decomposition used when the caller does not provide an
 * explicit child list: one child per done-criterion, otherwise one child per
 * planner step. The child's goal always carries the parent goal so a child run
 * cannot lose the overall intent, plus the step contract (implementation
 * steps demand file-change evidence; every child owes a short summary).
 */
export async function decomposeTask(spec: TaskSpec): Promise<ChildTask[]> {
  if (spec.done_criteria.length > 1) {
    return spec.done_criteria.map((criterion) => childTaskFromInput(spec.id, {
      goal: `${spec.goal}\nChild task: satisfy this done criterion: ${criterion}\n${CHILD_IMPLEMENTATION_CONTRACT}\n${CHILD_SUMMARY_CONTRACT}`,
      mode: 'auto',
    }));
  }
  const plan = await createPlan(spec);
  return plan.steps.map((step) => childTaskFromInput(spec.id, {
    goal: `${spec.goal}\nChild task: ${step.intent}\n${childContractFor(step.intent)}`,
    mode: 'auto',
  }));
}

/** Assemble the findings handoff text: heading + distilled summaries, capped. */
function findingsText(entries: string[]): string | undefined {
  if (entries.length === 0) return undefined;
  const body = entries.join('\n');
  const heading = '## findings from previous steps';
  const capped = body.length > MAX_FINDINGS_CHARS ? `${body.slice(0, MAX_FINDINGS_CHARS)}\n…[findings truncated]` : body;
  return `${heading}\n${capped}`;
}

export class OrchestratorRunner {
  readonly #bus?: EventBus;
  readonly #store?: TaskStore;
  readonly #executeChild: ChildTaskExecutor;
  readonly #totalBudget?: ChildTaskBudget;

  constructor(options: { bus?: EventBus; store?: TaskStore; executeChild: ChildTaskExecutor; totalBudget?: ChildTaskBudget }) {
    this.#bus = options.bus;
    this.#store = options.store;
    this.#executeChild = options.executeChild;
    this.#totalBudget = options.totalBudget;
  }

  async run(parentTaskId: string, inputs: ChildTaskInput[]): Promise<OrchestratorResult> {
    const children = inputs.map((input) => childTaskFromInput(parentTaskId, input));
    const diffs: string[] = [];
    const summaries: string[] = [];
    const findings: string[] = [];
    const budgetParts: string[] = [];
    let previousFingerprint: string | undefined;
    let noProgress = false;
    let budgetExceeded = false;
    let totalIterations = 0;
    let totalErrors = 0;

    for (const [index, child] of children.entries()) {
      const remaining = this.#totalBudget ? this.#totalBudget.max_iterations - totalIterations : undefined;
      const errorsRemaining = this.#totalBudget ? this.#totalBudget.max_errors - totalErrors : undefined;
      if (noProgress) {
        child.status = 'cancelled';
        child.error_reason = 'no_progress';
        child.result_summary = 'cancelled after no-progress stop';
        budgetParts.push(`0/${child.budget?.max_iterations ?? '–'} (not run)`);
        continue;
      }
      if ((remaining !== undefined && remaining <= 0) || (errorsRemaining !== undefined && errorsRemaining <= 0)) {
        // The shared pool is spent: this child never starts, typed as such.
        // (Children already finished keep their results — exhaustion stops
        // NEW work, it does not abort the run; see the continue rule below.)
        budgetExceeded = true;
        child.status = 'cancelled';
        child.error_reason = 'budget_exceeded';
        child.result_summary = 'cancelled after total budget exceeded';
        budgetParts.push(`0/${child.budget?.max_iterations ?? '–'} (not run)`);
        continue;
      }
      // Per-child slice: an explicit budget wins, else a floor of 8 turns or
      // an even share of what is left — never more than the pool still holds,
      // so the run as a whole can never exceed the total iteration budget.
      // With no shared pool there is nothing to slice: the input budget (if
      // any) stands as-is.
      if (this.#totalBudget && remaining !== undefined) {
        const share = Math.max(8, Math.floor(remaining / (children.length - index)));
        const allocated = child.budget?.max_iterations ?? share;
        child.budget = {
          max_iterations: Math.max(1, Math.min(allocated, remaining)),
          max_errors: child.budget?.max_errors ?? this.#totalBudget.max_errors,
        };
      }

      child.status = 'running';
      this.#emit(parentTaskId, 'CHILD_TASK_STARTED', { child: { ...child } });
      try {
        const execution = await this.#executeChild({ ...child }, { priorFindings: findingsText(findings) });
        child.status = execution.status;
        if (execution.status !== 'done') {
          child.error_reason = execution.error_reason ?? (execution.status === 'cancelled' ? 'cancelled' : 'child_failed');
        }
        child.result_summary = distillChildSummary({
          status: execution.status,
          ...(child.error_reason ? { errorReason: child.error_reason } : {}),
          summary: execution.summary,
          filesChanged: execution.files_changed,
          evidence: execution.evidence,
        });
        const usedIterations = execution.iterations ?? 1;
        const usedErrors = execution.errors ?? (execution.status === 'failed' ? 1 : 0);
        child.iterations_used = usedIterations;
        totalIterations += usedIterations;
        totalErrors += usedErrors;
        budgetParts.push(`${usedIterations}/${child.budget?.max_iterations ?? '–'}`);
        if (execution.diff) diffs.push(execution.diff);
        summaries.push(`${child.goal}: ${child.result_summary}`);
        findings.push(`- ${clipLine(child.goal, 160)} → ${child.result_summary}`);
        const fingerprint = `${child.goal}:${execution.status}:${child.result_summary}:${execution.diff ?? ''}`;
        if (previousFingerprint !== undefined && fingerprint === previousFingerprint) noProgress = true;
        previousFingerprint = fingerprint;
      } catch (error) {
        child.status = 'failed';
        child.error_reason = 'child_failed';
        child.result_summary = distillChildSummary({ status: 'failed', errorReason: 'child_failed', summary: String(error) });
        child.iterations_used = 1;
        totalIterations += 1;
        totalErrors += 1;
        budgetParts.push(`1/${child.budget?.max_iterations ?? '–'}`);
        summaries.push(`${child.goal}: ${child.result_summary}`);
        findings.push(`- ${clipLine(child.goal, 160)} → ${child.result_summary}`);
      }
      // Slice-exhaustion rule: a child that burned ITS slice is a failed
      // child (typed budget_exceeded), not a dead run — the loop above
      // simply moves on while the pool still has room.
      this.#emit(parentTaskId, 'CHILD_TASK_FINISHED', { child: { ...child } });
    }

    const done = children.filter((child) => child.status === 'done').length;
    const failed = children.some((child) => child.status === 'failed');
    const anyNotDone = children.some((child) => child.status !== 'done');
    const status: OrchestratorResult['status'] = noProgress || (failed && done === 0)
      ? 'failed'
      : !anyNotDone
        ? 'done'
        : done > 0
          ? 'partial'
          : 'cancelled';
    const budget_summary = this.#totalBudget
      ? `child budgets: ${budgetParts.join(', ')}; pool ${totalIterations}/${this.#totalBudget.max_iterations} iterations`
      : `child budgets: ${budgetParts.join(', ')}`;
    return {
      parent_task_id: parentTaskId,
      children,
      status,
      summary: summaries.join('\n'),
      diff: diffs.join(''),
      no_progress: noProgress,
      budget_exceeded: budgetExceeded,
      budget_summary,
    };
  }

  #emit(taskId: string, type: Event['type'], payload: unknown): void {
    if (!this.#bus && !this.#store) return;
    if (this.#bus) {
      emitEvent({ bus: this.#bus, store: this.#store }, taskId, undefined, type, payload);
      return;
    }
    const store = this.#store!;
    store.append(taskId, {
      seq: store.replay(taskId).length + 1,
      task_id: taskId,
      type,
      payload,
      ts: new Date().toISOString(),
    });
  }
}
