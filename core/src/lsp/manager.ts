import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { ToolDefinition } from '../tools/registry.ts';
import type { ToolResult } from '../contracts.ts';
import { pathInWorkspace } from '../tools/filesystem/index.ts';
import { isPlainObject } from '../mcp/client.ts';
import { LspClient, formatDiagnostic, type LspServerConfig } from './client.ts';

export type { LspDiagnostic, LspServerConfig } from './client.ts';
export { formatDiagnostic } from './client.ts';

/** Extensions the auto-resolved TypeScript language server covers. */
export const TYPESCRIPT_LSP_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is this workspace a TypeScript one (tsconfig, or a typescript dependency)? */
export async function isTypescriptWorkspace(workspaceRoot: string): Promise<boolean> {
  if (await fileExists(join(workspaceRoot, 'tsconfig.json'))) return true;
  try {
    const parsed = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    return Boolean(parsed.dependencies?.typescript ?? parsed.devDependencies?.typescript);
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function onPath(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(':')) {
    if (dir && (await isExecutable(join(dir, command)))) return true;
  }
  return false;
}

/**
 * Resolve a runnable typescript-language-server for a TS workspace,
 * best source first: the project's own install, a PATH binary, then
 * npx (downloads on first use). Undefined for non-TS workspaces. The
 * config is computed, never written to `.daedalus/lsp.json` — the
 * user's file stays theirs; a server that still cannot start records
 * its error in status instead of crashing the run.
 */
export async function defaultTypescriptServer(workspaceRoot: string): Promise<LspServerConfig | undefined> {
  if (!(await isTypescriptWorkspace(workspaceRoot))) return undefined;
  const extensions = [...TYPESCRIPT_LSP_EXTENSIONS];
  const localBin = join(workspaceRoot, 'node_modules', '.bin', 'typescript-language-server');
  if (await isExecutable(localBin)) return { name: 'typescript (auto)', command: localBin, args: ['--stdio'], extensions };
  if (await onPath('typescript-language-server')) return { name: 'typescript (auto)', command: 'typescript-language-server', args: ['--stdio'], extensions };
  return { name: 'typescript (auto)', command: 'npx', args: ['-y', 'typescript-language-server', '--stdio'], extensions };
}

/**
 * Configured servers + automatic defaults. A user (or caller) server
 * already covering TypeScript suppresses the auto one; everything else
 * passes through untouched.
 */
export async function withDefaultLspServers(workspaceRoot: string, configured: LspServerConfig[]): Promise<LspServerConfig[]> {
  const coversTypescript = configured.some((server) => server.extensions.includes('.ts') || server.extensions.includes('.tsx'));
  if (coversTypescript) return configured;
  const auto = await defaultTypescriptServer(workspaceRoot);
  return auto ? [...configured, auto] : configured;
}

export type LspServerStatus = {
  name: string;
  extensions: string[];
  running: boolean;
  error?: string;
};

export const LSP_CONFIG_RELATIVE_PATH = '.daedalus/lsp.json';

/**
 * Load language server definitions from `<workspace>/.daedalus/lsp.json`:
 * `{ "servers": [{ "name", "command", "args"?, "env"?, "extensions": [".ts"] }] }`.
 * Missing/malformed files produce an empty list plus problem strings.
 */
export async function loadLspConfig(workspaceRoot: string): Promise<{ servers: LspServerConfig[]; problems: string[] }> {
  const path = join(workspaceRoot, LSP_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { servers: [], problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { servers: [], problems: [`${LSP_CONFIG_RELATIVE_PATH}: invalid JSON (${(error as Error).message})`] };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) {
    return { servers: [], problems: [`${LSP_CONFIG_RELATIVE_PATH}: expected an object with a "servers" array`] };
  }
  const servers: LspServerConfig[] = [];
  const problems: string[] = [];
  for (const [index, entry] of parsed.servers.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name || !entry.command) {
      problems.push(`${LSP_CONFIG_RELATIVE_PATH}: servers[${index}] needs string "name" and "command"`);
      continue;
    }
    const extensions = Array.isArray(entry.extensions)
      ? entry.extensions.filter((ext): ext is string => typeof ext === 'string').map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`))
      : [];
    servers.push({
      name: entry.name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      env: isPlainObject(entry.env)
        ? Object.fromEntries(Object.entries(entry.env).filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
        : undefined,
      extensions,
      timeoutMs: typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0 ? entry.timeoutMs : undefined,
    });
  }
  return { servers, problems };
}

/**
 * Owns configured language servers for one run. Servers start lazily on the
 * first diagnostics request for a matching extension and keep running until
 * `closeAll()`. A server that fails to start is reported honestly through the
 * tool result and `status()`; it never crashes the run.
 */
export class LspManager {
  readonly #configs: LspServerConfig[];
  readonly #clients = new Map<string, LspClient>();
  readonly #errors = new Map<string, string>();
  readonly #started = new Set<string>();

  constructor(servers: LspServerConfig[] = []) {
    this.#configs = servers;
  }

  get configuredServers(): LspServerConfig[] {
    return [...this.#configs];
  }

  status(): LspServerStatus[] {
    return this.#configs.map((server) => ({
      name: server.name,
      extensions: [...server.extensions],
      running: this.#clients.get(server.name)?.running === true,
      ...(this.#errors.has(server.name) ? { error: this.#errors.get(server.name) as string } : {}),
    }));
  }

  serverFor(filePath: string): LspServerConfig | undefined {
    const ext = extname(filePath).toLowerCase();
    return this.#configs.find((server) => server.extensions.includes(ext));
  }

  async diagnostics(workspaceRoot: string, filePath: string): Promise<{ server: string; lines: string[] }> {
    const config = this.serverFor(filePath);
    if (!config) {
      return { server: '', lines: [] };
    }
    const absolute = await pathInWorkspace(workspaceRoot, filePath);
    const text = await readFile(absolute, 'utf8');
    let client = this.#clients.get(config.name);
    if (!client) {
      client = new LspClient(config);
      this.#clients.set(config.name, client);
    }
    try {
      await client.ensureStarted(workspaceRoot);
      this.#started.add(config.name);
      this.#errors.delete(config.name);
      const diagnostics = await client.diagnosticsFor(absolute, text);
      const displayPath = relative(workspaceRoot, absolute) || filePath;
      return {
        server: config.name,
        lines: diagnostics.map((diagnostic) => formatDiagnostic({ ...diagnostic, file: displayPath })),
      };
    } catch (error) {
      this.#errors.set(config.name, (error as Error).message);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.close().catch(() => undefined)));
    this.#clients.clear();
    this.#started.clear();
  }

  /** Read-only diagnostics tool, registered only when servers are configured. */
  createDiagnosticsTool(): ToolDefinition {
    const manager = this;
    return {
      name: 'lsp_diagnostics',
      description: 'Ask the configured language server for diagnostics (errors/warnings) for a workspace file. Returns one line per diagnostic, or "no diagnostics".',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', description: 'Workspace-relative file path, e.g. src/app.ts' } },
        additionalProperties: false,
      },
      mutating: false,
      async execute(args, context): Promise<ToolResult> {
        const path = (args as { path?: unknown })?.path;
        if (typeof path !== 'string' || !path) {
          return { call_id: '', status: 'error', output: 'lsp_diagnostics requires a string "path".', truncated: false, meta: {} };
        }
        const config = manager.serverFor(path);
        if (!config) {
          const covered = manager.configuredServers.flatMap((server) => server.extensions);
          return {
            call_id: '',
            status: 'ok',
            output: `No language server configured for "${extname(path)}" files. Configured extensions: ${covered.length ? covered.join(', ') : '(none)'}.`,
            truncated: false,
            meta: { lsp_server: null },
          };
        }
        try {
          const result = await manager.diagnostics(context.workspaceRoot, path);
          return {
            call_id: '',
            status: 'ok',
            output: result.lines.length ? result.lines.join('\n') : `no diagnostics (${config.name})`,
            truncated: false,
            meta: { lsp_server: config.name, diagnostics: result.lines.length },
          };
        } catch (error) {
          return {
            call_id: '',
            status: 'error',
            output: `Language server "${config.name}" could not report diagnostics for ${path}: ${(error as Error).message}`,
            truncated: false,
            meta: { lsp_server: config.name },
          };
        }
      },
    };
  }
}
