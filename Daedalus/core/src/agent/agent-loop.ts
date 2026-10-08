import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { ContentBlock, LLMProvider, Message, ModelPhase } from '../providers/llm/types.ts';
import { classifyLLMError, LLMAuthError, LLMContentPolicyError, type LLMErrorKind } from '../providers/llm/errors.ts';
import { StreamMessageAssembler } from '../providers/llm/stream-assembly.ts';
import { asModelController, modelPoolFailureReason } from '../providers/llm/model-pool.ts';
import type { AgentMode, Event, ModelTier, Plan, PlanStep, TaskSpec, TaskState, ToolCall, ToolResult } from '../contracts.ts';
import type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor } from './types.ts';
import type { Validator } from '../validation/index.ts';
import { completionGate, normalizeError, validationFailed, validationFailureSignature } from '../validation/index.ts';
import { interpretTask } from './interpreter.ts';
import { createPlan, replan } from './planner.ts';
import { DefaultContextManager, CONDENSED_TOOL_OUTPUT, condenseToolOutputs, contextMeter } from './context.ts';
import { LoopGuard, REPEAT_SUPPRESSED_OUTPUT, loopDirectiveNote, loopGuidanceNote, toolCallSignature } from './loop-guard.ts';
import { toolCallParseErrorOutput, validateToolCallArguments } from './tool-call-validation.ts';
import { handleObservation } from './observation.ts';
import { resolveToolOutputLimits, shapeToolOutput, writeSpillFile, type ToolOutputLimits } from './tool-output.ts';
import { compressCommandOutput, type CommandOutputCompression } from './output-compression.ts';
import { evaluateStopConditions, noProgressCondition } from './stop.ts';
import { ModeController, classifyToolName, isToolCallDenied, isToolVisible, modeDenialMessage } from '../interaction/modes.ts';
import { PLAN_DOCUMENT_FILES, hasPlanDocument, isPlanDocumentChange, planDecisionsFromEvents, planDocumentRepairDirective } from '../interaction/plans.ts';
import { ASK_USER_TOOL_NAME } from '../interaction/questions.ts';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../interaction/subagents.ts';
import { creationCompletionRefusal, deriveTaskTargetDir, detectCreationGoal, pathInsideTarget, questionGateAppliesToGoal, scaffoldMarkerPresent, sessionAnchorDirective, summarizeCommandFailure, workspaceRelativePath, type CreationGoal } from './scaffold.ts';

export type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor };
export { interpretTask };
export { createPlan, replan };
export { DefaultContextManager };
export { handleObservation };
export { evaluateStopConditions };

/**
 * Consecutive provider timeouts tolerated before the turn fails with the
 * typed reason `provider_timeout`. A timeout means the (possibly
 * oversized) request never returned; resending the identical request a
 * third time only burns another full timeout window, so the cap sits
 * below the generic error budget (max_errors counts ALL consecutive
 * failures — timeouts get their own, stricter budget).
 */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** Identical-call total at which the loop breaker hard-pauses (Cline converges at 5). */
export const LOOP_HARD_PAUSE_AT = 5;
/** Consecutive non-progress tool results that end a task as partial (the stall backstop). */
export const STALL_LIMIT = 6;
/** Stall count at which the tailor early-trigger fires (before the hard stop). */
export const STALL_ESCALATE_AT = 3;
/**
 * Tool-turn history kept per task (see #history): assistant + tool-result
 * entries. Sized for the longest allowed task (25 iterations, a few
 * calls each); the context manager's token budget is the real valve,
 * this cap only bounds memory in-process.
 */
export const HISTORY_OBSERVATION_CAP = 80;

/**
 * Refusal text of the pre-build question gate (see #questionGateBlock):
 * the model is told the build waits for one short clarifying round, what
 * that round looks like, and that the answers return as decisions pinned
 * to the task. The "Langsung buat saja" option is the user's escape
 * hatch — the ROUND is non-optional, skipping the spec is one click.
 */
export const QUESTION_GATE_DIRECTIVE = [
  'Build paused: this creation request is underspecified, so one short clarifying round comes before any change to the workspace.',
  'Call ask_user now (at most 4 questions, one call per question) before any write_file/edit_file/create_dir/download_file/run_command/spawn_subagent. Ask only what changes the result: for an app or website, which entities/features, where data is stored, who uses it (roles, login or not), and how it should look (style, layout). Always include one option labelled exactly "Langsung buat saja" so the user can skip the round and have you build immediately.',
  'The answers return as the user\'s decisions and ride into this task\'s constraints — build to them. Reads stay available meanwhile; explore the workspace first if a question can be answered from it instead of asking.',
].join('\n');

/** Flatten a run_command call into the executed command line, for output-compression family detection. Defensive: odd arg shapes yield just the command name. */
export function commandLineForCall(call: ToolCall): string {
  const args = (call.args ?? {}) as { command?: unknown; args?: unknown };
  const parts: string[] = [];
  if (typeof args.command === 'string') parts.push(args.command);
  if (Array.isArray(args.args)) {
    for (const arg of args.args) if (typeof arg === 'string') parts.push(arg);
  }
  return parts.join(' ');
}

export type AgentLoopOptions = {
  provider: LLMProvider;
  bus: EventBus;
  store: TaskStore;
  interpreter?: TaskInterpreter;
  planner?: Planner;
  context?: ContextManager;
  observe?: ObservationHandler;
  stopPolicy?: StopPolicy;
  executeTool?: ToolExecutor;
  validator?: Validator;
  tools?: import('../providers/llm/types.ts').ToolDefinition[];
  /** Per-request model options; `timeout_ms` overrides the provider default. */
  chatOptions?: import('../providers/llm/types.ts').ChatOptions;
  mode?: import('../contracts.ts').AgentMode;
  modeController?: ModeController;
  autoApprove?: boolean;
  /** Surface provider/interpreter thought text as THOUGHT events. Default: on. */
  thinking?: boolean;
  /**
   * Stream model text as MODEL_TEXT_DELTA events while the turn is in
   * flight (the Web renders it live; the finished message still lands
   * as MODEL_REQUEST_FINISHED + THOUGHT). The turn itself is assembled
   * from the stream, so tool calls survive. Default: off — surfaces
   * that render per-turn blocks (CLI) keep the old rhythm.
   */
  streamText?: boolean;
  /** Context-window token budget for the meter + condensing. Default 128000. */
  contextLimitTokens?: number;
  /** Condense older tool outputs when over 70% of the context limit. Default: on. */
  condense?: boolean;
  /**
   * Hard caps + spill files for tool outputs before they enter the model
   * context (head+tail kept, full text under the task store). Defaults:
   * 50k chars / 2k lines, spill on — see agent/tool-output.ts.
   */
  toolOutput?: Partial<ToolOutputLimits>;
  /**
   * RTK-style semantic compression of `run_command` output before shaping
   * (agent/output-compression.ts): noisy command dumps are filtered per
   * command family, failures + the exit code stay verbatim, and the raw
   * text is spilled to the task store. Default: on. When off, command
   * output reaches shaping byte-identical.
   */
  outputCompression?: boolean;
  /**
   * Capability tiers per model (tailor suite): stamped onto request events
   * (`tier`) and used for phase routing inside a model pool.
   */
  modelTiers?: Record<string, ModelTier>;
  /**
   * Quality escalation (tailor suite): when validation fails and a weaker
   * pool model is driving, pin the rest of the task to the pool's strongest
   * model (at most once per task). Default on; DAEDALUS_QUALITY_ESCALATION=off
   * disables. No-op without a multi-model pool.
   */
  qualityEscalation?: boolean;
  /**
   * Tailor early-trigger (optional insurance): when the anti-loop guard
   * warns or the stall counter crosses its threshold, pin the rest of
   * the task to the pool's strongest model ONCE (TAILOR_ESCALATED)
   * instead of waiting for a validation failure. Default off at this
   * layer; the runtime wires it from settings.tailor.earlyEscalation.
   * No-op without a multi-model pool with a stronger model available —
   * never spends on a model the user did not configure.
   */
  earlyEscalation?: boolean;
  /**
   * Per-task cumulative INPUT-token budget (provider-reported usage;
   * context estimates when the provider reports none). At the budget
   * the task stops as partial with the spend stated, instead of
   * burning on — the incident run reached 264,722 input tokens over 14
   * requests before a human stopped it. 0/undefined disables.
   */
  inputTokenBudget?: number;
  /**
   * Pre-build question gate: a creation-shaped, underspecified brief
   * (agent/scaffold.ts questionGateAppliesToGoal) in Auto/Manual mode
   * may not mutate anything until one ask_user round has completed —
   * enforced here, not merely suggested in the prompt, so a strong
   * model can no longer spend a whole run building its own guess of
   * what the user wanted. Default off at this layer; the runtime wires
   * it from settings.questionGate (on by default).
   */
  questionGate?: boolean;
  /**
   * Hard-pause seam (loop breaker): after the same call has been
   * repeated 5 times despite warning + suppression, the loop asks the
   * host whether to continue (re-arms the breaker) or stop (the task
   * ends partial). Unwired = stop, so an unattended loop fails fast
   * instead of burning turns. Time spent waiting on the answer is not
   * model time and consumes no budget.
   */
  onLoopHardPause?: (info: { taskId: string; tool: string; repeats: number; signature: string }) => Promise<'continue' | 'stop'>;
  /**
   * Drain pending system notices for a task (background-subagent results
   * the runtime queued since the last turn). Drained once per step and
   * appended to the next request as user-role notes, the same carriage as
   * anti-loop guidance.
   */
  noticesFor?: (taskId: string) => string[];
};


type ModelFailure = {
  provider: string;
  model?: string;
  modelsTried: string[];
  error: string;
  reason: string;
  kind: LLMErrorKind;
  timeoutMs?: number;
  consecutive: number;
};

export class AgentLoop {
  readonly #provider: LLMProvider;
  readonly #bus: EventBus;
  readonly #store: TaskStore;
  readonly #interpreter: TaskInterpreter;
  readonly #planner: Planner;
  readonly #context: ContextManager;
  readonly #observe: ObservationHandler;
  readonly #stopPolicy: StopPolicy;
  readonly #executeTool: ToolExecutor;
  readonly #validator?: Validator;
  readonly #tools?: import('../providers/llm/types.ts').ToolDefinition[];
  readonly #chatOptions?: import('../providers/llm/types.ts').ChatOptions;
  readonly #modeController: ModeController;
  readonly #thinking: boolean;
  readonly #streamText: boolean;
  readonly #contextLimitTokens: number;
  readonly #condense: boolean;
  readonly #toolOutputLimits: ToolOutputLimits;
  readonly #outputCompression: boolean;
  readonly #modelTiers: Record<string, ModelTier>;
  readonly #qualityEscalation: boolean;
  readonly #earlyEscalation: boolean;
  readonly #inputTokenBudget: number;
  readonly #questionGate: boolean;
  readonly #onLoopHardPause?: AgentLoopOptions['onLoopHardPause'];
  readonly #noticesFor?: (taskId: string) => string[];
  readonly #spillCounters = new Map<string, number>();
  readonly #loopGuards = new Map<string, LoopGuard>();
  readonly #pendingGuidance = new Map<string, string>();
  readonly #modelFailures = new Map<string, ModelFailure>();
  /** Tasks that have executed at least one mutating tool (phase routing: edit). */
  readonly #taskMutated = new Set<string>();
  /** Tasks whose model was already escalated once (escalation cap). */
  readonly #escalatedTasks = new Set<string>();
  /**
   * Images a `view_image` call attached for the task's NEXT model request
   * (drained in `step`, like notices: exactly once, as a user-role image
   * message). The bytes never travel inside a ToolResult past
   * `#recordToolResult`, so the event log, persisted state, and CLI
   * transcript only ever see the tool's one-line placeholder output.
   */
  readonly #pendingImages = new Map<string, Array<{ source: string; path: string; mime: string; dataUrl: string }>>();
  /** File paths each task has mutated (validation check scoping). */
  readonly #changedFiles = new Map<string, Set<string>>();
  /**
   * Task-target anchor per task (agent/scaffold.ts deriveTaskTargetDir),
   * resolved lazily and cached; absent = unanchored (pre-anchor
   * semantics). Drives write confinement, gate v2, and validation
   * scoping for the task.
   */
  readonly #targets = new Map<string, string>();
  /** Outside-target paths each anchored task has been blocked from writing (ask_user exception candidates). */
  readonly #blockedOutside = new Map<string, Set<string>>();
  /** Outside-target paths the user approved via ask_user per task (confinement exceptions). */
  readonly #targetExceptions = new Map<string, Set<string>>();
  /** Tasks owing a question-gate round (evaluated once, like the target anchor). */
  readonly #questionGates = new Map<string, boolean>();
  /** Tasks whose question-gate round has completed (the latch outstanding mutations wait on). */
  readonly #questionRoundsDone = new Set<string>();
  /**
   * Completion-gate evidence per task: successful run_command executions
   * (shell-created files never appear as per-file changes) and whether the
   * task delegated (children's ledgers belong to the runtime layer).
   */
  readonly #commandsSucceeded = new Map<string, number>();
  /** Most recent failed run_command per task, one line, for gate evidence. */
  readonly #lastCommandFailure = new Map<string, string>();
  readonly #delegatedTasks = new Set<string>();
  /** Creation-shaped tasks that already spent their one create-the-files repair turn. */
  readonly #creationRepairs = new Set<string>();
  /** Slide tasks with a successful export_deck on record (completion evidence for the slide gate). */
  readonly #slideExports = new Set<string>();
  /** Slide tasks that performed deck-building work this task (the slide gate's trigger evidence). */
  readonly #slideDeckWork = new Set<string>();
  /** Slide tasks that already spent their one export-the-deck repair turn. */
  readonly #slideExportRepairs = new Set<string>();
  /** Consecutive provider timeouts per task; the 2nd in a row fails the turn (provider_timeout). */
  readonly #consecutiveTimeouts = new Map<string, number>();
  /**
   * Last validation failure per task (anti-thrash): when the identical
   * failure repeats with no mutation in between, the recovery budget is
   * not spent again — the task finishes partial instead of burning turns.
   */
  readonly #validationStalls = new Map<string, { signature: string; changedSince: boolean }>();
  /** Plan tasks that already spent their one write-the-plan repair turn. */
  readonly #planRepairs = new Set<string>();
  /**
   * Ranges each task has already been SERVED in full by read_file /
   * list_dir (path → line-numbered lines), with the condensed-message
   * count at serve time. A re-read whose lines are all recorded with
   * identical content is answered with a short stub instead of
   * re-emitting the whole file into history (the incident's 8 identical
   * reads). The stub's wording follows the condensing clock: while the
   * earlier copy is still in context it says so; once condensing has
   * pushed it out, it says that instead and steers to a narrow range —
   * the record itself is never forgotten on condensing, because
   * forgetting re-served whole files and fed the re-read death spiral.
   * Recording happens only when the model actually received the full
   * text: a shaped/truncated serve records nothing, so a range the
   * model only partially received is never stubbed.
   */
  readonly #servedReads = new Map<string, Map<string, { lines: Map<number, string>; totalLines: number; condensedAtServe: number; listingText?: string }>>();
  /** Condensed-tool-message count in each task's latest built request. */
  readonly #condensedCounts = new Map<string, number>();
  /**
   * Tool-turn history per task (assistant tool-call messages + their
   * results, in order), handed to the context manager on every step so a
   * file read on an earlier turn is still in front of the model on later
   * turns. Before this, each request carried only the single latest
   * result (`last_observation`): a file read two turns ago was genuinely
   * gone from the model's view, so re-reading it was rational, and two
   * files could never be compared side by side (the tesvite CSS loop:
   * App.tsx and App.css were never in context at the same time). The
   * context manager truncates each result and its compact pass keeps the
   * newest ones within budget — this list is the memory, those are the
   * valves. Capped so a runaway task cannot grow it without bound; the
   * trim never leaves a tool result orphaned from its assistant message.
   */
  readonly #history = new Map<string, Observation[]>();
  /** Per-signature call counts across the whole task (the breaker ladder). */
  readonly #callCounts = new Map<string, Map<string, number>>();
  /** Per-signature suppression counts (directive at 2, hard-pause at 5 total). */
  readonly #suppressCounts = new Map<string, Map<string, number>>();
  /** Consecutive non-progress tool results per task (the stall backstop). */
  readonly #stalls = new Map<string, number>();
  /** Observation fingerprints each task has already seen (progress = a NEW one). */
  readonly #seenObservations = new Map<string, Set<string>>();
  /** Cumulative input tokens per task (usage-reported or estimated). */
  readonly #inputTokens = new Map<string, number>();
  /** Tasks with a pending hard-stop (stall / pause-stop / token budget). */
  readonly #hardStops = new Map<string, { reason: string; detail: string }>();
  /**
   * Causes whose hard stop must not fire while a hard-pause question is
   * pending user input (live bug, 2026-10-07): usage accounting and the
   * stall backstop record the stop inside the step, while the same step
   * may go on to ask the user how to proceed. Applying the stop under
   * the pending card ends the task behind the user's back and leaves a
   * live-looking card whose answers then fail. Deferring both causes
   * until the question settles means Continue re-arms the repeated
   * call, the loop top re-checks, and a still-blown budget then ends
   * the task partial with the reason stated — never a dead card. Only
   * while a question is actually pending, and only these two reasons:
   * the gate cannot outlive the question (see #pendingQuestions).
   */
  readonly #DEFERRED_HARD_STOP_REASONS = new Set(['input_token_budget', 'no_progress']);
  /** Tasks with a hard-pause question awaiting the user right now; resolves when it settles. */
  readonly #pendingQuestions = new Map<string, Promise<void>>();
  #cancelled = new Set<string>();
  readonly #invalidActions = new Map<string, number>();

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#bus = options.bus;
    this.#store = options.store;
    this.#interpreter = options.interpreter ?? { interpret: (input, o) => interpretTask(input, o) };
    this.#planner = options.planner ?? { createPlan: (s) => createPlan(s), replan: (s, c, o) => replan(s, c, o) };
    this.#context = options.context ?? new DefaultContextManager();
    this.#observe = options.observe ?? { handle: (o, s) => handleObservation(o, s) };
    const policy = options.stopPolicy ?? { max_iterations: 25, max_errors: 5 };
    // The no-progress stop stays as the final backstop, but with a higher
    // threshold than before: the LoopGuard now gets the first chance to talk
    // a looping model out of its rut (warn → suppress → guide).
    this.#stopPolicy = { ...policy, conditions: [noProgressCondition(6), ...(policy.conditions ?? [])] };
    this.#executeTool = options.executeTool ?? (async (call) => ({ call_id: call.id, status: 'ok', output: `stubbed ${call.tool}`, truncated: false, meta: {} }));
    this.#validator = options.validator;
    this.#tools = options.tools;
    this.#chatOptions = options.chatOptions;
    this.#modeController = options.modeController ?? new ModeController(options.mode ?? 'auto', options.autoApprove ?? false);
    this.#thinking = options.thinking !== false;
    this.#streamText = options.streamText === true;
    this.#contextLimitTokens = options.contextLimitTokens && options.contextLimitTokens > 0 ? options.contextLimitTokens : 128_000;
    this.#condense = options.condense !== false;
    this.#toolOutputLimits = resolveToolOutputLimits(options.toolOutput);
    this.#outputCompression = options.outputCompression !== false;
    this.#modelTiers = options.modelTiers ?? {};
    this.#qualityEscalation = options.qualityEscalation !== false;
    this.#earlyEscalation = options.earlyEscalation === true;
    this.#inputTokenBudget = typeof options.inputTokenBudget === 'number' && options.inputTokenBudget > 0 ? Math.floor(options.inputTokenBudget) : 0;
    this.#questionGate = options.questionGate === true;
    this.#onLoopHardPause = options.onLoopHardPause;
    this.#noticesFor = options.noticesFor;
  }

  get modeController(): ModeController {
    return this.#modeController;
  }

  stop(taskId: string): void {
    this.#cancelled.add(taskId);
  }

  async run(input: string | TaskSpec): Promise<TaskState> {
    const spec = typeof input === 'string' ? await this.#interpreter.interpret(input) : input;
    try {
      return await this.#runTask(spec);
    } finally {
      this.#loopGuards.delete(spec.id);
      this.#pendingGuidance.delete(spec.id);
      this.#pendingImages.delete(spec.id);
      this.#modelFailures.delete(spec.id);
      this.#spillCounters.delete(spec.id);
      this.#taskMutated.delete(spec.id);
      this.#escalatedTasks.delete(spec.id);
      this.#changedFiles.delete(spec.id);
      this.#targets.delete(spec.id);
      this.#blockedOutside.delete(spec.id);
      this.#targetExceptions.delete(spec.id);
      this.#questionGates.delete(spec.id);
      this.#questionRoundsDone.delete(spec.id);
      this.#validationStalls.delete(spec.id);
      this.#planRepairs.delete(spec.id);
      this.#commandsSucceeded.delete(spec.id);
      this.#lastCommandFailure.delete(spec.id);
      this.#delegatedTasks.delete(spec.id);
      this.#creationRepairs.delete(spec.id);
      this.#slideExports.delete(spec.id);
      this.#slideDeckWork.delete(spec.id);
      this.#slideExportRepairs.delete(spec.id);
      this.#consecutiveTimeouts.delete(spec.id);
      this.#servedReads.delete(spec.id);
      this.#history.delete(spec.id);
      this.#condensedCounts.delete(spec.id);
      this.#callCounts.delete(spec.id);
      this.#suppressCounts.delete(spec.id);
      this.#stalls.delete(spec.id);
      this.#seenObservations.delete(spec.id);
      this.#inputTokens.delete(spec.id);
      this.#hardStops.delete(spec.id);
    }
  }

  async #runTask(spec: TaskSpec): Promise<TaskState> {
    if (spec.mode) this.#modeController.set(spec.mode);
    let state: TaskState = { ...spec, mode: spec.mode ?? this.#modeController.mode, turns: 0, plan: { id: `${spec.id}-plan`, task_id: spec.id, steps: [], version: 0, status: 'draft' }, steps: [], status: 'active' };
    await this.#emit(state.id, undefined, 'TASK_STARTED', { spec });
    this.#store.saveState(state.id, state);
    const plan = await this.#planner.createPlan(spec);
    state = { ...state, plan, steps: plan.steps };
    // The mode rides along so renderers can tell a Plan-mode deliverable
    // (the plan IS the output) from an execution plan.
    await this.#emit(state.id, undefined, 'PLAN_CREATED', { plan, mode: state.mode });
    this.#store.saveState(state.id, state);
    // Task-target anchor (agent/scaffold.ts deriveTaskTargetDir): a
    // creation task with a declared target directory is stamped now so
    // write confinement, completion gate v2, and validation scoping all
    // share one answer for the whole run; the stamp on state is how the
    // final report names it. Derivation is conservative — no declared
    // folder, no anchor.
    const anchor = this.#targetDirFor(state);
    if (anchor && state.target_dir !== anchor) {
      state = { ...state, target_dir: anchor };
      this.#store.saveState(state.id, state);
    }
    // Session anchor (chat follow-ups): a non-creation task in a
    // conversation that inherited the session's recorded target gets one
    // directive up front naming its working folder — short follow-ups
    // name no folder, and without this the model resolved file names
    // against the whole workspace (the tesvite CSS-loop incident: it
    // read the framework's own daedalus-web/src/App.tsx instead of
    // tesvite/src/App.tsx, repeatedly, until the token budget died).
    if (anchor && state.conversation_id && !detectCreationGoal(state.goal, state.done_criteria).creation) {
      this.#pendingGuidance.set(state.id, sessionAnchorDirective(anchor));
    }
    let iteration = 0;
    let errors = 0;
    let validationFailures = 0;
    const validationRecoveryLimit = Math.max(1, Math.min(3, this.#stopPolicy.max_errors));
    for (;;) {
      if (this.#cancelled.has(state.id) || this.#store.isCancelRequested(state.id)) { state = { ...state, status: 'failed', last_error: 'aborted' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'aborted' }); this.#store.saveState(state.id, state); return state; }
      // Hard stops (stall backstop, hard-pause stop, input-token
      // budget): the task ends as failed-with-reason here; the runtime
      // reports these as partial with the detail as evidence — stopping
      // fast and honestly beats burning more turns.
      const hardStop = this.#hardStops.get(state.id);
      if (hardStop) {
        const pendingQuestion = this.#pendingQuestions.get(state.id);
        if (pendingQuestion && this.#DEFERRED_HARD_STOP_REASONS.has(hardStop.reason)) {
          // The token budget (or stall backstop) crossed while a
          // hard-pause question is pending user input: do not end the
          // task under the card. Wait for the answer, then re-check on
          // the next pass — Continue with the budget still blown ends
          // the task right here, partial, with the reason stated.
          await pendingQuestion;
          continue;
        }
        state = { ...state, status: 'failed', last_error: hardStop.reason, last_observation: hardStop.detail };
        await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: hardStop.reason, detail: hardStop.detail });
        this.#store.saveState(state.id, state);
        return state;
      }
      const stop = evaluateStopConditions({ ...state, }, iteration, { ...this.#stopPolicy, max_errors: this.#stopPolicy.max_errors });
      if (errors >= this.#stopPolicy.max_errors) {
        const failure = this.#modelFailures.get(state.id);
        const errorSummary = failure ? summarizeModelFailure(failure, this.#stopPolicy.max_errors) : undefined;
        state = { ...state, status: 'failed', last_error: 'max_errors' };
        await this.#emit(state.id, undefined, 'TASK_COMPLETED', {
          state,
          outcome: 'failed',
          reason: 'max_errors',
          ...(errorSummary ? { error_summary: errorSummary, model_error: failure } : {}),
        });
        this.#store.saveState(state.id, state);
        return state;
      }
      if (stop === 'completed' || this.#done(state)) {
        // Plan-document guarantee: the loop may look "done" (steps checked
        // off, a closing reply) while the plan FILE — plan mode's actual
        // deliverable — was never written. Give the model exactly one
        // repair turn whose only job is writing it; if it still has not,
        // the runtime assembles the document deterministically at close.
        if (
          state.mode === 'plan'
          && !this.#planRepairs.has(state.id)
          && !hasPlanDocument(this.#changedFiles.get(state.id) ?? [], 'plan.md')
        ) {
          this.#planRepairs.add(state.id);
          await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: 'plan_document_missing', strategy: 'write_plan_document', attempt: 1 });
          const steps = reopenLastCompletedStep(state.steps);
          state = {
            ...state,
            status: 'active',
            steps,
            plan: { ...state.plan, steps, status: 'active' },
            last_error: undefined,
            last_observation: planDocumentRepairDirective({
              goal: state.goal,
              decisions: planDecisionsFromEvents(this.#store.replay(state.id)),
            }),
          };
          this.#store.saveState(state.id, state);
          continue;
        }
        let completed = true;
        if (this.#validator && completed) {
          await this.#emit(state.id, undefined, 'VALIDATION_STARTED', { task_id: state.id });
          const changedFiles = [...(this.#changedFiles.get(state.id) ?? [])];
          // Anchored tasks validate inside their declared target: the
          // validator runs the target subproject's own scripts from its
          // directory, never the workspace root's (see ValidatorOptions
          // targetDir). Re-derived here so a folder the task itself
          // created mid-run anchors completion too; the fresh stamp
          // rides into the final report via state.
          const targetDir = this.#targetDirFor(state);
          if (targetDir && state.target_dir !== targetDir) {
            state = { ...state, target_dir: targetDir };
          }
          const result = await this.#validator.validate({
            workspaceRoot: state.repo_path,
            ...(changedFiles.length > 0 ? { changedFiles } : {}),
            ...(targetDir ? { targetDir } : {}),
          });
          const gate = completionGate(result, undefined);
          completed = gate.complete;
          // Anti-thrash: when the identical validation failure repeats with
          // no mutation since the previous attempt, another model retry can
          // only re-derive the same outcome — finish partial now (with the
          // reason on the emitted result) instead of burning the turns.
          let emittedResult = result;
          let identicalRepeat = false;
          if (!gate.complete && validationFailed(result).length > 0) {
            const signature = validationFailureSignature(result);
            const stall = this.#validationStalls.get(state.id);
            identicalRepeat = stall !== undefined && stall.signature === signature && !stall.changedSince;
            if (identicalRepeat) {
              emittedResult = { ...result, note: 'recovery stopped: the identical validation failure repeated with no changes since the previous attempt' };
            } else {
              this.#validationStalls.set(state.id, { signature, changedSince: false });
            }
          }
          await this.#emit(state.id, undefined, gate.complete ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', { result: emittedResult });
          if (!gate.complete) {
            const failing = validationFailed(result);
            const firstFailure = failing[0];
            if (firstFailure && !identicalRepeat) {
              const error = normalizeError(firstFailure);
              validationFailures++;
              await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: error.category, strategy: 'retry', attempt: validationFailures });
              if (validationFailures < validationRecoveryLimit) {
                // Quality escalation (tailor suite): a repair attempt is the
                // most expensive turn to waste on a weak model — if the pool
                // has a stronger one, pin the rest of the task to it.
                await this.#maybeEscalateQuality(state, validationFailures);
                const summary = failing.map((check) => `${check.name}: ${check.summary}`).join('; ');
                const steps = reopenLastCompletedStep(state.steps);
                state = {
                  ...state,
                  status: 'active',
                  steps,
                  plan: { ...state.plan, steps, status: 'active' },
                  last_error: `validation_failed: ${summary}`,
                  last_observation: `Validation failed (${summary}). Fix the workspace, then finish the reopened plan step so validation can run again.`,
                };
                this.#store.saveState(state.id, state);
                continue;
              }
            }
          }
        }
        // Completion gate for creation-shaped goals (agent/scaffold.ts):
        // a task that asked to create something may not finish "done"
        // with zero creation evidence — the incident failure where a
        // Next.js project was reported "Selesai" while nothing existed on
        // disk. First refusal buys exactly one repair turn (the same
        // pattern as the plan-document guarantee); a second empty finish
        // fails the task with reason no_files_created. Non-creation goals
        // (questions run as tasks, investigations, no-change refactors)
        // never reach here.
        if (completed) {
          const refusal = this.#creationRefusal(state);
          if (refusal && !this.#creationRepairs.has(state.id)) {
            this.#creationRepairs.add(state.id);
            await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: refusal.reason, strategy: 'create_files', attempt: 1 });
            const steps = reopenLastCompletedStep(state.steps);
            state = {
              ...state,
              status: 'active',
              steps,
              plan: { ...state.plan, steps, status: 'active' },
              last_error: undefined,
              last_observation: `You marked the task done, but ${refusal.detail}. The goal asks to create something, so finishing now would report success over work that does not exist. Create the files now (for a scaffolded project: run the generator from the scaffold playbook first, then build the requested content into it), then finish the reopened step.`,
            };
            this.#store.saveState(state.id, state);
            continue;
          }
          if (refusal) {
            state = { ...state, status: 'failed', last_error: refusal.reason };
            await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: refusal.reason });
            this.#store.saveState(state.id, state);
            return state;
          }
          // Slide veto at the run-level completion point (steps done +
          // validation settled): a slide task that built a deck is not
          // complete while the deck is unexported, so completion is
          // vetoed — the first veto spends the one export directive
          // (shared with the claim-point gate: a done-claim after it
          // fails there), later vetoes stay silent and simply keep the
          // task working until the export lands or the loop's own stop
          // conditions (budget, stalls, iterations) end it honestly.
          // Failing here instead would kill builds mid-fill, when the
          // model has legitimately not reached the export step yet.
          const slideRefusal = this.#slideExportRefusal(state);
          if (slideRefusal) {
            if (!this.#slideExportRepairs.has(state.id)) {
              this.#slideExportRepairs.add(state.id);
              await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: slideRefusal.reason, strategy: 'export_deck', attempt: 1 });
              state = {
                ...state,
                status: 'active',
                last_error: undefined,
                last_observation: `This task is not complete yet: ${slideRefusal.detail}. Finish filling the deck's content, then export it.`,
              };
              this.#store.saveState(state.id, state);
            }
          } else {
            state = { ...state, status: completed ? 'done' : 'active' };
            await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: completed ? 'success' : 'partial', reason: completed ? 'completed' : 'validation_failed' });
            this.#store.saveState(state.id, state);
            return state;
          }
        } else {
          state = { ...state, status: completed ? 'done' : 'active' };
          await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: completed ? 'success' : 'partial', reason: completed ? 'completed' : 'validation_failed' });
          this.#store.saveState(state.id, state);
          return state;
        }
      }
      if (stop !== undefined) { state = { ...state, status: 'failed', last_error: stop }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: stop }); this.#store.saveState(state.id, state); return state; }
      if (iteration >= this.#stopPolicy.max_iterations) { state = { ...state, status: 'failed', last_error: 'max_iterations' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'max_iterations' }); this.#store.saveState(state.id, state); return state; }
      try {
        state = await this.#syncMode(state);
        state = await this.step(state);
        if (state.status === 'failed') {
          await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: state.last_error });
          this.#store.saveState(state.id, state);
          return state;
        }
        iteration++;
        errors = state.last_error ? errors + 1 : 0;
      } catch (error) {
        errors++;
        state = { ...state, last_error: String(error) };
        if (errors >= this.#stopPolicy.max_errors) { state = { ...state, status: 'failed' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'max_errors' }); this.#store.saveState(state.id, state); return state; }
      }
    }
  }

  async #syncMode(state: TaskState): Promise<TaskState> {
    const nextMode = this.#modeController.mode;
    const previousMode = state.mode ?? nextMode;
    if (previousMode === nextMode) return state;
    const change = this.#modeController.describeChange(previousMode, nextMode);
    await this.#emit(state.id, undefined, 'MODE_CHANGED', {
      from: change.from,
      to: change.to,
      turn_boundary: change.turnBoundary,
      replan_required: change.replanRequired,
    });
    let nextState: TaskState = { ...state, mode: change.to };
    if (change.replanRequired) {
      const plan = await this.#planner.replan(toSpec(nextState), nextState.plan, {
        kind: 'assistant',
        message: { role: 'assistant', content: `mode changed to ${change.to}; replan required` },
      });
      nextState = { ...nextState, plan, steps: plan.steps, last_error: undefined };
      await this.#emit(state.id, undefined, 'REPLAN_CREATED', { plan, reason: `mode_changed_to_${change.to}` });
      await this.#emit(state.id, undefined, 'PLAN_CREATED', { plan });
    }
    this.#store.saveState(state.id, nextState);
    return nextState;
  }

  async step(state: TaskState): Promise<TaskState> {
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnMode = state.mode ?? this.#modeController.mode;
    const visibleTools = this.#tools?.filter((tool) => isToolVisible(turnMode, tool.function.name));
    const built = await this.#context.buildMessages({ ...state, mode: turnMode }, this.#history.get(state.id) ?? [], visibleTools);
    let messages = this.#condense ? condenseToolOutputs(built, { limitTokens: this.#contextLimitTokens }) : built;
    // Track how many tool results condensing has dropped from context:
    // the unchanged-read stub may only claim "already in your context"
    // for serves no new condensing has since overtaken.
    this.#condensedCounts.set(state.id, messages.filter((message) => message.content === CONDENSED_TOOL_OUTPUT).length);
    // The request just built carried each history entry in full, so a
    // long skill body in history has been served: shrink it to a stub
    // now, or every later request re-sends the whole body (up to 16K)
    // and the loop burns its token budget re-reading its own context.
    this.#stubServedSkillBodies(state.id);
    // Anti-loop guidance queued by a previous turn rides along as an extra
    // user note so the model sees the warning in its very next request.
    const guidance = this.#pendingGuidance.get(state.id);
    if (guidance) {
      this.#pendingGuidance.delete(state.id);
      messages = [...messages, { role: 'user', content: guidance }];
    }
    // System notices (background subagent results that landed since the
    // last turn) ride along the same way, drained exactly once.
    const notices = this.#noticesFor?.(state.id) ?? [];
    if (notices.length > 0) {
      messages = [...messages, ...notices.map((content) => ({ role: 'user' as const, content }))];
    }
    // Images the model asked to see (view_image, screenshot): attached as
    // an image_url block on a user message, the same carriage user
    // uploads take in the context manager. Drained exactly once; the
    // matching tool result in the history stays its one-line placeholder.
    const pendingImages = this.#pendingImages.get(state.id);
    if (pendingImages && pendingImages.length > 0) {
      this.#pendingImages.delete(state.id);
      for (const image of pendingImages) {
        const content: ContentBlock[] = [
          { type: 'text', text: `Image attached from ${image.source} (${image.path}, ${image.mime}):` },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ];
        messages = [...messages, { role: 'user' as const, content }];
      }
    }
    const meter = contextMeter(messages, this.#contextLimitTokens);
    // Phase hint (tailor suite): the pool spends strong models on edit and
    // repair turns and fast/balanced ones on exploration. Stamped onto the
    // request events too, so the Web can show which tier served a turn.
    const phase = this.#phaseFor(state);
    await this.#emit(state.id, turnId, 'MODEL_REQUEST_STARTED', { provider: this.#provider.name, messages: messages.length, tools: visibleTools?.length ?? 0, mode: turnMode, phase, ...meter });
    let response;
    try {
      response = this.#streamText
        ? await this.#chatStreamed(state.id, turnId, messages, visibleTools, phase)
        : await this.#provider.chat(messages, visibleTools, { ...this.#chatOptions, phase });
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FINISHED', { message: response.message, usage: response.usage, finish_reason: response.finish_reason, phase, ...this.#servedModelFields(state), ...meter });
      await this.#emitThought(state.id, turnId, response.message);
      this.#modelFailures.delete(state.id);
      this.#consecutiveTimeouts.delete(state.id);
      // Per-task input-token budget: provider-reported usage when the
      // provider reports it, the harness's own context estimate when it
      // does not. At the budget the task stops as partial with the
      // spend stated — a stall must never again reach 264k input
      // tokens over 14 requests before a human intervenes.
      if (this.#inputTokenBudget > 0) {
        const usage = response.usage as { prompt_tokens?: unknown } | undefined;
        const spent = typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
          ? usage.prompt_tokens
          : meter.context_estimate_tokens;
        const totalInput = (this.#inputTokens.get(state.id) ?? 0) + spent;
        this.#inputTokens.set(state.id, totalInput);
        if (totalInput >= this.#inputTokenBudget && !this.#hardStops.has(state.id)) {
          await this.#emit(state.id, turnId, 'LOOP_WARNING', {
            tool: '',
            repeats: 0,
            suppressed: false,
            kind: 'token_budget',
            input_tokens: totalInput,
            budget: this.#inputTokenBudget,
          });
          this.#hardStops.set(state.id, {
            reason: 'input_token_budget',
            detail: `input token budget reached: ${totalInput} input tokens spent on this task (budget ${this.#inputTokenBudget}); stopped before burning more`,
          });
        }
      }
    } catch (error) {
      const errorText = formatError(error);
      const kind = classifyLLMError(error);
      const reason = error instanceof LLMAuthError
        ? 'auth'
        : error instanceof LLMContentPolicyError
          ? 'content_policy'
          : modelPoolFailureReason(error);
      const modelsTried = providerAttemptedModels(this.#provider, state);
      const model = providerAttemptedModel(this.#provider, state, modelsTried);
      const timeoutMs = this.#chatOptions?.timeout_ms ?? providerTimeoutMs(this.#provider);
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FAILED', {
        error: errorText,
        error_kind: kind,
        error_reason: reason,
        ...(model ? { model } : {}),
        models_tried: modelsTried,
        ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
        ...meter,
      });
      if (kind === 'fatal') {
        const failure: ModelFailure = {
          provider: this.#provider.name,
          ...(model ? { model } : {}),
          modelsTried,
          error: errorText,
          reason,
          kind,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          consecutive: (this.#modelFailures.get(state.id)?.consecutive ?? 0) + 1,
        };
        return {
          ...state,
          mode: turnMode,
          turns: (state.turns ?? 0) + 1,
          status: 'failed',
          last_error: summarizeFatalModelFailure(failure),
        };
      }
      const failure: ModelFailure = {
        provider: this.#provider.name,
        ...(model ? { model } : {}),
        modelsTried,
        error: errorText,
        reason,
        kind,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        consecutive: (this.#modelFailures.get(state.id)?.consecutive ?? 0) + 1,
      };
      this.#modelFailures.set(state.id, failure);
      // Consecutive-timeout discipline (documented budget interaction):
      // the generic error budget counts ALL consecutive failures and
      // resets on success, but a timeout is not a cheap failure — the
      // identical oversized request goes out again and burns another
      // full timeout window. So timeouts carry a stricter streak cap:
      // the 2nd consecutive timeout fails the turn with the typed
      // provider_timeout reason and no third identical send happens.
      // One exception: when this same failure also exhausts the generic
      // budget, that budget's own path fires (top of the run loop) with
      // its richer summary — the two caps end the run at the same call.
      const timeouts = reason === 'timeout' ? (this.#consecutiveTimeouts.get(state.id) ?? 0) + 1 : 0;
      if (timeouts > 0) this.#consecutiveTimeouts.set(state.id, timeouts);
      else this.#consecutiveTimeouts.delete(state.id);
      if (timeouts >= MAX_CONSECUTIVE_TIMEOUTS && failure.consecutive < this.#stopPolicy.max_errors) {
        return {
          ...state,
          mode: turnMode,
          turns: (state.turns ?? 0) + 1,
          status: 'failed',
          last_error: 'provider_timeout',
        };
      }
      return { ...state, mode: turnMode, turns: (state.turns ?? 0) + 1, last_error: errorText };
    }
    const successfulState: TaskState = { ...state, mode: turnMode, last_error: undefined };
    const action = parseAction(successfulState, response.message);
    if (action.kind === 'stop' && action.reason === 'invalid_action') {
      const canMutate = turnMode === 'auto' || turnMode === 'manual' || turnMode === 'orchestrator';
      const attempts = (this.#invalidActions.get(state.id) ?? 0) + 1;
      this.#invalidActions.set(state.id, attempts);
      if (canMutate && attempts < this.#stopPolicy.max_errors) {
        const directive = 'Invalid model response: the previous reply was not a tool call, done:, replan:, or stop:. Call a concrete tool next (for implementation work use write_file, edit_file, create_dir, or run_command); read-only inspection alone does not complete an implementation step.';
        const updated = { ...successfulState, turns: (state.turns ?? 0) + 1, last_error: undefined, last_observation: directive };
        this.#store.saveState(state.id, updated);
        return updated;
      }
      return { ...successfulState, turns: (state.turns ?? 0) + 1, status: 'failed', last_error: 'invalid_action' };
    }
    if (action.kind === 'complete') {
      this.#invalidActions.delete(state.id);
      // Creation gate at the claim point: an explicit "done:" over zero
      // creation evidence is exactly the fake-Selesai shape, and it can
      // arrive while plan steps are still open (so the steps-done gate
      // below would never see it). One repair directive, then refusal.
      const refusal = this.#creationRefusal({ ...successfulState, mode: turnMode });
      if (refusal && !this.#creationRepairs.has(state.id)) {
        this.#creationRepairs.add(state.id);
        await this.#emit(state.id, turnId, 'RECOVERY_STARTED', { reason: refusal.reason, strategy: 'create_files', attempt: 1 });
        return {
          ...successfulState,
          turns: (state.turns ?? 0) + 1,
          last_observation: `You said done, but ${refusal.detail}. The goal asks to create something, so finishing now would report success over work that does not exist. Create the files now (for a scaffolded project: run the generator from the scaffold playbook first, then build the requested content into it), then say done again.`,
        };
      }
      if (refusal) {
        return { ...successfulState, turns: (state.turns ?? 0) + 1, status: 'failed', last_error: refusal.reason };
      }
      // Slide gate at the same claim point: "done:" over a deck that was
      // never exported is the same fake-Selesai shape, one step later.
      const slideRefusal = this.#slideExportRefusal({ ...successfulState, mode: turnMode });
      if (slideRefusal && !this.#slideExportRepairs.has(state.id)) {
        this.#slideExportRepairs.add(state.id);
        await this.#emit(state.id, turnId, 'RECOVERY_STARTED', { reason: slideRefusal.reason, strategy: 'export_deck', attempt: 1 });
        return {
          ...successfulState,
          turns: (state.turns ?? 0) + 1,
          last_observation: `You said done, but ${slideRefusal.detail}, then say done again.`,
        };
      }
      if (slideRefusal) {
        return { ...successfulState, turns: (state.turns ?? 0) + 1, status: 'failed', last_error: slideRefusal.reason };
      }
      return { ...successfulState, turns: (state.turns ?? 0) + 1, last_observation: action.summary };
    }
    if (action.kind === 'stop') {
      if (action.reason === 'completed') return { ...successfulState, turns: (state.turns ?? 0) + 1, status: 'done' };
      return { ...successfulState, turns: (state.turns ?? 0) + 1, status: 'failed', last_error: action.reason };
    }
    if (action.kind === 'replan') {
      this.#invalidActions.delete(state.id);
      const previous = successfulState.plan;
      const next = await this.#planner.replan(toSpec(successfulState), previous, { kind: 'assistant', message: response.message });
      await this.#emit(state.id, turnId, 'REPLAN_CREATED', { previous_plan: previous, plan: next, reason: action.reason });
      await this.#emit(state.id, turnId, 'PLAN_CREATED', { plan: next });
      const updated = { ...successfulState, turns: (state.turns ?? 0) + 1, plan: next, steps: next.steps };
      this.#store.saveState(state.id, updated);
      return updated;
    }
    // Execute every tool call in the model's response. Most calls run
    // sequentially (approval/mode checks and edit ordering are per call),
    // but a burst of consecutive spawn_subagent calls in one response runs
    // CONCURRENTLY (cap 3): parallel delegation is the tool's whole point,
    // and serializing it would hand the parent three context rebuilds in a
    // row. Observations are still applied in call order afterwards.
    const rawCalls = response.message.tool_calls ?? [];
    // The tool turn enters the task history before its calls run, so the
    // next request shows the model its own calls alongside the results
    // (see #history): earlier reads stay visible instead of evaporating
    // behind the single latest result.
    if (rawCalls.length > 0) this.#pushHistory(state.id, { kind: 'assistant', message: response.message });
    let current: TaskState = { ...successfulState, turns: (state.turns ?? 0) + 1 };
    const parsedCalls: Array<{ call: ToolCall } | { parseError: ToolResult }> = [];
    for (const rawCall of rawCalls) {
      try {
        const args = JSON.parse(rawCall.function.arguments || '{}') as unknown;
        parsedCalls.push({
          call: {
            id: rawCall.id || `call-${Date.now()}`,
            task_id: state.id,
            turn_id: turnId,
            tool: rawCall.function.name,
            args,
            started_at: new Date().toISOString(),
          },
        });
      } catch {
        parsedCalls.push({
          parseError: {
            call_id: rawCall.id || `call-${Date.now()}`,
            status: 'error' as const,
            output: `invalid JSON arguments for tool ${rawCall.function.name}`,
            truncated: false,
            meta: { tool: rawCall.function.name, mode: turnMode, reason: 'invalid_arguments' },
          },
        });
      }
    }
    let index = 0;
    while (index < parsedCalls.length) {
      const entry = parsedCalls[index]!;
      if ('parseError' in entry) {
        const result = entry.parseError;
        current = { ...this.#observeAndRecord(state, current, result), mode: turnMode, last_tool_call_id: result.call_id, tool_result: result };
        index++;
        continue;
      }
      if (entry.call.tool === SPAWN_SUBAGENT_TOOL_NAME) {
        const group: ToolCall[] = [];
        while (index < parsedCalls.length) {
          const next = parsedCalls[index]!;
          if (!('call' in next) || next.call.tool !== SPAWN_SUBAGENT_TOOL_NAME) break;
          group.push(next.call);
          index++;
        }
        current = group.length > 1
          ? await this.#executeSpawnGroup(state, current, group, turnMode, turnId)
          : await this.#executeToolCall(state, current, group[0]!, turnMode, turnId);
        continue;
      }
      current = await this.#executeToolCall(state, current, entry.call, turnMode, turnId);
      index++;
    }
    this.#invalidActions.delete(state.id);
    this.#store.saveState(state.id, current);
    return current;
  }

  /**
   * Prepare one tool call for execution: announce it, consult the
   * anti-loop guard, and apply the mode gate. Returns either a finished
   * result (denied/suppressed — never executed) or the call to execute.
   */
  async #prepareToolCall(
    state: TaskState,
    call: ToolCall,
    turnMode: AgentMode,
    turnId: string,
  ): Promise<{ result: ToolResult } | { execute: true }> {
    await this.#emit(state.id, turnId, 'TOOL_CALL_STARTED', { call });
    // Anti-loop guard: the 3rd identical (or same-path) call warns
    // (guidance is injected into the next request); further duplicates are
    // suppressed with a cached-repeat result instead of being executed
    // again. Repeat read_skill calls are suppressed immediately with an
    // "already loaded" note so the full skill text is not re-served.
    const guard = this.#guardFor(state);
    const guardCall = guard.observe(call.tool, call.args);
    // Cross-turn per-signature totals (the guard's window slides; the
    // breaker ladder must not forget a call just because other calls
    // interleaved — the incident alternated reads with searches).
    const signature = guardCall.signature;
    const callCounts = this.#countsFor(this.#callCounts, state.id);
    const totalRepeats = (callCounts.get(signature) ?? 0) + 1;
    callCounts.set(signature, totalRepeats);
    if (guardCall.decision !== 'execute') {
      await this.#emit(state.id, turnId, 'LOOP_WARNING', {
        tool: call.tool,
        repeats: guardCall.repeats,
        suppressed: guardCall.decision === 'suppress',
        ...(guardCall.repeatKind ? { repeat_kind: guardCall.repeatKind } : {}),
      });
      this.#pendingGuidance.set(state.id, loopGuidanceNote(call.tool, guardCall.repeats));
      // Tailor early-trigger: a looping task is exactly when a stronger
      // model earns its cost (config-gated, once per task).
      await this.#maybeEscalateEarly(state, 'loop_warning');
    }
    if (isToolCallDenied(turnMode, call.tool, toolCallTargetPath(call.args))) {
      return {
        result: {
          call_id: call.id,
          status: 'denied' as const,
          output: modeDenialMessage(turnMode, call.tool),
          truncated: false,
          meta: { tool: call.tool, mode: turnMode, reason: 'mode_policy' },
        },
      };
    }
    // Breaker hard-pause: the same call a 5th time despite warn +
    // suppress means the model is not recovering on its own. Ask the
    // host (user, via the runtime) whether to continue; a continue
    // re-arms the breaker, a stop — or no host wired — ends the task
    // as partial instead of burning more turns.
    if (guardCall.decision === 'suppress' && totalRepeats >= LOOP_HARD_PAUSE_AT) {
      await this.#emit(state.id, turnId, 'LOOP_WARNING', {
        tool: call.tool,
        repeats: totalRepeats,
        suppressed: true,
        kind: 'hard_pause',
      });
      // While this question is pending user input, budget/stall hard
      // stops stay deferred (see the gate at the top of #runTask): the
      // user decides first, the budget is re-checked after.
      let settleQuestion!: () => void;
      const questionSettled = new Promise<void>((resolve) => { settleQuestion = resolve; });
      this.#pendingQuestions.set(state.id, questionSettled);
      let decision: 'continue' | 'stop' = 'stop';
      try {
        decision = this.#onLoopHardPause
          ? await this.#onLoopHardPause({ taskId: state.id, tool: call.tool, repeats: totalRepeats, signature })
          : 'stop';
      } finally {
        this.#pendingQuestions.delete(state.id);
        settleQuestion();
      }
      if (decision === 'continue') {
        guard.resetCall(call.tool, call.args);
        callCounts.delete(signature);
        this.#countsFor(this.#suppressCounts, state.id).delete(signature);
        this.#stalls.set(state.id, 0);
        this.#pendingGuidance.set(
          state.id,
          `You were paused: ${call.tool} with the same arguments was repeated ${totalRepeats} times with no progress. The user chose to continue. Do NOT repeat that call — take a different action now: the mutating tool for your goal, a different path/command, ask_user, or finish with a plain summary of what is missing.`,
        );
        return { execute: true };
      }
      this.#hardStops.set(state.id, {
        reason: 'loop_hard_pause',
        detail: `stuck: ${call.tool} was repeated ${totalRepeats} times with no progress (same arguments, same result); the task was paused and not resumed`,
      });
      return {
        result: {
          call_id: call.id,
          status: 'denied' as const,
          output: `${loopDirectiveNote(call.tool, totalRepeats)}\nThe task is being paused here rather than burning more turns on the same call.`,
          truncated: false,
          meta: { tool: call.tool, mode: turnMode, reason: 'loop_hard_pause', repeats: totalRepeats, mutating: false },
        },
      };
    }
    if (guardCall.decision === 'suppress') {
      const suppressCounts = this.#countsFor(this.#suppressCounts, state.id);
      const suppressions = (suppressCounts.get(signature) ?? 0) + 1;
      suppressCounts.set(signature, suppressions);
      return {
        result: {
          call_id: call.id,
          // Not an error: the call was answered from the repeat cache.
          // `mutating: false` keeps the observation handler from treating
          // it as implementation progress, and the unchanged observation
          // lets the no_progress backstop remain the final safety. After
          // two suppressions the answer stops being a cached repeat and
          // becomes a directive (a bare stub kept being ignored).
          status: 'ok' as const,
          output: suppressions >= 2
            ? loopDirectiveNote(call.tool, totalRepeats)
            : guardCall.suppressedOutput ?? REPEAT_SUPPRESSED_OUTPUT,
          truncated: false,
          meta: { tool: call.tool, mode: turnMode, reason: 'repeat_suppressed', repeats: guardCall.repeats, mutating: false, ...(guardCall.repeatKind ? { repeat_kind: guardCall.repeatKind } : {}) },
        },
      };
    }
    // Schema validation before dispatch (and before the call can enter
    // history): a router-mangled argument (start_line arriving as the
    // string "3,10") is a typed parse error here — never executed,
    // never silently substituted, counted by the guard above like any
    // other repeat/mistake signal.
    const schema = this.#schemaFor(call.tool);
    if (schema !== undefined) {
      const validation = validateToolCallArguments(call.tool, schema, call.args);
      if (!validation.ok) {
        return {
          result: {
            call_id: call.id,
            status: 'error' as const,
            output: toolCallParseErrorOutput(call.tool, validation, schema),
            truncated: false,
            meta: { tool: call.tool, mode: turnMode, reason: 'tool_call_parse_error', ...(validation.field ? { field: validation.field } : {}), mutating: false },
          },
        };
      }
    }
    // Pre-build question gate: a creation-shaped, underspecified brief
    // in Auto/Manual mode owes the user one ask_user round BEFORE the
    // first call that changes anything (write tools, commands, subagent
    // delegation). Non-optional by design — the incident this answers is
    // a strong model building its own guess end-to-end and the user
    // paying for the corrections. Checked after schema validation (the
    // call is known well-formed) and before target confinement: the
    // requirements conversation precedes every other refusal. Reads and
    // ask_user itself flow freely (explore-first stays possible).
    const gateBlock = this.#questionGateBlock(state, call, turnMode);
    if (gateBlock) return { result: gateBlock };
    // Task-target confinement: an anchored creation task writes inside
    // its declared target only (see #outsideTargetBlock). Checked after
    // schema validation (the path argument is known well-formed) and
    // before dispatch, so a blocked write never reaches the approval
    // layer — approvals decide WHETHER a write may happen at all, the
    // anchor decides WHERE this task's writes belong.
    const confinement = this.#outsideTargetBlock(state, call, turnMode);
    if (confinement) return { result: confinement };
    return { execute: true };
  }

  /** Per-task counter map helper (call/suppression ladders). */
  #countsFor(store: Map<string, Map<string, number>>, taskId: string): Map<string, number> {
    let counts = store.get(taskId);
    if (!counts) {
      counts = new Map<string, number>();
      store.set(taskId, counts);
    }
    return counts;
  }

  /** The declared input schema for a tool, when the loop knows it. */
  #schemaFor(toolName: string): unknown {
    const tool = (this.#tools ?? []).find((entry) => entry.function.name === toolName);
    return tool?.function.parameters;
  }

  /**
   * Record one finished tool call: phase/validation bookkeeping, output
   * shaping, the TOOL_CALL_FINISHED event, and the observation fold into
   * state. Shared by the sequential and the parallel spawn paths so both
   * observe identical semantics.
   */
  async #recordToolResult(
    state: TaskState,
    current: TaskState,
    call: ToolCall,
    result: ToolResult,
    turnMode: AgentMode,
    turnId: string,
  ): Promise<TaskState> {
    // Phase routing bookkeeping: once a task has actually mutated the
    // workspace, its later turns are edit turns and earn strong models.
    if (result.meta?.mutating === true) this.#taskMutated.add(state.id);
    // Completion-gate evidence (see #creationRefusal): a successful
    // run_command is the only trace shell-driven creation leaves, and a
    // delegated task's real ledger lives with its children.
    if (call.tool === 'run_command' && result.status === 'ok') {
      this.#commandsSucceeded.set(state.id, (this.#commandsSucceeded.get(state.id) ?? 0) + 1);
    }
    if (call.tool === 'run_command' && result.status !== 'ok') {
      this.#lastCommandFailure.set(state.id, summarizeCommandFailure(commandLineForCall(call), result.output ?? ''));
    }
    if (call.tool === SPAWN_SUBAGENT_TOOL_NAME) this.#delegatedTasks.add(state.id);
    // ask_user answers can sanction an outside-target exception (see
    // #grantTargetExceptions): the grant lands in the loop's ledger
    // immediately, so the very next write attempt already sees it, and
    // is threaded onto the returned state below so the final report can
    // name the excepted paths.
    const grantedExceptions = call.tool === ASK_USER_TOOL_NAME ? this.#grantTargetExceptions(state, call, result) : undefined;
    // Question-gate bookkeeping on the same event: a COMPLETED ask_user
    // round (answered, or timed out into proceed-on-assumptions — the
    // question was offered and waited, which is what the gate demands)
    // releases the mutation gate for the rest of the task, and an
    // answered question's answer is pinned onto the state: appended to
    // constraints it rides into every later request, and as
    // clarifying_answers it lands in the final report's evidence.
    if (call.tool === ASK_USER_TOOL_NAME && result.status === 'ok'
      && (result.meta?.outcome === 'answered' || result.meta?.outcome === 'timeout')) {
      this.#questionRoundsDone.add(state.id);
    }
    const clarification = call.tool === ASK_USER_TOOL_NAME && result.meta?.outcome === 'answered'
      ? this.#clarificationFor(state, call, result)
      : undefined;
    if (result.meta?.mutating === true) {
      // Validation bookkeeping: remember which files the task changed
      // (checks are scoped to their packages) and that this failure is
      // no longer "unchanged" for the anti-thrash guard below.
      const stall = this.#validationStalls.get(state.id);
      if (stall) stall.changedSince = true;
      const changedPath = (call.args as { path?: unknown } | undefined)?.path;
      if (typeof changedPath === 'string' && changedPath.length > 0) {
        let files = this.#changedFiles.get(state.id);
        if (!files) {
          files = new Set<string>();
          this.#changedFiles.set(state.id, files);
        }
        files.add(changedPath);
      }
    }
    // Image carriage: lift the image payload out of the result before
    // it is shaped, emitted, or persisted. The contract is the meta key,
    // not the tool name — view_image started it, screenshot (and any
    // future image-producing tool) joins by returning the same
    // image_data_url meta. The bytes queue for the next model request
    // (see `step`); from here on the result is only the tool's
    // placeholder text, so the event log, the saved task state, and
    // every transcript render the placeholder — never a base64 dump.
    let safeResult = result;
    if (result.status === 'ok' && typeof result.meta?.image_data_url === 'string'
      && typeof result.meta?.image_mime === 'string' && result.meta.image_mime.startsWith('image/')) {
      const pending = this.#pendingImages.get(state.id) ?? [];
      pending.push({
        source: call.tool,
        path: typeof result.meta.image_path === 'string' ? result.meta.image_path : 'image',
        mime: typeof result.meta.image_mime === 'string' ? result.meta.image_mime : 'image/*',
        dataUrl: result.meta.image_data_url,
      });
      while (pending.length > MAX_PENDING_VIEWED_IMAGES) pending.shift();
      this.#pendingImages.set(state.id, pending);
      const meta: Record<string, unknown> = { ...result.meta, image_attached: true };
      delete meta.image_data_url;
      safeResult = { ...result, meta };
    }
    // Output compression (RTK-style filters, agent/output-compression.ts)
    // runs before shaping, on foreground run_command results only: noisy
    // command dumps (install logs, test suites, git spew) are filtered
    // per command family so the model spends its context on signal.
    // Failure lines and the exit code stay verbatim in the note that
    // follows the compressed text, and the raw output is spilled to the
    // task store — like shaping, compression never destroys text, it
    // only moves where the full text lives. Background-job starts are
    // one-liners and command_status tails are already bounded, so both
    // stay uncompressed.
    let compression: (CommandOutputCompression & { spillPath?: string }) | undefined;
    let modelFacingOutput = safeResult.output;
    if (this.#outputCompression && call.tool === 'run_command' && safeResult.meta?.background !== true) {
      const attempt = compressCommandOutput({
        commandLine: commandLineForCall(call),
        output: safeResult.output,
        status: safeResult.status,
        exitCode: typeof safeResult.meta?.exit_code === 'number' ? safeResult.meta.exit_code : null,
      });
      if (attempt.compressed) {
        const spillPath = await writeSpillFile(this.#spillPathFor(state.id, call.tool), safeResult.output);
        const exitCode = typeof safeResult.meta?.exit_code === 'number' ? safeResult.meta.exit_code : null;
        const note = `[run_command output compressed for context: ${attempt.rawChars} chars → ${attempt.compressedChars} chars (${attempt.family} filter; failures kept verbatim${exitCode !== null ? `; exit code ${exitCode}` : ''}); ${
          spillPath
            ? `complete text saved to ${spillPath} — read it with read_file using offset/limit if you need what was summarized`
            : 'complete text not saved (spill unavailable)'
        }]`;
        modelFacingOutput = `${attempt.text}\n${note}`;
        compression = { ...attempt, ...(spillPath ? { spillPath } : {}) };
      }
    }
    // Shape the result before it enters the model context (the single
    // choke point every tool's output passes through): over-cap output is
    // kept head+tail with the full text spilled to the task store, so a
    // huge command dump or minified-file grep can neither flood the next
    // request nor lose its tail, where failures summarize. The event log
    // keeps the executor's untouched result — only the model-facing copy
    // is shortened — and the event gains additive truncation flags so the
    // Web can show that shaping happened.
    const shaped = await shapeToolOutput(modelFacingOutput, {
      tool: call.tool,
      limits: this.#toolOutputLimits,
      spillPathFor: (tool) => this.#spillPathFor(state.id, tool),
    });
    const modelResult: ToolResult = shaped.truncated || compression
      ? {
          ...safeResult,
          output: shaped.output,
          truncated: shaped.truncated,
          meta: {
            ...safeResult.meta,
            ...(compression
              ? {
                  output_compressed: true,
                  output_compression_family: compression.family,
                  output_raw_chars: compression.rawChars,
                  output_compressed_chars: compression.compressedChars,
                  ...(compression.spillPath ? { output_compression_spill_path: compression.spillPath } : {}),
                }
              : {}),
            ...(shaped.truncated
              ? {
                  output_truncated: true,
                  ...(shaped.spillPath ? { spill_path: shaped.spillPath } : {}),
                  output_original_chars: shaped.totalChars,
                  output_original_lines: shaped.totalLines,
                  output_shown_lines: shaped.shownLines,
                }
              : {}),
          },
        }
      : safeResult;
    // Unchanged-read stub: a read_file/list_dir whose content the model
    // was already served in full (and which condensing has not since
    // dropped from context) is answered with a short stub instead of
    // re-emitting the whole file into history. Only when the model-facing
    // text is the executor's full text — a shaped serve records nothing,
    // so a partially-received range is never claimed as "in context".
    let finalResult = modelResult;
    let stubbed = false;
    if ((call.tool === 'read_file' || call.tool === 'list_dir') && safeResult.status === 'ok' && modelResult.output === safeResult.output) {
      const stub = this.#readStubFor(state.id, call, safeResult);
      if (stub) {
        stubbed = true;
        finalResult = { ...safeResult, output: stub, truncated: false, meta: { ...safeResult.meta, unchanged_stub: true } };
      }
    }
    await this.#emit(state.id, turnId, 'TOOL_CALL_FINISHED', {
      call,
      result: safeResult,
      ...(shaped.truncated ? { output_truncated: true, ...(shaped.spillPath ? { spill_path: shaped.spillPath } : {}) } : {}),
      ...(stubbed ? { unchanged_stub: true } : {}),
      ...(compression
        ? {
            output_compressed: true,
            output_compression_family: compression.family,
            output_raw_chars: compression.rawChars,
            output_compressed_chars: compression.compressedChars,
          }
        : {}),
    });
    // A skill body entering the context is a first-class activation:
    // recorded once per real load (repeat-suppressed read_skill calls
    // return early above and never reach this point), so UIs can show
    // which skill fired, from where, and at whose request.
    if (call.tool === 'read_skill' && result.status === 'ok' && typeof result.meta?.skill === 'string') {
      await this.#emit(state.id, turnId, 'SKILL_LOADED', {
        name: result.meta.skill,
        origin: typeof result.meta.origin === 'string' ? result.meta.origin : 'workspace',
        via: 'agent',
        ...(typeof result.meta.source === 'string' ? { source: result.meta.source } : {}),
      });
    }
    // Slide completion evidence: a successful export is the deliverable
    // of a slide task, so the completion gate below can tell "deck built"
    // apart from "deck delivered". Deck-building calls are the gate's
    // trigger: a slide task that only read the deck (or asked about it)
    // is never export-gated.
    if (result.status === 'ok' && SLIDE_DECK_WORK_TOOLS.has(call.tool)) {
      this.#slideDeckWork.add(state.id);
    }
    if (call.tool === 'export_deck' && result.status === 'ok') {
      this.#slideExports.add(state.id);
    }
    // Stall bookkeeping: progress is a file change, a successful
    // command, a download, or a NEW observation (a result this task has
    // not already seen). Anything else — re-reads, repeated searches,
    // suppressed repeats, errors — accrues. Alternating read/search
    // cycles therefore stall out exactly like a single repeated call,
    // which the old identical-observation backstop could not see.
    const isStub = finalResult.meta?.unchanged_stub === true;
    const isSuppressed = finalResult.meta?.reason === 'repeat_suppressed';
    let progress = false;
    if (finalResult.status === 'ok' && !isStub && !isSuppressed) {
      if (finalResult.meta?.mutating === true || call.tool === 'run_command') {
        progress = true;
      } else {
        const fingerprint = `${toolCallSignature(call.tool, call.args)}::${observationHash(finalResult.output)}`;
        let seen = this.#seenObservations.get(state.id);
        if (!seen) {
          seen = new Set<string>();
          this.#seenObservations.set(state.id, seen);
        }
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          progress = true;
        }
      }
    }
    if (progress) {
      this.#stalls.set(state.id, 0);
    } else {
      const stalls = (this.#stalls.get(state.id) ?? 0) + 1;
      this.#stalls.set(state.id, stalls);
      if (stalls === STALL_ESCALATE_AT) await this.#maybeEscalateEarly(state, 'stall');
      if (stalls >= STALL_LIMIT && !this.#hardStops.has(state.id)) {
        this.#hardStops.set(state.id, {
          reason: 'no_progress',
          detail: `stuck: ${stalls} consecutive tool calls made no progress (no file change, no successful command, no download, no new information); the last was ${call.tool} — stopped instead of burning more turns`,
        });
      }
    }
    const observed = { ...this.#observeAndRecord(state, current, finalResult), mode: turnMode, last_tool_call_id: call.id, tool_result: finalResult };
    let recorded = observed;
    if (grantedExceptions) {
      recorded = { ...recorded, target_exceptions: [...new Set([...(current.target_exceptions ?? []), ...grantedExceptions])] };
    }
    if (clarification) {
      recorded = {
        ...recorded,
        constraints: [
          ...recorded.constraints,
          `Clarifying answer (the user's decision for this task — build to it, do not re-derive): "${clarification.question}" → "${clarification.answer}"`,
        ],
        clarifying_answers: [...(current.clarifying_answers ?? []), clarification],
      };
    }
    return recorded;
  }

  /**
   * Extract the recorded {question, answer} pair from an answered
   * ask_user result, when this task runs under the question gate (only
   * gated tasks stamp constraints — an ordinary mid-task clarification
   * stays conversation, not a binding pin). The answer is the chosen
   * option's label, or the user's free text verbatim.
   */
  #clarificationFor(state: TaskState, call: ToolCall, result: ToolResult): { question: string; answer: string } | undefined {
    if (!this.#questionGateFor(state)) return undefined;
    const args = (call.args ?? {}) as { question?: unknown; options?: unknown };
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return undefined;
    const optionIndex = typeof result.meta?.option_index === 'number' ? result.meta.option_index : undefined;
    let answer: string | undefined;
    if (optionIndex !== undefined && Array.isArray(args.options)) {
      const option = args.options[optionIndex] as { label?: unknown } | string | undefined;
      if (typeof option === 'string') answer = option;
      else if (option && typeof option.label === 'string') answer = option.label;
    }
    answer ??= freeTextAnswer(result.output);
    if (!answer) return undefined;
    return { question, answer };
  }

  /** Execute a single tool call end to end (the sequential path). */
  async #executeToolCall(
    state: TaskState,
    current: TaskState,
    call: ToolCall,
    turnMode: AgentMode,
    turnId: string,
  ): Promise<TaskState> {
    const prepared = await this.#prepareToolCall(state, call, turnMode, turnId);
    const result = 'result' in prepared ? prepared.result : await this.#executeTool(call);
    return this.#recordToolResult(state, current, call, result, turnMode, turnId);
  }

  /**
   * Execute a burst of spawn_subagent calls concurrently (cap 3). Calls
   * are prepared sequentially (events/guard/mode in order), the executable
   * ones run in parallel, and their results are recorded in call order.
   * One child's failure never takes its siblings down: an executor throw
   * becomes that call's error result.
   */
  async #executeSpawnGroup(
    state: TaskState,
    current: TaskState,
    calls: ToolCall[],
    turnMode: AgentMode,
    turnId: string,
  ): Promise<TaskState> {
    const prepared: Array<{ call: ToolCall; result?: ToolResult }> = [];
    for (const call of calls) {
      const ready = await this.#prepareToolCall(state, call, turnMode, turnId);
      prepared.push('result' in ready ? { call, result: ready.result } : { call });
    }
    const executable = prepared.filter((entry) => entry.result === undefined);
    const results = new Map<string, ToolResult>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, executable.length) }, async () => {
      while (cursor < executable.length) {
        const entry = executable[cursor++]!;
        try {
          results.set(entry.call.id, await this.#executeTool(entry.call));
        } catch (error) {
          results.set(entry.call.id, {
            call_id: entry.call.id,
            status: 'error',
            output: String(error),
            truncated: false,
            meta: { tool: entry.call.tool, mode: turnMode, reason: 'execution_error' },
          });
        }
      }
    });
    await Promise.all(workers);
    let next = current;
    for (const entry of prepared) {
      const result = entry.result ?? results.get(entry.call.id)!;
      next = await this.#recordToolResult(state, next, entry.call, result, turnMode, turnId);
    }
    return next;
  }

  /**
   * Replace long, already-served skill bodies in the task history with
   * a short stub. Runs only after the current request was built from
   * the full history (see step), so the body reaches the model exactly
   * once in full; later turns carry the stub instead of re-sending up
   * to 16K of playbook per request. Entries already stubbed are left
   * alone; short results are not worth stubbing.
   */
  #stubServedSkillBodies(taskId: string): void {
    const history = this.#history.get(taskId);
    if (!history) return;
    for (let index = 0; index < history.length; index++) {
      const entry = history[index]!;
      if (entry.kind !== 'tool_result') continue;
      const skillName = entry.result.meta?.skill;
      if (typeof skillName !== 'string' || entry.result.output.length <= 500) continue;
      if (entry.result.output.startsWith('(skill "')) continue;
      history[index] = {
        kind: 'tool_result',
        result: {
          ...entry.result,
          output: `(skill "${skillName}" body already served in full earlier in this task — not repeated here. Follow it from memory; do not read_skill it again.)`,
          truncated: false,
        },
      };
    }
  }

  #guardFor(state: TaskState): LoopGuard {
    let guard = this.#loopGuards.get(state.id);
    if (!guard) {
      // workspaceRoot lets the guard treat ".", the absolute root path, and
      // depth variants of list_dir as the same exploration of one path.
      guard = new LoopGuard({ workspaceRoot: state.repo_path });
      this.#loopGuards.set(state.id, guard);
    }
    return guard;
  }

  /**
   * Tailor-suite phase for the next request: a turn answering a failed
   * validation is a repair turn; once the task has mutated the workspace its
   * turns are edit turns; everything earlier is exploration. Q&A never
   * reaches the loop (the fast paths answer it), so `question` is stamped
   * only by those direct calls.
   */
  #phaseFor(state: TaskState): ModelPhase {
    const observation = state.last_observation ?? '';
    if ((state.last_error ?? '').startsWith('validation_failed') || observation.startsWith('Validation failed')) return 'repair';
    if (this.#taskMutated.has(state.id)) return 'edit';
    return 'explore';
  }

  /** Additive `model`/`tier` fields naming who served a finished request. */
  #servedModelFields(state: TaskState): { model?: string; tier?: ModelTier } {
    const modelsTried = providerAttemptedModels(this.#provider, state);
    const model = providerAttemptedModel(this.#provider, state, modelsTried);
    if (!model) return {};
    const tier = this.#modelTiers[model];
    return { model, ...(tier ? { tier } : {}) };
  }

  /**
   * Quality escalation (tailor suite): after a real validation failure, if
   * the driving provider is a multi-model pool whose current model is not
   * its strongest, pin the remainder of the task to the strongest model —
   * at most once per task, fail-open (a broken controller never fails the
   * repair it was meant to improve).
   */
  async #maybeEscalateQuality(state: TaskState, attempt: number): Promise<void> {
    if (!this.#qualityEscalation || this.#escalatedTasks.has(state.id)) return;
    const pinned = await this.#pinStrongest(state);
    if (!pinned) return;
    await this.#emit(state.id, undefined, 'PROVIDER_CHANGED', {
      reason: 'quality_escalation',
      from_model: pinned.from,
      to_model: pinned.to,
      model: pinned.to,
      attempt,
    });
  }

  /**
   * Tailor early-trigger (optional insurance): the anti-loop guard or
   * the stall counter says this task is circling — spend the pool's
   * strongest model NOW instead of after a validation failure. Shares
   * the once-per-task cap with quality escalation (one escalation per
   * task, whichever fires first), and emits TAILOR_ESCALATED so the
   * final report can state that it happened and why.
   */
  async #maybeEscalateEarly(state: TaskState, reason: 'loop_warning' | 'stall'): Promise<void> {
    if (!this.#earlyEscalation || this.#escalatedTasks.has(state.id)) return;
    const pinned = await this.#pinStrongest(state);
    if (!pinned) return;
    await this.#emit(state.id, undefined, 'TAILOR_ESCALATED', {
      reason,
      from_model: pinned.from,
      to_model: pinned.to,
      model: pinned.to,
    });
    await this.#emit(state.id, undefined, 'PROVIDER_CHANGED', {
      reason: 'tailor_early_escalation',
      from_model: pinned.from,
      to_model: pinned.to,
      model: pinned.to,
    });
  }

  /** Pin the task to the pool's strongest model (once per task). Fail-open. */
  async #pinStrongest(state: TaskState): Promise<{ from?: string; to: string } | undefined> {
    if (this.#escalatedTasks.has(state.id)) return undefined;
    try {
      const controller = asModelController(this.#provider);
      if (!controller || controller.poolModels.length < 2) return undefined;
      const strongest = controller.strongestModel();
      if (!strongest) return undefined;
      const current = controller.currentModel();
      if (current === strongest) return undefined;
      if (!controller.pinModel(strongest)) return undefined;
      this.#escalatedTasks.add(state.id);
      return { from: current, to: strongest };
    } catch {
      // Escalation is an optimization, never a failure mode.
      return undefined;
    }
  }

  /**
   * Append one entry to the task's tool-turn history (see #history),
   * trimmed to a bounded window. The trim drops from the front and then
   * drops any leading tool results: a tool message whose assistant
   * tool-call message was trimmed away is protocol-invalid for strict
   * providers, so it never leads the list.
   */
  #pushHistory(taskId: string, observation: Observation): void {
    let history = this.#history.get(taskId);
    if (!history) {
      history = [];
      this.#history.set(taskId, history);
    }
    history.push(observation);
    if (history.length > HISTORY_OBSERVATION_CAP) {
      history.splice(0, history.length - HISTORY_OBSERVATION_CAP);
      while (history.length > 0 && history[0]?.kind === 'tool_result') history.shift();
    }
  }

  /**
   * Observe a finished tool call into state AND record it in the task
   * history (see #history), so the result is still in front of the model
   * on later turns instead of surviving only as this turn's
   * `last_observation`.
   */
  #observeAndRecord(state: TaskState, current: TaskState, result: ToolResult): TaskState {
    this.#pushHistory(state.id, { kind: 'tool_result', result });
    return this.#observe.handle({ kind: 'tool_result', result }, current);
  }

  /**
   * The unchanged-read stub. Returns the stub text when this read's
   * lines were all served before with identical content; otherwise records
   * what was just served and returns undefined (full text flows). The
   * comparison runs against the freshly executed result, so an external
   * edit (or a command that rewrote the file) invalidates the record by
   * content, not by clock — the stale-stub failure mode (Claude Code
   * #60684) cannot occur. Condensing never invalidates the record (see
   * the branch comments): it only changes which stub wording is honest.
   */
  #readStubFor(taskId: string, call: ToolCall, result: ToolResult): string | undefined {
    const args = (call.args ?? {}) as { path?: unknown };
    const condensedNow = this.#condensedCounts.get(taskId) ?? 0;
    let perTask = this.#servedReads.get(taskId);
    if (!perTask) {
      perTask = new Map();
      this.#servedReads.set(taskId, perTask);
    }
    if (call.tool === 'list_dir') {
      const path = typeof args.path === 'string' && args.path ? args.path : '.';
      const existing = perTask.get(path);
      if (existing?.listingText === result.output) {
        // Identical listing. If condensing has since pushed the earlier
        // copy out of view, say exactly that (never claim it is still in
        // context) — re-serving the whole listing is how fat tasks spiral
        // into re-read loops until the token budget stops them.
        return condensedNow > existing.condensedAtServe
          ? `[already listed earlier in this task: ${path} — the entries are unchanged, but the earlier listing has been pushed out of your visible context to save space. Do not list it again; proceed to the actual change (write_file/edit_file/run_command), or finish.]`
          : `[unchanged since your earlier listing: ${path} — the same entries, already in your context. Do not list it again; proceed to the actual change (write_file/edit_file/run_command), or finish.]`;
      }
      perTask.set(path, { lines: new Map(), totalLines: 0, condensedAtServe: condensedNow, listingText: result.output });
      return undefined;
    }
    // read_file
    const path = typeof result.meta?.resolved_path === 'string'
      ? result.meta.resolved_path
      : typeof args.path === 'string'
        ? args.path
        : undefined;
    const start = result.meta?.start_line;
    const end = result.meta?.end_line;
    const total = result.meta?.total_lines;
    if (!path || typeof start !== 'number' || typeof end !== 'number' || typeof total !== 'number' || end < start) return undefined;
    const servedLines = parseNumberedLines(result.output);
    if (!servedLines) return undefined;
    const record = perTask.get(path);
    if (record) {
      let allSame = true;
      for (let line = start; line <= end; line++) {
        if (record.lines.get(line) !== servedLines.get(line)) {
          allSame = false;
          break;
        }
      }
      if (allSame) {
        // The record is NOT forgotten when condensing advances (the old
        // behavior): forgetting re-served the whole file, the re-serve
        // fattened history, condensing squeezed again — the tesvite
        // loop's death spiral (3× a 268-line file, budget dead before any
        // write). The stub stays truthful instead: after condensing it
        // no longer claims the lines are in context, it says they were
        // pushed out and steers to a narrow range or the actual write.
        return condensedNow > record.condensedAtServe
          ? `[already read earlier in this task: ${path} lines ${start}–${end} of ${total} — unchanged since, but the earlier copy has been pushed out of your visible context to save space. Do not re-read the whole file again; read a narrow range (offset/limit) only if you need exact lines. Otherwise proceed with the change (edit_file/write_file), ask_user if blocked, or finish.]`
          : `[unchanged since your earlier read: ${path} lines ${start}–${end} of ${total} — the file has not changed and those lines are already in your context. Do not read them again; proceed with the change (edit_file/write_file/download_file), ask_user if blocked, or finish. For lines you have not seen, read a new range with offset/limit.]`;
      }
    }
    let mutable = record;
    if (!mutable) {
      mutable = { lines: new Map(), totalLines: total, condensedAtServe: condensedNow };
      perTask.set(path, mutable);
    }
    for (const [line, text] of servedLines) mutable.lines.set(line, text);
    mutable.totalLines = total;
    mutable.condensedAtServe = condensedNow;
    return undefined;
  }

  /**
   * Next spill-file path for a task: `<daedalus-home>/tasks/<id>/tool-output/
   * <n>-<tool>.txt`, numbered per task in execution order. Only minted when
   * an output actually spills, so numbering has no gaps in practice.
   */
  #spillPathFor(taskId: string, tool: string): string {
    const next = (this.#spillCounters.get(taskId) ?? 0) + 1;
    this.#spillCounters.set(taskId, next);
    const stem = tool.replace(/[^A-Za-z0-9._-]+/g, '_');
    return join(this.#store.taskDir(taskId), 'tool-output', `${next}-${stem}.txt`);
  }

  /**
   * One model turn over the streaming contract: text lands as
   * MODEL_TEXT_DELTA events (cumulative, throttled) while the whole
   * message — tool calls included — is assembled for the turn
   * machine. A provider that refuses streaming before producing
   * anything (unknown stream options, no SSE support) falls back to
   * the identical plain request; a stream that dies mid-text throws
   * its real error into the caller's failure accounting.
   */
  async #chatStreamed(
    taskId: string,
    turnId: string,
    messages: Message[],
    tools: import('../providers/llm/types.ts').ToolDefinition[] | undefined,
    phase: ModelPhase | undefined,
  ): Promise<import('../providers/llm/types.ts').ChatResponse> {
    const assembler = new StreamMessageAssembler();
    let lastEmitAt = 0;
    let emitted = false;
    try {
      for await (const chunk of this.#provider.stream(messages, tools, { ...this.#chatOptions, phase })) {
        assembler.push(chunk);
        if (chunk.type === 'delta' && chunk.content) {
          const now = Date.now();
          if (now - lastEmitAt >= 100) {
            lastEmitAt = now;
            emitted = true;
            await this.#emit(taskId, turnId, 'MODEL_TEXT_DELTA', { text: assembler.text });
          }
        }
      }
    } catch (error) {
      if (!emitted && assembler.empty) {
        return this.#provider.chat(messages, tools, { ...this.#chatOptions, phase });
      }
      throw error;
    }
    if (assembler.empty) {
      return this.#provider.chat(messages, tools, { ...this.#chatOptions, phase });
    }
    // Only text turns produce delta events: a tool-call turn with no
    // prose must leave the event sequence exactly as it was before
    // streaming existed (the CLI/Web parity contract).
    if (assembler.text) {
      await this.#emit(taskId, turnId, 'MODEL_TEXT_DELTA', { text: assembler.text, final: true });
    }
    return assembler.toResponse();
  }

  async #emitThought(taskId: string, turnId: string, message: Message): Promise<void> {
    if (!this.#thinking) return;
    const thought = thoughtFromMessage(message);
    if (!thought) return;
    await this.#emit(taskId, turnId, 'THOUGHT', thought);
  }

  async #emit(taskId: string, turnId: string | undefined, type: Event['type'], payload: unknown): Promise<void> {
    emitEvent({ bus: this.#bus, store: this.#store }, taskId, turnId, type, payload);
    await this.#bus.drain();
  }

  /**
   * Creation-completion gate verdict from THIS task's own ledger. The
   * runtime re-checks at the lineage level (children included) after the
   * loop returns; here the per-task view is: file-tool changes, successful
   * run_command executions (shell creation leaves no per-file trace), the
   * scaffold marker on disk, and whether the task delegated.
   */
  /**
   * Slide completion gate: a slide task that built deck content may not
   * finish "done" while no successful export_deck is on record — the
   * deck would exist only as deck.json and the user would get no .pptx
   * (the exact shape of the owner's first successful build, which
   * stopped one step early despite the contract). The trigger is the
   * task's own deck work, not goal wording: read-only slide questions
   * never build, so they are never gated, and Ask/Plan keep their own
   * semantics.
   */
  #slideExportRefusal(state: TaskState): { reason: string; detail: string } | undefined {
    if (state.domain !== 'slide') return undefined;
    const mode = state.mode ?? this.#modeController.mode;
    if (mode === 'ask' || mode === 'plan') return undefined;
    if (this.#slideExports.has(state.id)) return undefined;
    if (!this.#slideDeckWork.has(state.id)) return undefined;
    return {
      reason: 'slide_export_missing',
      detail: 'this slide task has not produced a .pptx yet — no successful export_deck call is on record. A slide task is complete only when the deck is exported: call validate_deck, fix every error it reports, then call export_deck',
    };
  }

  #creationRefusal(state: TaskState): { reason: string; detail: string } | undefined {
    const mode = state.mode ?? this.#modeController.mode;
    // Ask answers questions and Plan's deliverable is the plan document
    // (covered by the plan-document guarantee above): neither may be
    // forced to "create files" by this gate.
    if (mode === 'ask' || mode === 'plan') return undefined;
    const goal: CreationGoal = detectCreationGoal(state.goal, state.done_criteria);
    if (!goal.creation) return undefined;
    // Completion gate v2 (anchored, non-scaffold tasks): changing files
    // is not enough — at least one change must be INSIDE the declared
    // target. Changes only outside (the incident: a full page written
    // to an unrelated ayid/index.html) refuse completion exactly like
    // zero changes, repair turn included. Scaffold goals keep the
    // marker rule below (the marker lives under the target by
    // construction); unanchored tasks keep the PR #21 semantics.
    if (!goal.scaffold) {
      const targetDir = this.#targetDirFor(state);
      if (targetDir) {
        const split = this.#targetChangeSplit(state, targetDir);
        if (split.inside === 0 && split.outside.length > 0) {
          return {
            reason: 'no_files_created',
            detail: `the task is anchored to target directory "${targetDir}/", but every file it changed is outside the target (${split.outside.slice(0, 5).join(', ')}${split.outside.length > 5 ? ', …' : ''}) — a creation task may report success only when at least one changed file is inside ${targetDir}/; write the deliverable inside ${targetDir}/ (or, when the user wants another location, get their approval with ask_user first)`,
          };
        }
      }
    }
    const markerPresent = goal.scaffold ? scaffoldMarkerPresent(state.repo_path, goal.scaffold) : false;
    return creationCompletionRefusal(
      goal,
      {
        filesChanged: this.#changedFiles.get(state.id)?.size ?? 0,
        commandsSucceeded: this.#commandsSucceeded.get(state.id) ?? 0,
        delegated: this.#delegatedTasks.has(state.id),
        lastCommandFailure: this.#lastCommandFailure.get(state.id),
      },
      markerPresent,
      { deferWhenDelegated: true },
    );
  }

  /**
   * The task's declared target directory, when anchored (agent/scaffold.ts
   * deriveTaskTargetDir). Resolved from the spec once and cached;
   * re-derived on demand so a folder the task itself creates mid-run can
   * anchor the completion checks too. One derivation feeds write
   * confinement, gate v2, and validation scoping, so the three can never
   * disagree about where this task's work belongs.
   */
  #targetDirFor(state: TaskState): string | undefined {
    const known = this.#targets.get(state.id) ?? state.target_dir;
    if (known) return known;
    const derived = deriveTaskTargetDir({
      goal: state.goal,
      doneCriteria: state.done_criteria,
      constraints: state.constraints,
      // An execute-the-plan follow-up anchors to the approved plan's own
      // declaration (step intents + pinned document bodies), never to a
      // folder an earlier task in the same chat session happened to name —
      // the pinned documents and steps outrank the leftover session text
      // riding in constraints (see deriveTaskTargetDir planSources).
      ...(state.plan_task_id ? { planSources: this.#planSourcesFor(state) } : {}),
      planSteps: state.steps.map((step) => step.intent),
      workspaceRoot: state.repo_path,
      changedPaths: [...(this.#changedFiles.get(state.id) ?? [])],
    });
    if (derived) this.#targets.set(state.id, derived);
    return derived;
  }

  /**
   * The approved plan's own texts for a follow-up task: its step intents
   * first (the tasks.md step-lock), then the pinned document bodies read
   * back from the workspace (architecture file lists name the target
   * folder most explicitly). The documents are located through the plan
   * task's own event log — the same replay the runtime pins from — so the
   * anchor derives from the plan artifact, never from goal prose.
   */
  #planSourcesFor(state: TaskState): string[] {
    const sources = state.steps.map((step) => step.intent);
    if (!state.plan_task_id) return sources;
    const documents = new Set<string>();
    for (const event of this.#store.replay(state.plan_task_id)) {
      if (event.type !== 'FILE_CHANGED') continue;
      const path = (event.payload as { path?: unknown }).path;
      if (isPlanDocumentChange(path)) documents.add(path.replace(/\\/g, '/'));
    }
    const rank = (path: string): number => PLAN_DOCUMENT_FILES.indexOf(path.split('/').at(-1) as typeof PLAN_DOCUMENT_FILES[number]);
    for (const path of [...documents].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      try {
        sources.push(readFileSync(join(state.repo_path, path), 'utf8').slice(0, 6_000));
      } catch {
        // A document that vanished between planning and execution simply
        // contributes no anchor text; the step intents still can.
      }
    }
    return sources;
  }

  /**
   * Evaluate the pre-build question gate once per task and cache it, so
   * its answer never shifts mid-run. Run-shape conditions live here
   * (the goal-text classification is agent/scaffold.ts):
   *
   * - the gate is wired for this run (settings.questionGate, on by default);
   * - the task runs in Auto or Manual (Ask answers, Plan interviews itself);
   * - it is a top-level task — a spawned subagent executes a brief its
   *   parent already scoped, so it is never sent back to the user;
   * - it is not an execute-the-plan follow-up (the plan interview
   *   already happened; re-gating would interrogate an approved spec);
   * - the goal is creation-shaped and underspecified per
   *   questionGateAppliesToGoal (raw one-line briefs naming at most one
   *   of {folder, stack, criteria}).
   */
  #questionGateFor(state: TaskState): boolean {
    const cached = this.#questionGates.get(state.id);
    if (cached !== undefined) return cached;
    let applies = false;
    if (this.#questionGate) {
      const mode = state.mode ?? this.#modeController.mode;
      // An approved-plan follow-up (spec.plan_task_id) is NEVER gated: the
      // plan interview already produced the spec the user approved, and
      // the pinned documents are that spec — they are never re-classified
      // as an underspecified raw brief (the classifier only ever reads
      // goal + done_criteria, never the pinned constraint text).
      applies = !state.plan_task_id
        && (mode === 'auto' || mode === 'manual')
        && !state.parent_task_id
        && questionGateAppliesToGoal(state.goal, state.done_criteria);
    }
    this.#questionGates.set(state.id, applies);
    return applies;
  }

  /** The gate block for one mutating/executing call, or undefined when it may proceed. */
  #questionGateBlock(state: TaskState, call: ToolCall, turnMode: AgentMode): ToolResult | undefined {
    if (this.#questionRoundsDone.has(state.id)) return undefined;
    if (classifyToolName(call.tool) !== 'mutating' && classifyToolName(call.tool) !== 'executing') return undefined;
    if (!this.#questionGateFor(state)) return undefined;
    return {
      call_id: call.id,
      status: 'denied',
      output: QUESTION_GATE_DIRECTIVE,
      truncated: false,
      meta: { tool: call.tool, mode: turnMode, reason: 'question_gate', mutating: false },
    };
  }

  /**
   * Write confinement for anchored tasks. The loop layer is the seam on
   * purpose: #prepareToolCall is the one choke point sequential calls
   * AND parallel spawn bursts share, it runs before the call can reach
   * the approval layer (an approval must never be able to bless an
   * out-of-target write — it decides WHETHER a write may happen, the
   * anchor decides WHERE), and the loop owns the per-task ledgers
   * (change ledger, exceptions) the decision needs. The tool layer
   * cannot host it: tools see (args, workspaceRoot), never the task's
   * declared target. spawn_subagent children run their own loops with
   * their own specs, so confinement follows delegation naturally.
   *
   * Confined: file-mutating calls with a path (write_file, edit_file,
   * edit_search_replace, create_dir, download_file). Never confined:
   * `.daedalus/**` bookkeeping, paths inside the target, files this
   * task itself already changed outside (they predate the anchor's
   * knowledge), and ask_user-approved exception paths. run_command is
   * deliberately not path-confined (a shell has no single path; it
   * stays approval-gated, and gate v2 is its backstop: shell-only
   * changes outside the target still cannot yield success).
   */
  #outsideTargetBlock(state: TaskState, call: ToolCall, turnMode: AgentMode): ToolResult | undefined {
    if (classifyToolName(call.tool) !== 'mutating') return undefined;
    const rawPath = toolCallTargetPath(call.args);
    if (!rawPath) return undefined;
    const targetDir = this.#targetDirFor(state);
    if (!targetDir) return undefined;
    const rel = workspaceRelativePath(state.repo_path, rawPath);
    if (rel !== undefined && (rel === '.daedalus' || rel.startsWith('.daedalus/'))) return undefined;
    if (rel !== undefined && pathInsideTarget(rel, targetDir)) return undefined;
    if (rel !== undefined) {
      for (const changed of this.#changedFiles.get(state.id) ?? []) {
        const changedRel = workspaceRelativePath(state.repo_path, changed);
        if (changedRel !== undefined && (rel === changedRel || rel.startsWith(`${changedRel}/`))) return undefined;
      }
      for (const exception of this.#targetExceptions.get(state.id) ?? []) {
        if (rel === exception || rel.startsWith(`${exception}/`)) return undefined;
      }
    }
    const display = rel ?? rawPath;
    let blocked = this.#blockedOutside.get(state.id);
    if (!blocked) {
      blocked = new Set<string>();
      this.#blockedOutside.set(state.id, blocked);
    }
    blocked.add(display);
    return {
      call_id: call.id,
      status: 'denied',
      output: `Write blocked: this task has a declared target directory "${targetDir}/" — file changes for this task belong inside ${targetDir}/, but this call targets "${display}" outside it, so nothing was changed. Write the file inside ${targetDir}/ instead. If the user really wants the change in "${display}", ask them with ask_user first (name the path "${display}" in the question) and write there only after they approve.`,
      truncated: false,
      meta: { tool: call.tool, mode: turnMode, reason: 'outside_task_target', target_dir: targetDir, path: display, mutating: false },
    };
  }

  /**
   * Whether an answered ask_user question sanctions an outside-target
   * exception — and if so, records it. Deliberately narrow: the path
   * must be NAMED (in the question, an option label, or the answer
   * itself — the blocked-write error instructs the model to name it)
   * and the user's answer must approve it (the chosen option/free text
   * names the path, or opens with an affirmative), never under a
   * negation. Granted paths are returned so #recordToolResult can stamp
   * them on state for the final report. Heuristic by necessity — a
   * question answer is prose — so anything ambiguous grants nothing.
   */
  #grantTargetExceptions(state: TaskState, call: ToolCall, result: ToolResult): string[] | undefined {
    if (result.meta?.outcome !== 'answered') return undefined;
    const targetDir = this.#targetDirFor(state);
    if (!targetDir) return undefined;
    const args = (call.args ?? {}) as { question?: unknown; options?: unknown };
    const question = typeof args.question === 'string' ? args.question : '';
    const labels: string[] = [];
    if (Array.isArray(args.options)) {
      for (const option of args.options) {
        if (typeof option === 'string') labels.push(option);
        else if (typeof option === 'object' && option !== null && typeof (option as { label?: unknown }).label === 'string') {
          labels.push((option as { label: string }).label);
        }
      }
    }
    const optionIndex = typeof result.meta?.option_index === 'number' ? result.meta.option_index : undefined;
    const answer = (optionIndex !== undefined ? labels[optionIndex] : undefined) ?? freeTextAnswer(result.output);
    if (!answer) return undefined;
    // Candidates: paths this task was already blocked from, plus any
    // path-like token the question or the answer names (pre-approval
    // before any block attempt).
    const candidates = new Set<string>(this.#blockedOutside.get(state.id) ?? []);
    for (const token of pathLikeTokens([question, ...labels, answer].join(' '))) candidates.add(token);
    const negated = /\b(tidak|jangan|bukan|no|nope|don't|dont)\b/i.test(answer);
    const granted: string[] = [];
    for (const candidate of candidates) {
      const rel = workspaceRelativePath(state.repo_path, candidate);
      if (rel === undefined || rel === '' || pathInsideTarget(rel, targetDir)) continue;
      if (rel === '.daedalus' || rel.startsWith('.daedalus/')) continue;
      const named = question.includes(rel) || labels.some((label) => label.includes(rel)) || answer.includes(rel);
      if (!named) continue;
      const approved = !negated && (answer.includes(rel) || AFFIRMATIVE_ANSWER.test(answer.trim()));
      if (!approved) continue;
      granted.push(rel);
    }
    if (granted.length === 0) return undefined;
    let exceptions = this.#targetExceptions.get(state.id);
    if (!exceptions) {
      exceptions = new Set<string>();
      this.#targetExceptions.set(state.id, exceptions);
    }
    for (const rel of granted) exceptions.add(rel);
    return granted;
  }

  /** Split the task's change ledger into inside-target vs outside-target changes (normalized). */
  #targetChangeSplit(state: TaskState, targetDir: string): { inside: number; outside: string[] } {
    let inside = 0;
    const outside: string[] = [];
    for (const changed of this.#changedFiles.get(state.id) ?? []) {
      const rel = workspaceRelativePath(state.repo_path, changed);
      if (rel === undefined) outside.push(changed);
      else if (pathInsideTarget(rel, targetDir)) inside++;
      else outside.push(rel);
    }
    return { inside, outside };
  }

  #done(state: TaskState): boolean {
    return state.steps.length > 0 && state.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  }
}

const MAX_THOUGHT_CHARS = 4_000;

/** Deck-building slide tools: one successful call means the task built deck content (the slide completion gate's trigger). */
const SLIDE_DECK_WORK_TOOLS = new Set(['create_deck', 'add_slide', 'update_slide', 'move_slide', 'delete_slide', 'set_deck_theme']);

/** Cheap content fingerprint for the stall tracker's "new observation" test. */
function observationHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash}`;
}

/**
 * Parse a read_file result's numbered body lines ("12: text") into a
 * line-number → text map. Header/footer lines never match the pattern.
 * Returns undefined when the output carries no numbered lines at all
 * (an error or an unexpected shape: nothing safe to record).
 */
function parseNumberedLines(output: string): Map<number, string> | undefined {
  const lines = new Map<number, string>();
  for (const raw of output.split('\n')) {
    const match = /^(\d+): ?(.*)$/.exec(raw);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return lines.size > 0 ? lines : undefined;
}
/** view_image attachments awaiting one request, mirroring the context manager's per-request image cap. */
const MAX_PENDING_VIEWED_IMAGES = 4;

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function providerAttemptedModels(provider: LLMProvider, state: TaskState): string[] {
  const candidate = provider as { lastAttemptedModels?: unknown; lastAttemptedModel?: unknown; model?: unknown };
  if (Array.isArray(candidate.lastAttemptedModels)) {
    const models = candidate.lastAttemptedModels.filter((model): model is string => typeof model === 'string' && model.length > 0);
    if (models.length > 0) return models;
  }
  if (typeof candidate.lastAttemptedModel === 'string' && candidate.lastAttemptedModel) return [candidate.lastAttemptedModel];
  if (typeof candidate.model === 'string' && candidate.model) return [candidate.model];
  if (state.models && state.models.length > 0) return [...state.models];
  if (state.model) return [state.model];
  return [];
}

function providerAttemptedModel(provider: LLMProvider, state: TaskState, modelsTried: string[]): string | undefined {
  return modelsTried[modelsTried.length - 1]
    ?? (provider as { activeModel?: unknown }).activeModel as string | undefined
    ?? state.model;
}

function providerTimeoutMs(provider: LLMProvider): number | undefined {
  const timeout = (provider as { defaultTimeoutMs?: unknown }).defaultTimeoutMs;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

function summarizeModelFailure(failure: ModelFailure, maxErrors: number): string {
  const subject = failure.model ? `Model ${failure.model}` : `Model provider ${failure.provider}`;
  const tried = failure.modelsTried.length > 0
    ? ` Tried ${failure.modelsTried.length} model${failure.modelsTried.length === 1 ? '' : 's'} (${failure.modelsTried.join(', ')}).`
    : '';
  return `${subject} ${modelFailureDetail(failure)}.${tried} Stopped after ${failure.consecutive} consecutive model request failure${failure.consecutive === 1 ? '' : 's'} (error limit ${maxErrors}).`;
}

function summarizeFatalModelFailure(failure: ModelFailure): string {
  const subject = failure.model ? `Model ${failure.model}` : `Model provider ${failure.provider}`;
  if (failure.reason === 'auth') {
    return `auth: ${subject} could not be used because provider authentication failed. Daedalus stopped immediately; check the provider or API key. Original error: ${shortError(failure.error)}`;
  }
  if (failure.reason === 'content_policy') {
    return `content_policy: ${subject} refused the request (content policy). Daedalus stopped immediately instead of routing around the refusal. Original error: ${shortError(failure.error)}`;
  }
  return `fatal_provider_error: ${subject} failed with a fatal provider error. Daedalus stopped immediately. Original error: ${shortError(failure.error)}`;
}

function modelFailureDetail(failure: ModelFailure): string {
  switch (failure.reason) {
    case 'timeout': return `timed out${timeoutDurationText(failure)}`;
    case 'rate_limit': return 'was rate limited by the provider';
    case 'quota': return `ran into a provider quota limit (${shortError(failure.error)})`;
    case 'context_or_token_limit': return `exceeded the model context/token limit (${shortError(failure.error)})`;
    case 'model_not_found': return `was not available (${shortError(failure.error)})`;
    case 'network': return `could not reach the provider (${shortError(failure.error)})`;
    case 'format_or_empty': return `returned an unusable response (${shortError(failure.error)})`;
    default: return `failed (${shortError(failure.error)})`;
  }
}

function timeoutDurationText(failure: ModelFailure): string {
  const timeoutMs = failure.timeoutMs ?? parseTimeoutMs(failure.error);
  return timeoutMs === undefined ? '' : ` after ${formatDuration(timeoutMs)}`;
}

function parseTimeoutMs(error: string): number | undefined {
  const match = /after\s+(\d+(?:\.\d+)?)ms/i.exec(error);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatDuration(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function shortError(error: string): string {
  const text = error.replace(/\s+/g, ' ').trim();
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

export function thoughtFromMessage(message: Message): { text: string; source: 'provider_reasoning' | 'assistant_tool_call_content'; truncated: boolean; original_length: number } | undefined {
  const explicit = [message.reasoning_content, message.reasoning, message.thinking]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
  if (explicit) return truncateThought(explicit, 'provider_reasoning');

  // Some OpenAI-compatible models put a short rationale in `content` alongside
  // tool calls. That text is real provider output; final prose answers are not
  // relabelled as thoughts.
  if ((message.tool_calls?.length ?? 0) > 0 && typeof message.content === 'string' && message.content.trim().length > 0) {
    return truncateThought(message.content.trim(), 'assistant_tool_call_content');
  }
  return undefined;
}

function truncateThought(text: string, source: 'provider_reasoning' | 'assistant_tool_call_content'): { text: string; source: 'provider_reasoning' | 'assistant_tool_call_content'; truncated: boolean; original_length: number } {
  if (text.length <= MAX_THOUGHT_CHARS) return { text, source, truncated: false, original_length: text.length };
  return {
    text: `${text.slice(0, MAX_THOUGHT_CHARS)}\n…[thought truncated ${text.length - MAX_THOUGHT_CHARS} chars]`,
    source,
    truncated: true,
    original_length: text.length,
  };
}

function reopenLastCompletedStep(steps: PlanStep[]): PlanStep[] {
  const index = steps.map((step) => step.status).lastIndexOf('done');
  if (index < 0) return steps;
  return steps.map((step, i) => (i === index ? { ...step, status: 'active' } : step));
}

/** The workspace-relative path a tool call targets, when its args carry one. */
function toolCallTargetPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

/** Opening words of an ask_user answer that read as approval (Indonesian + English). */
const AFFIRMATIVE_ANSWER = /^(ya|iya|yes|ok|oke|boleh|setuju|silakan|silahkan|lanjut|lanjutkan|approve|approved|go ahead)\b/i;

/**
 * The user's free-text answer out of an ask_user result's model-facing
 * output (`The user answered your question with their own text: "…"` —
 * questionResultOutput in interaction/questions.ts owns that format).
 */
function freeTextAnswer(output: string): string | undefined {
  const match = /with their own text: "([^"]*)"/.exec(output);
  const answer = match?.[1]?.trim();
  return answer ? answer : undefined;
}

/** Path-like tokens (containing a `/` or a file extension) named in prose. */
function pathLikeTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]*[/.][A-Za-z0-9_./-]*/g)) {
    const token = match[0].replace(/[.,;:!?)"']+$/, '');
    if (token.length > 1) tokens.add(token);
  }
  return [...tokens];
}

function toSpec(state: TaskState): TaskSpec {
  return {
    id: state.id,
    goal: state.goal,
    repo_path: state.repo_path,
    constraints: state.constraints,
    done_criteria: state.done_criteria,
    created_at: state.created_at,
    mode: state.mode,
    parent_task_id: state.parent_task_id,
    plan_task_id: state.plan_task_id,
    attachments: state.attachments,
    provider_id: state.provider_id,
    model: state.model,
    models: state.models,
    model_strategy: state.model_strategy,
    ...(state.target_dir ? { target_dir: state.target_dir } : {}),
  };
}

export function parseAction(state: TaskState, message: Message): Action {
  const calls = message.tool_calls ?? [];
  if (calls.length > 0) {
    const first = calls[0];
    if (!first) return { kind: 'stop', reason: 'invalid_action' };
    let args: unknown = {};
    try { args = JSON.parse(first.function.arguments || '{}'); } catch { return { kind: 'stop', reason: 'invalid_action' }; }
    return { kind: 'tool', call: { id: first.id || `call-${Date.now()}`, task_id: state.id, turn_id: '', tool: first.function.name, args, started_at: new Date().toISOString() } };
  }
  const text = typeof message.content === 'string' ? message.content : '';
  if (/^\s*done\b/i.test(text)) return { kind: 'complete', summary: text };
  if (/^\s*replan\b/i.test(text)) return { kind: 'replan', reason: text };
  if (/^\s*stop\b/i.test(text)) return { kind: 'stop', reason: 'aborted' };
  return { kind: 'stop', reason: 'invalid_action' };
}

export type { Plan, PlanStep };
