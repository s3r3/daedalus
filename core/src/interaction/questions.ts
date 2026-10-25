import { randomUUID } from 'node:crypto';
import type { AgentMode } from '../contracts.ts';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { ToolDefinition, ToolExecutionContext } from '../tools/registry.ts';

/**
 * Interactive user questions (Claude Code's AskUserQuestion / Cline's
 * ask_followup_question): while shaping a plan, the agent may pause and ask
 * the human a multiple-choice question instead of guessing. The mechanism
 * deliberately mirrors the approval broker (execution/index.ts): the tool
 * builds a request with a stable id, emits QUESTION_REQUESTED, and blocks
 * until the answer arrives through `POST /tasks/:id/questions/:questionId`,
 * the wait times out, or the task is cancelled.
 */
import { ASK_USER_TOOL_NAME } from '../contracts.ts';
export { ASK_USER_TOOL_NAME };

/** One selectable answer the model offers on a question card. */
export type UserQuestionOption = { label: string; description?: string };

/** Everything an interface needs to render one question card. */
export type UserQuestionInfo = {
  id: string;
  taskId: string;
  question: string;
  options: UserQuestionOption[];
  /** When false, the card offers the options only — no free-text answer. */
  allowFreeText: boolean;
  /** Mode the requesting task runs under, when the runtime knows it. */
  mode?: AgentMode;
  /** Orchestrator parent of a (child) task, stamped for surfacing/cancel. */
  parentTaskId?: string;
  createdAt: string;
};

export type UserQuestionOutcome = 'answered' | 'timeout' | 'cancelled';

export type UserQuestionResult = {
  outcome: UserQuestionOutcome;
  /** The user's answer verbatim (the chosen option's label or free text). */
  answer?: string;
};

type PendingQuestion = {
  info: UserQuestionInfo;
  resolve: (result: UserQuestionResult) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Default wait for an answer before the agent proceeds on stated assumptions. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 900_000;

/**
 * Question wait budget: an explicit value wins, then
 * `DAEDALUS_QUESTION_TIMEOUT_MS`, then the 15-minute default. Timing out is
 * NOT a failure: the agent is told to proceed with stated assumptions.
 */
export function resolveQuestionTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const raw = process.env.DAEDALUS_QUESTION_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_QUESTION_TIMEOUT_MS;
}

/**
 * Question broker: bridges the `ask_user` tool (core) and the answer flow
 * over the API (server). An `ask` blocks until the matching answer arrives,
 * the wait times out (the agent proceeds with stated assumptions), or the
 * task is cancelled. Pending requests are keyed by question id.
 */
export class QuestionBroker {
  #pending = new Map<string, PendingQuestion>();
  #listeners = new Set<() => void>();
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = resolveQuestionTimeoutMs(options.timeoutMs);
  }

  /** The wait one question gets before it times out (ms). */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pending(taskId?: string): Array<{ info: UserQuestionInfo }> {
    return [...this.#pending.values()]
      .filter((p) => !taskId || p.info.taskId === taskId)
      .map((p) => ({ info: p.info }));
  }

  hasPending(questionId: string): boolean {
    return this.#pending.has(questionId);
  }

  ask(info: UserQuestionInfo): Promise<UserQuestionResult> {
    return new Promise<UserQuestionResult>((resolvePromise) => {
      const entry: PendingQuestion = { info, resolve: resolvePromise };
      if (this.#timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.#pending.delete(info.id)) return;
          this.#notify();
          resolvePromise({ outcome: 'timeout' });
        }, this.#timeoutMs);
        entry.timer.unref?.();
      }
      this.#pending.set(info.id, entry);
      this.#notify();
    });
  }

  /** Deliver a human answer (the chosen option's label or free text, verbatim). */
  answer(questionId: string, answer: string): boolean {
    const entry = this.#pending.get(questionId);
    if (!entry) return false;
    if (!this.#pending.delete(questionId)) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve({ outcome: 'answered', answer });
    this.#notify();
    return true;
  }

  /**
   * Settle every question a cancelled task is waiting on (including its
   * orchestrator children's) as cancelled, so a stopped run never hangs on
   * a card nobody will answer. Returns how many were settled.
   */
  cancelTasks(taskIds: Iterable<string>): number {
    const ids = new Set(taskIds);
    let settled = 0;
    for (const entry of [...this.#pending.values()]) {
      if (!ids.has(entry.info.taskId) && !(entry.info.parentTaskId && ids.has(entry.info.parentTaskId))) continue;
      if (!this.#pending.delete(entry.info.id)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ outcome: 'cancelled' });
      settled++;
    }
    if (settled > 0) this.#notify();
    return settled;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

export type AskUserToolDeps = {
  questions: QuestionBroker;
  bus: EventBus;
  store: TaskStore;
  /** Task this tool instance asks on behalf of (one tool per run). */
  taskId: string;
  /** Live mode of the requesting task, stamped onto the question. */
  modeFor?: () => AgentMode | undefined;
  /** Orchestrator parent, when the requesting task is a child task. */
  parentTaskId?: string;
  /** How long one question may wait; the tool outlives it so the harness never kills the wait early. */
  questionTimeoutMs?: number;
};

/** Normalize a model-supplied option (a bare string or a {label, description} object). */
export function normalizeQuestionOptions(raw: unknown): UserQuestionOption[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return undefined;
  const options: UserQuestionOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      options.push({ label: entry.trim() });
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const candidate = entry as { label?: unknown; description?: unknown };
      if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
        options.push({
          label: candidate.label.trim(),
          ...(typeof candidate.description === 'string' && candidate.description.trim().length > 0 ? { description: candidate.description.trim() } : {}),
        });
        continue;
      }
    }
    return undefined;
  }
  return options;
}

/** What the model is told, per question outcome. The answer itself is verbatim. */
export function questionResultOutput(info: UserQuestionInfo, result: UserQuestionResult): { status: 'ok' | 'denied'; output: string; optionIndex?: number } {
  if (result.outcome === 'cancelled') {
    return { status: 'denied', output: 'the question was cancelled because the task is stopping; do not ask further questions' };
  }
  if (result.outcome === 'timeout' || result.answer === undefined) {
    return {
      status: 'ok',
      output:
        'No answer arrived before the question timed out. Do not wait and do not re-ask the same question: proceed with your best judgment and state the assumption you chose explicitly (in plan mode, record it in the plan\'s Decisions section as "(assumed)").',
    };
  }
  const optionIndex = info.options.findIndex((option) => option.label === result.answer);
  if (optionIndex >= 0) {
    const option = info.options[optionIndex] as UserQuestionOption;
    return {
      status: 'ok',
      optionIndex,
      output: `The user answered your question by choosing option ${optionIndex + 1} of ${info.options.length}: "${option.label}"${option.description ? ` — ${option.description}` : ''}. Treat this as the user's decision and continue.`,
    };
  }
  return {
    status: 'ok',
    output: `The user answered your question with their own text: "${result.answer}". Treat this as the user's decision and continue.`,
  };
}

/**
 * The `ask_user` tool: asks the human one multiple-choice question and
 * blocks until it is answered. Created per run (like the read_skill tool)
 * because it closes over the run's broker, event target, and task id. The
 * question is emitted on the requesting task's log and mirrored onto the
 * orchestrator parent's log, so the parent's chat shows the card too.
 */
export function createAskUserTool(deps: AskUserToolDeps): ToolDefinition {
  const waitMs = deps.questionTimeoutMs ?? deps.questions.timeoutMs;
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      'Ask the user ONE multiple-choice question and wait for their answer before continuing. Use it when a requirement is genuinely ambiguous (the kind of site/app, audience, stack) and the answer changes what you will do. Give 2-4 concrete options; the user can always type their own answer unless allow_free_text is false. Do not ask questions you can answer from the workspace, and do not ask more than 4 questions for one task or plan.',
    mutating: false,
    // The harness must never kill the wait before the question itself
    // times out: the tool's budget is the question budget plus margin.
    timeoutMs: waitMs + 30_000,
    inputSchema: {
      type: 'object',
      required: ['question', 'options'],
      properties: {
        question: { type: 'string', description: 'The question to ask, in one sentence.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            required: ['label'],
            properties: {
              label: { type: 'string', description: 'Short choice text shown on the button.' },
              description: { type: 'string', description: 'Optional one-line explanation of this choice.' },
            },
          },
          description: '2-4 options the user can pick from.',
        },
        allow_free_text: { type: 'boolean', description: 'Let the user type their own answer instead of picking an option. Default true.' },
      },
      additionalProperties: false,
    },
    async execute(args, context: ToolExecutionContext) {
      const a = (args ?? {}) as { question?: unknown; options?: unknown; allow_free_text?: unknown };
      const question = typeof a.question === 'string' ? a.question.trim() : '';
      if (!question) {
        return { call_id: '', status: 'error', output: 'ask_user needs a non-empty "question" string', truncated: false, meta: { tool: ASK_USER_TOOL_NAME } };
      }
      const options = normalizeQuestionOptions(a.options);
      if (!options) {
        return {
          call_id: '',
          status: 'error',
          output: 'ask_user needs "options": 2-4 options, each a label string or { label, description? } with a non-empty label',
          truncated: false,
          meta: { tool: ASK_USER_TOOL_NAME },
        };
      }
      const info: UserQuestionInfo = {
        id: randomUUID(),
        taskId: deps.taskId,
        question,
        options,
        allowFreeText: a.allow_free_text !== false,
        ...(deps.modeFor?.() ? { mode: deps.modeFor() } : {}),
        ...(deps.parentTaskId ? { parentTaskId: deps.parentTaskId } : {}),
        createdAt: new Date().toISOString(),
      };
      const targets = [...new Set([deps.taskId, ...(deps.parentTaskId ? [deps.parentTaskId] : [])])];
      for (const taskId of targets) {
        emitEvent({ bus: deps.bus, store: deps.store }, taskId, undefined, 'QUESTION_REQUESTED', { question: info });
      }
      await deps.bus.drain();
      // Block on the broker. A harness abort (the user pressed Stop) also
      // settles the wait as cancelled — TaskRunner.cancel settles the
      // broker side for the whole task tree at the same time.
      const result = await new Promise<UserQuestionResult>((resolvePromise) => {
        let settled = false;
        const done = (value: UserQuestionResult): void => {
          if (settled) return;
          settled = true;
          resolvePromise(value);
        };
        void deps.questions.ask(info).then(done);
        const signal = context.signal;
        if (signal) {
          if (signal.aborted) done({ outcome: 'cancelled' });
          else signal.addEventListener('abort', () => done({ outcome: 'cancelled' }), { once: true });
        }
      });
      const formatted = questionResultOutput(info, result);
      for (const taskId of targets) {
        emitEvent({ bus: deps.bus, store: deps.store }, taskId, undefined, 'QUESTION_ANSWERED', {
          question_id: info.id,
          question: info.question,
          outcome: result.outcome,
          ...(result.answer !== undefined ? { answer: result.answer } : {}),
          ...(formatted.optionIndex !== undefined ? { option_index: formatted.optionIndex } : {}),
          ...(result.outcome === 'timeout' ? { timed_out: true } : {}),
          ...(result.outcome === 'cancelled' ? { cancelled: true } : {}),
        });
      }
      await deps.bus.drain();
      return {
        call_id: '',
        status: formatted.status,
        output: formatted.output,
        truncated: false,
        meta: { tool: ASK_USER_TOOL_NAME, mutating: false, question_id: info.id, outcome: result.outcome, ...(formatted.optionIndex !== undefined ? { option_index: formatted.optionIndex } : {}) },
      };
    },
  };
}

