/**
 * Anti-loop guard (history-processor concept): watch the stream of tool calls
 * for exact repeats — same tool, same arguments — inside a short recent
 * window. A model stuck exploring will re-issue an identical `list_dir` /
 * `read_file` forever; the guard first warns (guidance text is injected into
 * the next model request), then suppresses further exact duplicates with a
 * cached-repeat result instead of executing them again. The older
 * `no_progress` stop condition remains the final backstop.
 */

export type LoopGuardDecision = 'execute' | 'warn' | 'suppress';

export type LoopGuardObservation = {
  decision: LoopGuardDecision;
  /** How many times this exact call has now been seen (including this one). */
  repeats: number;
  signature: string;
};

export const LOOP_WINDOW_SIZE = 12;
export const LOOP_WARN_AT = 3;
export const LOOP_SUPPRESS_AFTER = 3;
export const REPEAT_SUPPRESSED_OUTPUT = '(repeat suppressed: same call already returned above)';

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
 * Per-task repeat tracker. Keeps only the last {@link LOOP_WINDOW_SIZE} call
 * signatures; a call "repeats" when its signature is already in that window.
 */
export class LoopGuard {
  readonly #window: string[] = [];
  readonly #windowSize: number;
  readonly #warnAt: number;
  readonly #suppressAfter: number;

  constructor(options: { windowSize?: number; warnAt?: number; suppressAfter?: number } = {}) {
    this.#windowSize = options.windowSize ?? LOOP_WINDOW_SIZE;
    this.#warnAt = options.warnAt ?? LOOP_WARN_AT;
    this.#suppressAfter = options.suppressAfter ?? LOOP_SUPPRESS_AFTER;
  }

  observe(tool: string, args: unknown): LoopGuardObservation {
    const signature = toolCallSignature(tool, args);
    const prior = this.#window.filter((entry) => entry === signature).length;
    this.#window.push(signature);
    if (this.#window.length > this.#windowSize) this.#window.splice(0, this.#window.length - this.#windowSize);
    const repeats = prior + 1;
    if (prior >= this.#suppressAfter) return { decision: 'suppress', repeats, signature };
    if (repeats >= this.#warnAt) return { decision: 'warn', repeats, signature };
    return { decision: 'execute', repeats, signature };
  }
}
