import type { ToolCall, ToolResult } from '../contracts.ts';
import type { BackgroundJobManager } from './terminal/jobs.ts';

export type JsonSchema = Record<string, unknown>;

export type ToolExecutionContext = {
  workspaceRoot: string;
  /** Task that owns this call; scopes per-task state (background jobs). */
  taskId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sandbox?: boolean;
  onOutput?: (chunk: string) => void;
  /**
   * Background job manager of the hosting run, when the host provides
   * one. `run_command` with `background: true`, `command_status`, and
   * `command_kill` refuse with a typed error without it; the runtime
   * always injects one per run.
   */
  jobs?: BackgroundJobManager;
  /**
   * Whether the model serving this run can see images (resolved by the
   * runtime from the provider registry's supportsVision flags). Tools
   * that return image content (`view_image`) refuse on an explicit
   * `false`; `undefined` means "host did not say", treated as capable so
   * direct registry use in tests is unaffected.
   */
  visionEnabled?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mutating: boolean;
  timeoutMs?: number;
  execute: (args: unknown, context: ToolExecutionContext) => Promise<ToolResult>;
};

export type ModelToolSchema = {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
};

/**
 * Longest budget a single tool call may request via its `timeout_ms`
 * argument (10 minutes). Project generators and package installs are the
 * motivating case: they run in the foreground with streamed output, so a
 * raised cap replaces the old pattern of hitting the 10s default and
 * dying mid-scaffold. Work that must outlive one call (installs, dev
 * servers) goes through `run_command` with `background: true` instead —
 * never the shell's `&`.
 */
export const MAX_TOOL_CALL_TIMEOUT_MS = 600_000;

/**
 * Resolve a model-requested `timeout_ms` tool argument to a bounded
 * budget: finite positive numbers are floored and clamped to
 * [1, MAX_TOOL_CALL_TIMEOUT_MS]; anything else means "no request".
 */
export function clampCallTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  list(): ToolDefinition[] { return [...this.#tools.values()]; }

  schemas(): ModelToolSchema[] {
    return this.list().map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.get(call.tool);
    const result = await tool.execute(call.args, { ...context, timeoutMs: context.timeoutMs ?? tool.timeoutMs });
    return { ...result, call_id: result.call_id || call.id, meta: { ...result.meta, tool: tool.name, mutating: tool.mutating } };
  }
}

export function result(callId: string, status: ToolResult['status'], output: string, meta: Record<string, unknown> = {}): ToolResult {
  return { call_id: callId, status, output, truncated: false, meta };
}
