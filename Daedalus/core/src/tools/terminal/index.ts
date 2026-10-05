import { spawn } from 'node:child_process';
import type { ToolResultStatus } from '../../contracts.ts';
import type { ToolDefinition } from '../registry.ts';
import { pathInWorkspace } from '../filesystem/index.ts';

export const SANDBOX_ALLOWLIST = ['git','node','npm','npx','ls','cat','echo','sleep','python','python3','pytest','tsc','eslint','make','cargo','go'];
export const INTERACTIVE_FLAG_RE = /(^|\s)-{1,2}(i|interactive|editor|verbose|debug)(\s|$)/;
export function isBlocked(command: string, args: string[]): boolean {
  if (['ssh','sudo','su','scp','rsync'].includes(command)) return true;
  if (command === 'git' && /^(init|clone|commit|push|pull|merge|rebase|reset|cherry-pick|tag|branch)$/.test(args[0] ?? '')) return true;
  return false;
}
export function killGroup(child: { pid?: number; kill?: (signal?: NodeJS.Signals) => boolean }): void {
  try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch { /* group already ended */ }
  try { child.kill?.('SIGKILL'); } catch { /* child already ended */ }
}

type Exec = { status: ToolResultStatus; output: string; truncated: boolean; meta: Record<string, unknown> };
export function run(command: string, args: string[], cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal; outputLimit?: number; sandbox?: boolean; onOutput?: (chunk: string) => void } = {}): Promise<Exec> {
  const limit = opts.outputLimit ?? 16_000;
  return new Promise((resolve) => {
    const env = opts.sandbox ? { PATH: process.env.PATH ?? '/usr/bin:/usr/local/bin', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C.UTF-8', TERM: process.env.TERM ?? 'dumb' } : process.env;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = ''; let killed = false; let settled = false;
    const finish = (result: Exec) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { killed = true; killGroup(child); }, opts.timeoutMs ?? 10_000);
    const consume = (chunk: Buffer) => { const text = chunk.toString(); output += text; opts.onOutput?.(text); if (output.length > limit * 2 && !killed) { killed = true; killGroup(child); } };
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
    opts.signal?.addEventListener('abort', () => { killed = true; killGroup(child); }, { once: true });
    child.on('error', (error) => finish({ status: killed ? 'timeout' : 'error', output: killed ? 'execution cancelled or timed out' : String(error), truncated: false, meta: { killed } }));
    child.on('close', (code) => { const truncated = output.length > limit; finish({ status: killed ? 'timeout' : code === 0 ? 'ok' : 'error', output: truncated ? `${output.slice(0, limit)}\n…[truncated]` : output, truncated, meta: { exit_code: code, killed, pid: child.pid } }); });
  });
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command', description: 'Run an allowlisted process in the workspace with timeout, cancellation, output cap, and process-group cleanup.', mutating: true, timeoutMs: 10_000,
  inputSchema: { type: 'object', required: ['command','args'], properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { command?: unknown; args?: unknown; cwd?: unknown };
    if (typeof a.command !== 'string' || !Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string')) return { call_id: '', status: 'error', output: 'command must be a string and args an array of strings', truncated: false, meta: {} };
    const allowlist = process.env.DAEDALUS_CMD_ALLOWLIST?.split(',') ?? SANDBOX_ALLOWLIST;
    if (!allowlist.includes(a.command) || INTERACTIVE_FLAG_RE.test((a.args as string[]).join(' ')) || isBlocked(a.command, a.args as string[])) return { call_id: '', status: 'denied', output: `'${a.command}' is not allowed`, truncated: false, meta: { allowlist } };
    let cwd = context.workspaceRoot;
    try { if (typeof a.cwd === 'string') cwd = await pathInWorkspace(context.workspaceRoot, a.cwd); } catch (error) { return { call_id: '', status: 'denied', output: String(error), truncated: false, meta: {} }; }
    return { call_id: '', ...(await run(a.command, a.args as string[], cwd, { timeoutMs: context.timeoutMs, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput })) };
  },
};

export { gitStatusTool, gitDiffTool } from './git.ts';
