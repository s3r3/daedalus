import type { EventType, ToolCall, ToolResult } from '../contracts.ts';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import type { ToolDefinition, ToolExecutionContext } from '../tools/registry.ts';

export type ApprovalPolicy = 'auto' | 'ask' | 'deny';
export type ApprovalDecision = 'grant' | 'deny';
export type PermissionKey = { taskId: string; tool: string; action: 'read' | 'write' | 'execute'; path?: string };
export type ApprovalResult = { decision: ApprovalDecision; remember?: boolean };
export type ApprovalCallback = (key: PermissionKey, policy: ApprovalPolicy) => Promise<ApprovalResult>;
export type HarnessEventType = 'tool_dispatch_started' | 'tool_dispatch_completed' | 'approval_requested' | 'approval_granted' | 'approval_denied' | 'timeout_enforced' | 'cancel_requested' | 'escape_denied' | 'resource_limit_exceeded';
export type HarnessEvent = { type: HarnessEventType; taskId: string; tool?: string; path?: string; details?: Record<string, unknown>; timestamp: string };
export type ResourceUsage = { activeProcesses: number; outputBytes: number; diskWrites: number };
export type HarnessContext = ToolExecutionContext & { taskId: string; outputLimit?: number };
export type HarnessConfig = {
  defaultTimeoutMs: number;
  defaultOutputLimit: number;
  maxConcurrentProcesses: number;
  maxDiskWrites: number;
  defaultApprovalPolicy: ApprovalPolicy;
  sandboxEnabled: boolean;
  /** Pluggable policy seam: derive the approval policy per tool/action/path from config. */
  policyFor?: (key: PermissionKey, tool: ToolDefinition) => ApprovalPolicy;
};
export const DEFAULT_HARNESS_CONFIG: Omit<HarnessConfig, 'policyFor'> = { defaultTimeoutMs: 30_000, defaultOutputLimit: 64_000, maxConcurrentProcesses: 10, maxDiskWrites: 10_000, defaultApprovalPolicy: 'ask', sandboxEnabled: false };

/**
 * Approval broker: bridges the Approval Gate (core) and the decision flow over
 * the API/WS (server). A `request` blocks until the matching `decide` arrives.
 */
export class ApprovalBroker {
  #pending = new Map<string, { key: PermissionKey; policy: ApprovalPolicy; resolve: (result: ApprovalResult) => void }>();
  #listeners = new Set<() => void>();

  /** Key format shared with the harness' permission cache. */
  static keyFor(key: PermissionKey): string {
    return `${key.taskId}:${key.tool}:${key.action}:${key.path ?? ''}`;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pending(taskId?: string): Array<{ key: PermissionKey; policy: ApprovalPolicy }> {
    return [...this.#pending.values()].filter((p) => !taskId || p.key.taskId === taskId).map((p) => ({ key: p.key, policy: p.policy }));
  }

  request(key: PermissionKey, policy: ApprovalPolicy): Promise<ApprovalResult> {
    const id = ApprovalBroker.keyFor(key);
    let resolve!: (result: ApprovalResult) => void;
    const promise = new Promise<ApprovalResult>((r) => { resolve = r; });
    this.#pending.set(id, { key, policy, resolve });
    this.#notify();
    return promise;
  }

  decide(key: PermissionKey, decision: ApprovalDecision, remember = false): boolean {
    const entry = this.#pending.get(ApprovalBroker.keyFor(key));
    if (!entry) return false;
    this.#pending.delete(ApprovalBroker.keyFor(key));
    entry.resolve({ decision, remember });
    this.#notify();
    return true;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Controlled dispatch: policy → approval → timeout/cancelled execution → caps → audit. */
export class ExecutionHarness {
  #config: HarnessConfig;
  #deps: { bus?: EventBus; store?: TaskStore };
  #approval?: ApprovalCallback;
  #controllers = new Map<string, AbortController>();
  /**
   * Tasks a cancel was requested for. Cancellation is sticky: a cancel that
   * arrives a hair before an execution registers its controller (the event
   * bus delivers COMMAND_STARTED asynchronously) must still abort the
   * in-flight tool instead of being dropped on the floor.
   */
  #cancelled = new Set<string>();
  #remembered = new Map<string, ApprovalDecision>();
  #audit = new Map<string, HarnessEvent[]>();
  #usage: ResourceUsage = { activeProcesses: 0, outputBytes: 0, diskWrites: 0 };

  constructor(config: Partial<HarnessConfig> = {}, deps: { bus?: EventBus; store?: TaskStore } = {}) {
    this.#config = { ...DEFAULT_HARNESS_CONFIG, ...config };
    this.#deps = deps;
  }

  setApprovalCallback(callback: ApprovalCallback): void { this.#approval = callback; }
  getResourceUsage(): ResourceUsage { return { ...this.#usage }; }
  getAuditTrail(taskId: string): HarnessEvent[] { return [...(this.#audit.get(taskId) ?? [])]; }
  cancelTask(taskId: string): void { this.#cancelled.add(taskId); this.#controllers.get(taskId)?.abort(); this.#record('cancel_requested', taskId); }

  async execute(call: ToolCall, tool: ToolDefinition, context: HarnessContext): Promise<ToolResult> {
    const action: PermissionKey['action'] = tool.mutating ? 'write' : tool.name === 'run_command' ? 'execute' : 'read';
    const key: PermissionKey = { taskId: context.taskId, tool: tool.name, action, path: pathFromArgs(call.args) };
    this.#record('tool_dispatch_started', context.taskId, tool.name, key.path);
    const policy = this.#config.policyFor ? this.#config.policyFor(key, tool) : tool.mutating || action === 'execute' ? this.#config.defaultApprovalPolicy : 'auto';
    const decision = await this.#decide(key, policy);
    if (decision === 'deny') { const result = denied(call.id, 'approval denied'); this.#record('approval_denied', context.taskId, tool.name, key.path); this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: result.status }); return result; }
    if (this.#usage.activeProcesses >= this.#config.maxConcurrentProcesses) { const result = denied(call.id, 'process limit exceeded'); this.#record('resource_limit_exceeded', context.taskId, tool.name); return result; }
    if (this.#usage.diskWrites >= this.#config.maxDiskWrites) { const result = denied(call.id, 'disk write cap exceeded'); this.#record('resource_limit_exceeded', context.taskId, tool.name); return result; }
    const controller = new AbortController(); this.#controllers.set(context.taskId, controller); this.#usage.activeProcesses++;
    if (this.#cancelled.has(context.taskId)) controller.abort();
    const timeoutMs = context.timeoutMs ?? tool.timeoutMs ?? this.#config.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await tool.execute(call.args, { ...context, signal: controller.signal, sandbox: this.#config.sandboxEnabled });
      const final = capResult({ ...result, call_id: result.call_id || call.id }, context.outputLimit ?? this.#config.defaultOutputLimit);
      this.#usage.outputBytes += final.output.length;
      if (tool.mutating && final.status === 'ok') this.#usage.diskWrites++;
      if (final.status === 'timeout') this.#record('timeout_enforced', context.taskId, tool.name, key.path);
      this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: final.status, truncated: final.truncated });
      return final;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const result: ToolResult = { call_id: call.id, status: timedOut ? 'timeout' : 'error', output: timedOut ? 'execution cancelled or timed out' : String(error), truncated: false, meta: {} };
      if (timedOut) this.#record('timeout_enforced', context.taskId, tool.name, key.path);
      this.#record('tool_dispatch_completed', context.taskId, tool.name, key.path, { status: result.status });
      return result;
    } finally { clearTimeout(timer); this.#controllers.delete(context.taskId); this.#usage.activeProcesses--; }
  }

  async #decide(key: PermissionKey, policy: ApprovalPolicy): Promise<ApprovalDecision> {
    const cacheKey = ApprovalBroker.keyFor(key);
    const remembered = this.#remembered.get(cacheKey); if (remembered) return remembered;
    if (policy === 'auto') return 'grant'; if (policy === 'deny') return 'deny';
    this.#record('approval_requested', key.taskId, key.tool, key.path);
    this.#publish('APPROVAL_REQUESTED', key.taskId, { key, policy });
    const response = this.#approval ? await this.#approval(key, policy) : { decision: 'deny' as const };
    if (response.remember) this.#remembered.set(cacheKey, response.decision);
    if (response.decision === 'grant') this.#record('approval_granted', key.taskId, key.tool, key.path); else this.#record('approval_denied', key.taskId, key.tool, key.path);
    this.#publish('APPROVAL_DECIDED', key.taskId, { key, decision: response.decision, remember: response.remember ?? false });
    return response.decision;
  }

  #record(type: HarnessEventType, taskId: string, tool?: string, path?: string, details?: Record<string, unknown>): void {
    const event: HarnessEvent = { type, taskId, tool, path, details, timestamp: new Date().toISOString() };
    const events = this.#audit.get(taskId) ?? []; events.push(event); this.#audit.set(taskId, events);
  }

  /** Emit a typed Event on the bus (and append to the store log when both are wired). */
  #publish(type: EventType, taskId: string, payload: unknown): void {
    if (!this.#deps.bus) return;
    emitEvent({ bus: this.#deps.bus, store: this.#deps.store }, taskId, undefined, type, payload);
  }
}
function pathFromArgs(args: unknown): string | undefined { return typeof args === 'object' && args !== null && typeof (args as { path?: unknown }).path === 'string' ? (args as { path: string }).path : undefined; }
function denied(callId: string, output: string): ToolResult { return { call_id: callId, status: 'denied', output, truncated: false, meta: {} }; }
function capResult(result: ToolResult, limit: number): ToolResult { return result.output.length > limit ? { ...result, output: `${result.output.slice(0, limit)}\n…[truncated]`, truncated: true } : result; }
