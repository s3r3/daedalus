import type { Message, ToolDefinition as LLMToolDefinition } from '../providers/llm/types.ts';
import type { Plan, TaskSpec, TaskState, ToolCall, ToolResult, Event } from '../contracts.ts';

export type StopReason = 'completed' | 'max_iterations' | 'aborted' | 'provider_error' | 'invalid_action' | 'no_progress';
export type ToolAction = { kind: 'tool'; call: ToolCall };
export type CompleteAction = { kind: 'complete'; summary: string };
export type ReplanAction = { kind: 'replan'; reason: string };
export type StopAction = { kind: 'stop'; reason: StopReason };
export type Action = ToolAction | CompleteAction | ReplanAction | StopAction;
export type Observation = { kind: 'tool_result'; result: ToolResult } | { kind: 'assistant'; message: Message } | { kind: 'event'; event: Event };
export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;
export interface TaskInterpreter { interpret(input: string, options?: Partial<Omit<TaskSpec, 'goal'>>): Promise<TaskSpec> }
export interface Planner { createPlan(spec: TaskSpec): Promise<Plan>; replan(spec: TaskSpec, current: Plan, observation: Observation): Promise<Plan> }
export interface ContextManager { buildMessages(state: TaskState, observations: Observation[], tools?: LLMToolDefinition[]): Promise<Message[]>; compact(messages: Message[], budget: number): Promise<Message[]>; estimate(messages: Message[]): number }
export interface ObservationHandler { handle(observation: Observation, state: TaskState): TaskState }
export type StopCondition = (state: TaskState, iteration: number) => StopReason | undefined;
export type StopPolicy = { max_iterations: number; max_errors: number; conditions?: StopCondition[] };
