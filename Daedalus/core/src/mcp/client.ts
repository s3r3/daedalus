import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type McpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 10s). */
  timeoutMs?: number;
};

export type McpRemoteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  text: string;
  isError: boolean;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Minimal stdio MCP client speaking newline-delimited JSON-RPC 2.0
 * (Model Context Protocol, public spec revision 2024-11-05). The transport
 * is hand-rolled: no MCP SDK dependency is bundled with Daedalus.
 *
 * A dead or misbehaving server never throws out of `connect()` callers that
 * use McpManager; the client itself rejects individual requests with typed
 * messages so the manager can surface them as server status.
 */
export class McpClient {
  readonly name: string;
  readonly #config: McpServerConfig;
  #process?: ChildProcessWithoutNullStreams;
  #buffer = '';
  #stderrTail = '';
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #started = false;

  constructor(config: McpServerConfig) {
    this.name = config.name;
    this.#config = config;
  }

  get running(): boolean {
    return this.#started && this.#process !== undefined && !this.#process.killed;
  }

  async connect(): Promise<void> {
    if (this.#started) return;
    const child = spawn(this.#config.command, this.#config.args ?? [], {
      env: { ...process.env, ...(this.#config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2_000);
    });
    child.on('error', (error) => this.#failAll(new Error(`MCP server "${this.name}" failed to start: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (this.#pending.size > 0) {
        this.#failAll(new Error(`MCP server "${this.name}" exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`));
      }
    });

    try {
      await this.#request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'daedalus', version: '0.1.0' },
      });
    } catch (error) {
      this.#started = false;
      child.kill('SIGTERM');
      const detail = this.#stderrTail.trim() ? ` Server stderr: ${this.#stderrTail.trim().split('\n').at(-1)}` : '';
      throw new Error(`${(error as Error).message}${detail}`);
    }
    this.#started = true;
    this.#notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpRemoteTool[]> {
    const result = (await this.#request('tools/list', {})) as { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .filter((tool) => typeof tool?.name === 'string')
      .map((tool) => ({
        name: tool.name as string,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: isPlainObject(tool.inputSchema) ? (tool.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} },
      }));
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = (await this.#request('tools/call', { name, arguments: args ?? {} })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const parts: string[] = [];
    for (const block of result?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block) parts.push(JSON.stringify(block));
    }
    return { text: parts.join('\n'), isError: result?.isError === true };
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.#started = false;
    this.#failAll(new Error(`MCP server "${this.name}" closed`));
    if (!child || child.killed) return;
    try {
      child.stdin.end();
    } catch { /* already closed */ }
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (!child.killed) child.kill('SIGKILL');
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const child = this.#process;
    if (!child) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.#nextId++;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP server "${this.name}" request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  #notify(method: string, params: unknown): void {
    this.#process?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // tolerate non-JSON noise on the server's stdout
      }
      if (typeof message.id !== 'number') continue; // notifications/requests from the server are ignored
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`MCP server "${this.name}" error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`.trim()));
      else pending.resolve(message.result);
    }
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tool names must be model-safe: letters, digits, underscore, dash. */
export function sanitizeToolSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'server';
}
