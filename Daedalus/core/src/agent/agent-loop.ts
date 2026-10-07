import { join } from 'node:path';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { ContentBlock, LLMProvider, Message, ModelPhase } from '../providers/llm/types.ts';
import { classifyLLMError, LLMAuthError, LLMContentPolicyError, type LLMErrorKind } from '../providers/llm/errors.ts';
import { asModelController, modelPoolFailureReason } from '../providers/llm/model-pool.ts';
import type { AgentMode, Event, ModelTier, Plan, PlanStep, TaskSpec, TaskState, ToolCall, ToolResult } from '../contracts.ts';
import type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor } from './types.ts';
import type { Validator } from '../validation/index.ts';
import { completionGate, normalizeError, validationFailed, validationFailureSignature } from '../validation/index.ts';
import { interpretTask } from './interpreter.ts';
import { createPlan, replan } from './planner.ts';
import { DefaultContextManager, condenseToolOutputs, contextMeter } from './context.ts';
import { LoopGuard, REPEAT_SUPPRESSED_OUTPUT, loopGuidanceNote } from './loop-guard.ts';
import { handleObservation } from './observation.ts';
import { resolveToolOutputLimits, shapeToolOutput, type ToolOutputLimits } from './tool-output.ts';
import { evaluateStopConditions, noProgressCondition } from './stop.ts';
import { ModeController, isToolCallDenied, isToolVisible, modeDenialMessage } from '../interaction/modes.ts';
import { isPlanDocumentChange, planDecisionsFromEvents, planDocumentRepairDirective } from '../interaction/plans.ts';
import { SPAWN_SUBAGENT_TOOL_NAME } from '../interaction/subagents.ts';
import { creationCompletionRefusal, detectCreationGoal, scaffoldMarkerPresent, type CreationGoal } from './scaffold.ts';

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
  readonly #contextLimitTokens: number;
  readonly #condense: boolean;
  readonly #toolOutputLimits: ToolOutputLimits;
  readonly #modelTiers: Record<string, ModelTier>;
  readonly #qualityEscalation: boolean;
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
  readonly #pendingImages = new Map<string, Array<{ path: string; mime: string; dataUrl: string }>>();
  /** File paths each task has mutated (validation check scoping). */
  readonly #changedFiles = new Map<string, Set<string>>();
  /**
   * Completion-gate evidence per task: successful run_command executions
   * (shell-created files never appear as per-file changes) and whether the
   * task delegated (children's ledgers belong to the runtime layer).
   */
  readonly #commandsSucceeded = new Map<string, number>();
  readonly #delegatedTasks = new Set<string>();
  /** Creation-shaped tasks that already spent their one create-the-files repair turn. */
  readonly #creationRepairs = new Set<string>();
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
    this.#contextLimitTokens = options.contextLimitTokens && options.contextLimitTokens > 0 ? options.contextLimitTokens : 128_000;
    this.#condense = options.condense !== false;
    this.#toolOutputLimits = resolveToolOutputLimits(options.toolOutput);
    this.#modelTiers = options.modelTiers ?? {};
    this.#qualityEscalation = options.qualityEscalation !== false;
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
      this.#validationStalls.delete(spec.id);
      this.#planRepairs.delete(spec.id);
      this.#commandsSucceeded.delete(spec.id);
      this.#delegatedTasks.delete(spec.id);
      this.#creationRepairs.delete(spec.id);
      this.#consecutiveTimeouts.delete(spec.id);
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
    let iteration = 0;
    let errors = 0;
    let validationFailures = 0;
    const validationRecoveryLimit = Math.max(1, Math.min(3, this.#stopPolicy.max_errors));
    for (;;) {
      if (this.#cancelled.has(state.id) || this.#store.isCancelRequested(state.id)) { state = { ...state, status: 'failed', last_error: 'aborted' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'aborted' }); this.#store.saveState(state.id, state); return state; }
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
          && ![...(this.#changedFiles.get(state.id) ?? [])].some((path) => isPlanDocumentChange(path))
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
          const result = await this.#validator.validate({
            workspaceRoot: state.repo_path,
            ...(changedFiles.length > 0 ? { changedFiles } : {}),
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
        }
        state = { ...state, status: completed ? 'done' : 'active' };
        await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: completed ? 'success' : 'partial', reason: completed ? 'completed' : 'validation_failed' });
        this.#store.saveState(state.id, state);
        return state;
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
    const built = await this.#context.buildMessages({ ...state, mode: turnMode }, [], visibleTools);
    let messages = this.#condense ? condenseToolOutputs(built, { limitTokens: this.#contextLimitTokens }) : built;
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
    // Images the model asked to see (view_image): attached as an image_url
    // block on a user message, the same carriage user uploads take in the
    // context manager. Drained exactly once; the matching tool result in
    // the history stays its one-line placeholder text.
    const pendingImages = this.#pendingImages.get(state.id);
    if (pendingImages && pendingImages.length > 0) {
      this.#pendingImages.delete(state.id);
      for (const image of pendingImages) {
        const content: ContentBlock[] = [
          { type: 'text', text: `Image attached from view_image (${image.path}, ${image.mime}):` },
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
      response = await this.#provider.chat(messages, visibleTools, { ...this.#chatOptions, phase });
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FINISHED', { message: response.message, usage: response.usage, finish_reason: response.finish_reason, phase, ...this.#servedModelFields(state), ...meter });
      await this.#emitThought(state.id, turnId, response.message);
      this.#modelFailures.delete(state.id);
      this.#consecutiveTimeouts.delete(state.id);
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
        current = { ...this.#observe.handle({ kind: 'tool_result', result }, current), mode: turnMode, last_tool_call_id: result.call_id, tool_result: result };
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
    const guardCall = this.#guardFor(state).observe(call.tool, call.args);
    if (guardCall.decision !== 'execute') {
      await this.#emit(state.id, turnId, 'LOOP_WARNING', {
        tool: call.tool,
        repeats: guardCall.repeats,
        suppressed: guardCall.decision === 'suppress',
        ...(guardCall.repeatKind ? { repeat_kind: guardCall.repeatKind } : {}),
      });
      this.#pendingGuidance.set(state.id, loopGuidanceNote(call.tool, guardCall.repeats));
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
    if (guardCall.decision === 'suppress') {
      return {
        result: {
          call_id: call.id,
          // Not an error: the call was answered from the repeat cache.
          // `mutating: false` keeps the observation handler from treating
          // it as implementation progress, and the unchanged observation
          // lets the no_progress backstop remain the final safety.
          status: 'ok' as const,
          output: guardCall.suppressedOutput ?? REPEAT_SUPPRESSED_OUTPUT,
          truncated: false,
          meta: { tool: call.tool, mode: turnMode, reason: 'repeat_suppressed', repeats: guardCall.repeats, mutating: false, ...(guardCall.repeatKind ? { repeat_kind: guardCall.repeatKind } : {}) },
        },
      };
    }
    return { execute: true };
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
    if (call.tool === SPAWN_SUBAGENT_TOOL_NAME) this.#delegatedTasks.add(state.id);
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
    // view_image carriage: lift the image payload out of the result before
    // it is shaped, emitted, or persisted. The bytes queue for the next
    // model request (see `step`); from here on the result is only the
    // tool's placeholder text, so the event log, the saved task state, and
    // every transcript render the placeholder — never a base64 dump.
    let safeResult = result;
    if (call.tool === 'view_image' && result.status === 'ok' && typeof result.meta?.image_data_url === 'string') {
      const pending = this.#pendingImages.get(state.id) ?? [];
      pending.push({
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
    // Shape the result before it enters the model context (the single
    // choke point every tool's output passes through): over-cap output is
    // kept head+tail with the full text spilled to the task store, so a
    // huge command dump or minified-file grep can neither flood the next
    // request nor lose its tail, where failures summarize. The event log
    // keeps the executor's untouched result — only the model-facing copy
    // is shortened — and the event gains additive truncation flags so the
    // Web can show that shaping happened.
    const shaped = await shapeToolOutput(safeResult.output, {
      tool: call.tool,
      limits: this.#toolOutputLimits,
      spillPathFor: (tool) => this.#spillPathFor(state.id, tool),
    });
    const modelResult: ToolResult = shaped.truncated
      ? {
          ...safeResult,
          output: shaped.output,
          truncated: true,
          meta: {
            ...safeResult.meta,
            output_truncated: true,
            ...(shaped.spillPath ? { spill_path: shaped.spillPath } : {}),
            output_original_chars: shaped.totalChars,
            output_original_lines: shaped.totalLines,
            output_shown_lines: shaped.shownLines,
          },
        }
      : safeResult;
    await this.#emit(state.id, turnId, 'TOOL_CALL_FINISHED', {
      call,
      result: safeResult,
      ...(shaped.truncated ? { output_truncated: true, ...(shaped.spillPath ? { spill_path: shaped.spillPath } : {}) } : {}),
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
    return { ...this.#observe.handle({ kind: 'tool_result', result: modelResult }, current), mode: turnMode, last_tool_call_id: call.id, tool_result: modelResult };
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
    try {
      const controller = asModelController(this.#provider);
      if (!controller || controller.poolModels.length < 2) return;
      const strongest = controller.strongestModel();
      if (!strongest) return;
      const current = controller.currentModel();
      if (current === strongest) return;
      if (!controller.pinModel(strongest)) return;
      this.#escalatedTasks.add(state.id);
      await this.#emit(state.id, undefined, 'PROVIDER_CHANGED', {
        reason: 'quality_escalation',
        from_model: current,
        to_model: strongest,
        model: strongest,
        attempt,
      });
    } catch {
      // Escalation is an optimization, never a failure mode.
    }
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
  #creationRefusal(state: TaskState): { reason: string; detail: string } | undefined {
    const mode = state.mode ?? this.#modeController.mode;
    // Ask answers questions and Plan's deliverable is the plan document
    // (covered by the plan-document guarantee above): neither may be
    // forced to "create files" by this gate.
    if (mode === 'ask' || mode === 'plan') return undefined;
    const goal: CreationGoal = detectCreationGoal(state.goal, state.done_criteria);
    if (!goal.creation) return undefined;
    const markerPresent = goal.scaffold ? scaffoldMarkerPresent(state.repo_path, goal.scaffold) : false;
    return creationCompletionRefusal(
      goal,
      {
        filesChanged: this.#changedFiles.get(state.id)?.size ?? 0,
        commandsSucceeded: this.#commandsSucceeded.get(state.id) ?? 0,
        delegated: this.#delegatedTasks.has(state.id),
      },
      markerPresent,
      { deferWhenDelegated: true },
    );
  }

  #done(state: TaskState): boolean {
    return state.steps.length > 0 && state.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  }
}

const MAX_THOUGHT_CHARS = 4_000;
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
    attachments: state.attachments,
    provider_id: state.provider_id,
    model: state.model,
    models: state.models,
    model_strategy: state.model_strategy,
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
