import type { ToolCall, ToolResult } from '../contracts.ts';

export type JsonSchema = Record<string, unknown>;

export type ToolExecutionContext = {
  workspaceRoot: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sandbox?: boolean;
  onOutput?: (chunk: string) => void;
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
