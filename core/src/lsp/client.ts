import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export type LspServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** File extensions this server handles, e.g. [".ts", ".tsx"]. */
  extensions: string[];
  /** Per-request timeout in milliseconds (default 10s). */
  timeoutMs?: number;
};

export type LspDiagnostic = {
  file: string;
  line: number;
  character: number;
  severity?: number;
  message: string;
  source?: string;
  code?: string;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 10_000;

const SEVERITY_LABELS: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const severity = diagnostic.severity !== undefined ? SEVERITY_LABELS[diagnostic.severity] ?? `severity ${diagnostic.severity}` : 'diagnostic';
  const source = diagnostic.source ? ` (${diagnostic.source}${diagnostic.code ? ` ${diagnostic.code}` : ''})` : diagnostic.code ? ` (${diagnostic.code})` : '';
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.character} ${severity}: ${diagnostic.message}${source}`;
}

/**
 * Minimal stdio LSP client (Language Server Protocol, public Microsoft spec).
 * JSON-RPC is framed with `Content-Length` headers — unlike MCP's newline
 * delimited transport. Only diagnostics are surfaced: the client initializes,
 * opens a document, and collects `textDocument/publishDiagnostics`.
 */
export class LspClient {
  readonly name: string;
  readonly #config: LspServerConfig;
  #process?: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #stderrTail = '';
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #diagnostics = new Map<string, LspDiagnostic[]>();
  #initializing?: Promise<void>;
  #initialized = false;

  constructor(config: LspServerConfig) {
    this.name = config.name;
    this.#config = config;
  }

  get running(): boolean {
    return this.#process !== undefined && !this.#process.killed;
  }

  async ensureStarted(rootPath: string): Promise<void> {
    if (this.#initialized) return;
    if (!this.#initializing) {
      this.#initializing = this.#start(rootPath).catch((error: Error) => {
        this.#initializing = undefined;
        throw error;
      });
    }
    return this.#initializing;
  }

  async #start(rootPath: string): Promise<void> {
    const child = spawn(this.#config.command, this.#config.args ?? [], {
      env: { ...process.env, ...(this.#config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2_000);
    });
    child.on('error', (error) => this.#failAll(new Error(`LSP server "${this.name}" failed to start: ${error.message}`)));
    child.on('exit', (code, signal) => {
      this.#initialized = false;
      if (this.#pending.size > 0) {
        this.#failAll(new Error(`LSP server "${this.name}" exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`));
      }
    });

    try {
      await this.#request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(rootPath).href,
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
        workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: 'workspace' }],
      });
    } catch (error) {
      child.kill('SIGTERM');
      this.#process = undefined;
      const detail = this.#stderrTail.trim() ? ` Server stderr: ${this.#stderrTail.trim().split('\n').at(-1)}` : '';
      throw new Error(`${(error as Error).message}${detail}`);
    }
    this.#notify('initialized', {});
    this.#initialized = true;
  }

  /** Open a document and wait briefly for its publishDiagnostics. */
  async diagnosticsFor(filePath: string, text: string, waitMs = 2_000): Promise<LspDiagnostic[]> {
    const uri = pathToFileURL(filePath).href;
    this.#diagnostics.delete(uri);
    this.#notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'plaintext', version: 1, text },
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const found = this.#diagnostics.get(uri);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.#diagnostics.get(uri) ?? [];
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.#initialized = false;
    this.#initializing = undefined;
    if (!child || child.killed) {
      this.#failAll(new Error(`LSP server "${this.name}" closed`));
      return;
    }
    try {
      await Promise.race([
        this.#request('shutdown', null),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      this.#notify('exit', null);
    } catch { /* fall through to kill */ }
    this.#failAll(new Error(`LSP server "${this.name}" closed`));
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
    if (!child) return Promise.reject(new Error(`LSP server "${this.name}" is not running`));
    const id = this.#nextId++;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP server "${this.name}" request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    if (!this.#process) return;
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #send(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.#process?.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: JsonRpcMessage): void {
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: Array<Record<string, unknown>> } | undefined;
      if (params?.uri) {
        const diagnostics = (params.diagnostics ?? []).map((item) => toDiagnostic(params.uri!, item));
        this.#diagnostics.set(params.uri, diagnostics);
      }
      return;
    }
    if (typeof message.id === 'number' && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`LSP server "${this.name}" error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`.trim()));
      else pending.resolve(message.result);
      return;
    }
    // Server→client requests (e.g. workspace/configuration) get a null result
    // so a real language server does not stall waiting for an answer.
    if (typeof message.id === 'number' && message.method) {
      this.#send({ jsonrpc: '2.0', id: message.id, result: null });
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

function toDiagnostic(uri: string, raw: Record<string, unknown>): LspDiagnostic {
  const range = (raw.range ?? {}) as { start?: { line?: number; character?: number } };
  const file = uri.replace(/^file:\/\//, '').split('/').filter(Boolean).at(-1) ?? uri;
  return {
    file,
    line: (range.start?.line ?? 0) + 1,
    character: (range.start?.character ?? 0) + 1,
    severity: typeof raw.severity === 'number' ? raw.severity : undefined,
    message: typeof raw.message === 'string' ? raw.message : String(raw.message ?? ''),
    source: typeof raw.source === 'string' ? raw.source : undefined,
    code: typeof raw.code === 'string' || typeof raw.code === 'number' ? String(raw.code) : undefined,
  };
}
