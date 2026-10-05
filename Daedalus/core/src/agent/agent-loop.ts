import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { Event, Plan, PlanStep, TaskSpec, TaskState } from '../contracts.ts';
import type { Action, CompleteAction, ContextManager, Observation, ObservationHandler, Planner, ReplanAction, StopAction, StopCondition, StopPolicy, StopReason, TaskInterpreter, ToolAction, ToolExecutor } from './types.ts';
import type { Validator } from '../validation/index.ts';
import { completionGate, normalizeError, validationFailed } from '../validation/index.ts';
import { interpretTask } from './interpreter.ts';
import { createPlan, replan } from './planner.ts';
import { DefaultContextManager } from './context.ts';
import { handleObservation } from './observation.ts';
import { evaluateStopConditions, noProgressCondition } from './stop.ts';

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
  #cancelled = new Set<string>();

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#bus = options.bus;
    this.#store = options.store;
    this.#interpreter = options.interpreter ?? { interpret: (input, o) => interpretTask(input, o) };
    this.#planner = options.planner ?? { createPlan: (s) => createPlan(s), replan: (s, c, o) => replan(s, c, o) };
    this.#context = options.context ?? new DefaultContextManager();
    this.#observe = options.observe ?? { handle: (o, s) => handleObservation(o, s) };
    const policy = options.stopPolicy ?? { max_iterations: 25, max_errors: 5 };
    this.#stopPolicy = { ...policy, conditions: [noProgressCondition(), ...(policy.conditions ?? [])] };
    this.#executeTool = options.executeTool ?? (async (call) => ({ call_id: call.id, status: 'ok', output: `stubbed ${call.tool}`, truncated: false, meta: {} }));
    this.#validator = options.validator;
    this.#tools = options.tools;
    this.#chatOptions = options.chatOptions;
  }

  stop(taskId: string): void {
    this.#cancelled.add(taskId);
  }

  async run(input: string | TaskSpec): Promise<TaskState> {
    const spec = typeof input === 'string' ? await this.#interpreter.interpret(input) : input;
    let state: TaskState = { ...spec, plan: { id: `${spec.id}-plan`, task_id: spec.id, steps: [], version: 0, status: 'draft' }, steps: [], status: 'active' };
    await this.#emit(state.id, undefined, 'TASK_STARTED', { spec });
    this.#store.saveState(state.id, state);
    const plan = await this.#planner.createPlan(spec);
    state = { ...state, plan, steps: plan.steps };
    await this.#emit(state.id, undefined, 'PLAN_CREATED', { plan });
    this.#store.saveState(state.id, state);
    let iteration = 0;
    let errors = 0;
    for (;;) {
      if (this.#cancelled.has(state.id)) { state = { ...state, status: 'failed', last_error: 'aborted' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'aborted' }); this.#store.saveState(state.id, state); return state; }
      const stop = evaluateStopConditions({ ...state, }, iteration, { ...this.#stopPolicy, max_errors: this.#stopPolicy.max_errors });
      if (errors >= this.#stopPolicy.max_errors) { state = { ...state, status: 'failed', last_error: 'max_errors' }; await this.#emit(state.id, undefined, 'TASK_COMPLETED', { state, outcome: 'failed', reason: 'max_errors' }); this.#store.saveState(state.id, state); return state; }
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
              await this.#emit(state.id, undefined, 'RECOVERY_STARTED', { reason: error.category, strategy: 'retry', attempt: 1 });
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

  async step(state: TaskState): Promise<TaskState> {
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messages = await this.#context.buildMessages(state, [], this.#tools);
    await this.#emit(state.id, turnId, 'MODEL_REQUEST_STARTED', { provider: this.#provider.name, messages: messages.length, tools: this.#tools?.length ?? 0 });
    let response;
    try {
      response = await this.#provider.chat(messages, this.#tools, this.#chatOptions);
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FINISHED', { message: response.message, usage: response.usage, finish_reason: response.finish_reason });
    } catch (error) {
      await this.#emit(state.id, turnId, 'MODEL_REQUEST_FAILED', { error: String(error) });
      return { ...state, last_error: String(error) };
    }
    const action = parseAction(state, response.message);
    if (action.kind === 'complete') {
      return { ...state, last_observation: action.summary };
    }
    if (action.kind === 'stop') {
      if (action.reason === 'completed') return { ...state, status: 'done' };
      return { ...state, status: 'failed', last_error: action.reason };
    }
    if (action.kind === 'replan') {
      const previous = state.plan;
      const next = await this.#planner.replan(toSpec(state), previous, { kind: 'assistant', message: response.message });
      await this.#emit(state.id, turnId, 'REPLAN_CREATED', { previous_plan: previous, plan: next, reason: action.reason });
      await this.#emit(state.id, turnId, 'PLAN_CREATED', { plan: next });
      const updated = { ...state, plan: next, steps: next.steps };
      this.#store.saveState(state.id, updated);
      return updated;
    }
    const call = action.call;
    call.turn_id = turnId;
    await this.#emit(state.id, turnId, 'TOOL_CALL_STARTED', { call });
    const result = await this.#executeTool(call);
    await this.#emit(state.id, turnId, 'TOOL_CALL_FINISHED', { call, result });
    const observed = this.#observe.handle({ kind: 'tool_result', result }, state);
    const withTool = { ...observed, last_tool_call_id: call.id, tool_result: result };
    this.#store.saveState(state.id, withTool);
    return withTool;
  }

  async #emit(taskId: string, turnId: string | undefined, type: Event['type'], payload: unknown): Promise<void> {
    emitEvent({ bus: this.#bus, store: this.#store }, taskId, turnId, type, payload);
    await this.#bus.drain();
  }

  #done(state: TaskState): boolean {
    return state.steps.length > 0 && state.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  }
}

function toSpec(state: TaskState): TaskSpec {
  return { id: state.id, goal: state.goal, repo_path: state.repo_path, constraints: state.constraints, done_criteria: state.done_criteria, created_at: state.created_at };
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
