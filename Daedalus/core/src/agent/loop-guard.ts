/**
 * Anti-loop guard (history-processor concept): watch the stream of tool calls
 * for repeats inside a short recent window. A model stuck exploring will
 * re-issue an identical `list_dir` / `read_file` forever; the guard first
 * warns (guidance text is injected into the next model request), then
 * suppresses further duplicates with a cached-repeat result instead of
 * executing them again. The older `no_progress` stop condition remains the
 * final backstop.
 *
 * Exact repeats are not the only loop shape: models also re-list the SAME
 * directory with a different `depth`, or reload the SAME skill. So the guard
 * additionally tracks an argument-insensitive "exploration key" per call:
 *   - `list_dir`  → the resolved path (depth ignored): ".", the absolute
 *     workspace root, and depth 2 vs 3 are the same exploration.
 *   - `read_skill` → the skill name: a skill is loaded at most once per task;
 *     a repeat is answered with a short "already loaded" note instead of the
 *     full skill text again.
 * Exploration repeats warn/suppress on the same thresholds as exact repeats,
 * and suppression answers with a nudge toward the actual mutation
 * (create_dir/write_file) instead of more listing. A mutating call resets
 * the exploration counters for the path it touches (and its parents), since
 * listing/reading after a change is legitimate.
 */

import { relative, resolve } from 'node:path';

export type LoopGuardDecision = 'execute' | 'warn' | 'suppress';

/** Which repeat shape drove the decision: exact args, same-path exploration, or a skill reload. */
export type LoopRepeatKind = 'exact' | 'same_path' | 'skill';

export type LoopGuardObservation = {
  decision: LoopGuardDecision;
  /** How many times this call (exact or same-path) has now been seen, including this one. */
  repeats: number;
  signature: string;
  /** Repeat shape that drove a warn/suppress decision, when it was not a plain exact repeat. */
  repeatKind?: LoopRepeatKind;
  /** Replacement tool output to serve when the call is suppressed. */
  suppressedOutput?: string;
};

export const LOOP_WINDOW_SIZE = 12;
export const LOOP_WARN_AT = 3;
export const LOOP_SUPPRESS_AFTER = 3;
export const REPEAT_SUPPRESSED_OUTPUT = '(repeat suppressed: same call already returned above)';

/** Tools whose calls change the workspace; used to reset exploration counters on the touched path. */
const MUTATING_PATH_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'create_dir']);

/** Stable serialization: object keys sorted recursively so arg order never changes the signature. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

export function toolCallSignature(tool: string, args: unknown): string {
  return `${tool}:${stableSerialize(args ?? {})}`;
}

export function loopGuidanceNote(tool: string, repeats: number): string {
  return [
    `Loop warning: you have repeated ${tool} with the same arguments ${repeats} times without progress.`,
    'The result will not change. Choose a different action: write or edit a file, run a command, inspect a different path, or reply with "done: <summary>" if the task is actually complete.',
  ].join(' ');
}

/**
 * The escalation after repeated suppressions: not another copy of the
 * cached result, but a directive that names the only acceptable next
 * moves. The incident transcripts show a bare "(repeat suppressed)"
 * line being ignored turn after turn — the model's information never
 * changed, so its behavior didn't either.
 */
export function loopDirectiveNote(tool: string, repeats: number): string {
  return [
    `Loop directive: ${tool} with these arguments has now been repeated ${repeats} times and the result will not change — you already have it in your context.`,
    'Your next call must change something: the mutating tool for your goal (write_file/edit_file/download_file/run_command with a different command), ask_user if you are blocked on a decision, or finish by replying "done: <summary>" / reporting plainly what is missing. Repeating this call again will be refused and the task will pause.',
  ].join(' ');
}

/** Suppressed list_dir answer: point at the listing already given and push toward the actual change. */
export function explorationSuppressedNote(path: string): string {
  return `(repeat suppressed: you already listed "${path}" above and it has not changed since. Do not list it again — proceed to the actual change now: create_dir/write_file/edit_file for the target, or reply "done: <summary>" if nothing remains.)`;
}

/** Suppressed read_skill answer: the full text is already in the conversation. */
export function skillAlreadyLoadedNote(name: string): string {
  return `(skill "${name}" is already loaded earlier in this task — its full instructions are in the conversation above, do not load it again. Continue with the next concrete action: create_dir/write_file/edit_file or another tool the task needs.)`;
}

/**
 * Normalize a tool path argument for repeat comparison: ".", "", the
 * absolute workspace root, and "src/" vs "src" must compare equal.
 */
export function normalizeExplorationPath(rawPath: unknown, workspaceRoot?: string): string {
  const raw = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';
  if (workspaceRoot) {
    const resolved = resolve(workspaceRoot, raw);
    const rel = relative(resolve(workspaceRoot), resolved);
    if (rel === '') return '.';
    if (!rel.startsWith('..')) return rel.split('\\').join('/');
    return resolved;
  }
  const stripped = raw.replace(/\/+$/, '');
  return stripped === '' ? '.' : stripped;
}

/**
 * Argument-insensitive repeat key for exploration calls, or undefined for
 * tools where only exact repeats count (mutations, commands, reads of
 * specific files, …).
 */
export function explorationKey(tool: string, args: unknown, workspaceRoot?: string): string | undefined {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  if (tool === 'list_dir') return `list_dir:${normalizeExplorationPath(record.path, workspaceRoot)}`;
  if (tool === 'read_skill' && typeof record.name === 'string' && record.name) return `read_skill:${record.name}`;
  return undefined;
}

/**
 * Tools designed to be polled with identical arguments while their
 * result changes underneath: a background job's status is the whole
 * point of calling `command_status` again. Polls are counted (they still
 * occupy the window) but never warned on or suppressed — a cached
 * "same call" answer would lie about a job that has since finished.
 * Busy-polling stays bounded by the no-progress backstop and the
 * iteration budget, not by this guard.
 */
const POLLING_TOOLS: ReadonlySet<string> = new Set(['command_status']);

/**
 * Per-task repeat tracker. Keeps only the last {@link LOOP_WINDOW_SIZE} call
 * signatures; a call "repeats" when its signature is already in that window.
 * Exploration keys are tracked in a parallel window with the same thresholds.
 */
export class LoopGuard {
  readonly #window: string[] = [];
  readonly #explorationWindow: string[] = [];
  readonly #loadedSkills = new Set<string>();
  readonly #windowSize: number;
  readonly #warnAt: number;
  readonly #suppressAfter: number;
  readonly #workspaceRoot?: string;

  constructor(options: { windowSize?: number; warnAt?: number; suppressAfter?: number; workspaceRoot?: string } = {}) {
    this.#windowSize = options.windowSize ?? LOOP_WINDOW_SIZE;
    this.#warnAt = options.warnAt ?? LOOP_WARN_AT;
    this.#suppressAfter = options.suppressAfter ?? LOOP_SUPPRESS_AFTER;
    this.#workspaceRoot = options.workspaceRoot;
  }

  observe(tool: string, args: unknown): LoopGuardObservation {
    const signature = toolCallSignature(tool, args);
    const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;

    // A mutation makes earlier exploration of the touched path stale, so
    // those counters reset before this call itself is counted.
    if (MUTATING_PATH_TOOLS.has(tool) && typeof record.path === 'string') {
      this.#resetExplorationFor(record.path);
    }

    const prior = this.#window.filter((entry) => entry === signature).length;
    this.#window.push(signature);
    if (this.#window.length > this.#windowSize) this.#window.splice(0, this.#window.length - this.#windowSize);
    const repeats = prior + 1;

    // Polling a background job must always execute: its answer changes
    // while the arguments stay identical.
    if (POLLING_TOOLS.has(tool)) return { decision: 'execute', repeats, signature };

    const key = explorationKey(tool, args, this.#workspaceRoot);

    // Skills load once per task: a reload never re-serves the full text.
    if (tool === 'read_skill' && key) {
      const name = typeof record.name === 'string' ? record.name : '';
      if (this.#loadedSkills.has(key)) {
        return { decision: 'suppress', repeats, signature, repeatKind: 'skill', suppressedOutput: skillAlreadyLoadedNote(name) };
      }
      this.#loadedSkills.add(key);
    }

    let explorationPrior = 0;
    if (key) {
      explorationPrior = this.#explorationWindow.filter((entry) => entry === key).length;
      this.#explorationWindow.push(key);
      if (this.#explorationWindow.length > this.#windowSize) this.#explorationWindow.splice(0, this.#explorationWindow.length - this.#windowSize);
    }
    const explorationRepeats = explorationPrior + 1;

    const exactDecision: LoopGuardDecision = prior >= this.#suppressAfter ? 'suppress' : repeats >= this.#warnAt ? 'warn' : 'execute';
    const explorationDecision: LoopGuardDecision = key && tool !== 'read_skill'
      ? explorationPrior >= this.#suppressAfter ? 'suppress' : explorationRepeats >= this.#warnAt ? 'warn' : 'execute'
      : 'execute';

    if (explorationDecision === 'suppress') {
      return {
        decision: 'suppress',
        repeats: Math.max(repeats, explorationRepeats),
        signature,
        repeatKind: 'same_path',
        suppressedOutput: explorationSuppressedNote(normalizeExplorationPath(record.path, this.#workspaceRoot)),
      };
    }
    if (exactDecision === 'suppress') return { decision: 'suppress', repeats, signature };
    if (explorationDecision === 'warn') return { decision: 'warn', repeats: Math.max(repeats, explorationRepeats), signature, repeatKind: 'same_path' };
    if (exactDecision === 'warn') return { decision: 'warn', repeats, signature };
    return { decision: 'execute', repeats, signature };
  }

  /**
   * Re-arm after a user-approved continue (the hard-pause seam): forget
   * this call's repeat history so counting restarts from zero instead
   * of instantly re-pausing on the next identical call.
   */
  resetCall(tool: string, args: unknown): void {
    const signature = toolCallSignature(tool, args);
    for (let i = this.#window.length - 1; i >= 0; i--) {
      if (this.#window[i] === signature) this.#window.splice(i, 1);
    }
    const key = explorationKey(tool, args, this.#workspaceRoot);
    if (key) {
      for (let i = this.#explorationWindow.length - 1; i >= 0; i--) {
        if (this.#explorationWindow[i] === key) this.#explorationWindow.splice(i, 1);
      }
    }
  }

  /** Drop exploration counters for a mutated path and every ancestor the model might re-list. */
  #resetExplorationFor(mutationPath: string): void {
    const target = normalizeExplorationPath(mutationPath, this.#workspaceRoot);
    const affected = new Set<string>([target, '.']);
    // Ancestor directories of the target (their listings changed too).
    const parts = target.split('/').filter((part) => part && part !== '.');
    for (let i = 1; i < parts.length; i++) affected.add(parts.slice(0, i).join('/'));
    for (let i = this.#explorationWindow.length - 1; i >= 0; i--) {
      const key = this.#explorationWindow[i]!;
      const separator = key.indexOf(':');
      const path = separator >= 0 ? key.slice(separator + 1) : key;
      if (affected.has(path)) this.#explorationWindow.splice(i, 1);
    }
    // Exact repeats of listing/reading an affected path are legitimate after
    // the mutation (the content changed), so their history resets too.
    for (let i = this.#window.length - 1; i >= 0; i--) {
      const entry = this.#window[i]!;
      const separator = entry.indexOf(':');
      const tool = separator >= 0 ? entry.slice(0, separator) : '';
      if (tool !== 'list_dir' && tool !== 'read_file') continue;
      try {
        const args = JSON.parse(entry.slice(separator + 1)) as { path?: unknown };
        if (typeof args.path === 'string' && affected.has(normalizeExplorationPath(args.path, this.#workspaceRoot))) {
          this.#window.splice(i, 1);
        }
      } catch { /* unparseable signature: leave it counted */ }
    }
  }
}
