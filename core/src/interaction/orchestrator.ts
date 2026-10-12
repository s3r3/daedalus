import { randomUUID } from 'node:crypto';
import type { ChildTask, ChildTaskBudget, ChildTaskErrorReason } from '../contracts.ts';

/**
 * Child-task machinery for model-invoked subagents (the `spawn_subagent`
 * tool, subagents.ts). There is no coordinator mode anymore: the agent
 * itself decides to delegate, and every delegation is one child task run
 * through the same TaskRunner as a top-level task (own event log, own
 * budget slice, approvals/questions mirrored to the parent). What lives
 * here is the shared vocabulary of that path: how a child record is built
 * and how its outcome is distilled before the parent ever sees it.
 */

export type ChildTaskInput = {
  goal: string;
  /** Short human label for the delegation; shown in the Child Tasks panel. */
  label?: string;
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

/**
 * Hard cap on a child's distilled summary. The child's full story lives in
 * its own task log; what travels back to the delegating model as the tool
 * result is a postcard, not the whole diary.
 */
export const MAX_CHILD_SUMMARY_CHARS = 1_500;

/** Per-line clip inside a distilled summary (evidence lines and closers). */
const SUMMARY_LINE_CHARS = 400;

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
 * The incident this fixes: a child's `last_observation` was the raw text of
 * its final tool call (e.g. `ok: ` + an entire file it just read), and that
 * got injected as the "summary" into the parent context and the final
 * report — thousands of wasted tokens per delegation.
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

export function childTaskFromInput(parentTaskId: string, input: ChildTaskInput): ChildTask {
  return {
    id: randomUUID(),
    parent_task_id: parentTaskId,
    goal: input.goal,
    ...(input.label ? { label: input.label } : {}),
    mode: input.mode,
    status: 'pending',
    budget: input.budget,
    created_at: new Date().toISOString(),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
  };
}
