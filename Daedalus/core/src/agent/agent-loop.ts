import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import { classifyLLMError, LLMAuthError, LLMContentPolicyError, type LLMErrorKind } from '../providers/llm/errors.ts';
import { modelPoolFailureReason } from '../providers/llm/model-pool.ts';
import type { Event, Plan, PlanStep, TaskSpec, TaskState, ToolCall } from '../contracts.ts';
import type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor } from './types.ts';
import type { Validator } from '../validation/index.ts';
import { completionGate, normalizeError, validationFailed } from '../validation/index.ts';
import { interpretTask } from './interpreter.ts';
import { createPlan, replan } from './planner.ts';
import { DefaultContextManager, condenseToolOutputs, contextMeter } from './context.ts';
import { LoopGuard, REPEAT_SUPPRESSED_OUTPUT, loopGuidanceNote } from './loop-guard.ts';
import { handleObservation } from './observation.ts';
import { evaluateStopConditions, noProgressCondition } from './stop.ts';
import { ModeController, isToolVisible } from '../interaction/modes.ts';

export type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor };
export { interpretTask };
export { createPlan, replan };
export { DefaultContextManager };
export { handleObservation };
export { evaluateStopConditions };

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
  readonly #loopGuards = new Map<string, LoopGuard>();
  readonly #pendingGuidance = new Map<string, string>();
  readonly #modelFailures = new Map<string, ModelFailure>();
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
      this.#modelFailures.delete(spec.id);
    }
  }

  async #runTask(spec: TaskSpec): Promise<TaskState> {
    if (spec.mode) this.#modeController.set(spec.mode);
    let state: TaskState = { ...spec, mode: spec.mode ?? this.#modeController.mode, turns: 0, plan: { id: `${spec.id}-plan`, task_id: spec.id, steps: [], version: 0, status: 'draft' }, steps: [], status: 'active' };
    await this.#emit(state.id, undefined, 'TASK_STARTED', { spec });
    this.#store.saveState(state.id, state);
    const plan = await this.#planner.createPlan(spec);
    state = { ...state, plan, steps: plan.steps };
    await this.#emit(state.id, undefined, 'PLAN_CREATED', { plan });
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
        let completed = true;
        if (this.#validator && completed) {
          await this.#emit(state.id, undefined, 'VALIDATION_STARTED', { task_id: state.id });
          const result = await this.#validator.validate({ workspaceRoot: state.repo_path });
          const gate = completionGate(result, undefined);
          completed = gate.complete;
          await this.#emit(state.id, undefined, gate.complete ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED', { result });
          if (!gate.complete) {
            const failing = validationFailed(result);
            const firstFailure = failing[0];
            if (firstFailure) {
              const error = normalizeError(firstFailure);
              validationFailures++;
              await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: error.category, strategy: 'retry', attempt: validationFailures });
              if (validationFailures < validationRecoveryLimit) {
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
    const meter = contextMeter(messages, this.#contextLimitTokens);
    await this.#emit(state.id, turnId, 'MODEL_REQUEST_STARTED', { provider: this.#provider.name, messages: messages.length, tools: visibleTools?.length ?? 0, mode: turnMode, ...meter });
    let response;
    try {
      response = await this.#provider.chat(messages, visibleTools, this.#chatOptions);
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FINISHED', { message: response.message, usage: response.usage, finish_reason: response.finish_reason, ...meter });
      await this.#emitThought(state.id, turnId, response.message);
      this.#modelFailures.delete(state.id);
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
    // Execute every tool call in the model's response, sequentially. Many
    // OpenAI-compatible models batch exploration/edit calls in one turn;
    // dropping all but the first (the old behaviour) made otherwise capable
    // models re-read the same files for several turns and never reach the
    // edit. Sequential execution preserves approval/mode checks per call.
    const rawCalls = response.message.tool_calls ?? [];
    let current: TaskState = { ...successfulState, turns: (state.turns ?? 0) + 1 };
    for (const rawCall of rawCalls) {
      let call: ToolCall;
      try {
        const args = JSON.parse(rawCall.function.arguments || '{}') as unknown;
        call = {
          id: rawCall.id || `call-${Date.now()}`,
          task_id: state.id,
          turn_id: turnId,
          tool: rawCall.function.name,
          args,
          started_at: new Date().toISOString(),
        };
      } catch {
        const result = {
          call_id: rawCall.id || `call-${Date.now()}`,
          status: 'error' as const,
          output: `invalid JSON arguments for tool ${rawCall.function.name}`,
          truncated: false,
          meta: { tool: rawCall.function.name, mode: turnMode, reason: 'invalid_arguments' },
        };
        current = { ...this.#observe.handle({ kind: 'tool_result', result }, current), mode: turnMode, last_tool_call_id: result.call_id, tool_result: result };
        continue;
      }
      call.turn_id = turnId;
      await this.#emit(state.id, turnId, 'TOOL_CALL_STARTED', { call });
      // Anti-loop guard: the 3rd identical call warns (guidance is injected
      // into the next request); further exact duplicates are suppressed with
      // a cached-repeat result instead of being executed again.
      const guardCall = this.#guardFor(state.id).observe(call.tool, call.args);
      if (guardCall.decision !== 'execute') {
        await this.#emit(state.id, turnId, 'LOOP_WARNING', {
          tool: call.tool,
          repeats: guardCall.repeats,
          suppressed: guardCall.decision === 'suppress',
        });
        this.#pendingGuidance.set(state.id, loopGuidanceNote(call.tool, guardCall.repeats));
      }
      const result = !isToolVisible(turnMode, call.tool)
        ? {
            call_id: call.id,
            status: 'denied' as const,
            output: `tool ${call.tool} is not available in ${turnMode} mode`,
            truncated: false,
            meta: { tool: call.tool, mode: turnMode, reason: 'mode_policy' },
          }
        : guardCall.decision === 'suppress'
          ? {
              call_id: call.id,
              // Not an error: the call was answered from the repeat cache.
              // `mutating: false` keeps the observation handler from treating
              // it as implementation progress, and the unchanged observation
              // lets the no_progress backstop remain the final safety.
              status: 'ok' as const,
              output: REPEAT_SUPPRESSED_OUTPUT,
              truncated: false,
              meta: { tool: call.tool, mode: turnMode, reason: 'repeat_suppressed', repeats: guardCall.repeats, mutating: false },
            }
          : await this.#executeTool(call);
      await this.#emit(state.id, turnId, 'TOOL_CALL_FINISHED', { call, result });
      current = { ...this.#observe.handle({ kind: 'tool_result', result }, current), mode: turnMode, last_tool_call_id: call.id, tool_result: result };
    }
    this.#invalidActions.delete(state.id);
    this.#store.saveState(state.id, current);
    return current;
  }

  #guardFor(taskId: string): LoopGuard {
    let guard = this.#loopGuards.get(taskId);
    if (!guard) {
      guard = new LoopGuard();
      this.#loopGuards.set(taskId, guard);
    }
    return guard;
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

  #done(state: TaskState): boolean {
    return state.steps.length > 0 && state.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  }
}

const MAX_THOUGHT_CHARS = 4_000;

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
