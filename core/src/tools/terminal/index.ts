import { spawn } from 'node:child_process';
import type { ToolResultStatus } from '../../contracts.ts';
import type { ToolDefinition } from '../registry.ts';
import { clampCallTimeoutMs } from '../registry.ts';
import { pathInWorkspace } from '../filesystem/index.ts';

// composer, flutter, django-admin, and docker are allowlisted so the
// scaffold recipes (Laravel, Flutter, Django, and the database Compose
// stacks) can run their official commands through run_command; the list
// already trusts npx/make/cargo, which execute arbitrary code too.
export const SANDBOX_ALLOWLIST = ['git','node','npm','npx','ls','cat','echo','sleep','python','python3','pytest','tsc','eslint','make','cargo','go','composer','flutter','django-admin','docker'];
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
    // A signal that aborted before the spawn (sticky cancel) never fires
    // the listener above; honour it immediately instead of running on.
    if (opts.signal?.aborted) { killed = true; killGroup(child); }
    child.on('error', (error) => finish({ status: killed ? 'timeout' : 'error', output: killed ? 'execution cancelled or timed out' : String(error), truncated: false, meta: { killed } }));
    child.on('close', (code, signal) => { const truncated = output.length > limit; finish({ status: killed ? 'timeout' : code === 0 ? 'ok' : 'error', output: truncated ? `${output.slice(0, limit)}\n…[truncated]` : output, truncated, meta: { exit_code: code, signal, killed, pid: child.pid } }); });
  });
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command', description: 'Run an allowlisted process in the workspace with timeout, cancellation, output cap, and process-group cleanup. Long-running foreground work — project generators (create-next-app, composer create-project, flutter create) — must pass timeout_ms (honored up to 600000) instead of dying on the 10s default; output streams back while it runs. Work that should keep going while you do other things (package installs, dev servers) goes in the background instead: pass background: true to get a job id back immediately, then poll command_status / stop it with command_kill. Never background with the shell &.', mutating: true, timeoutMs: 10_000,
  inputSchema: { type: 'object', required: ['command','args'], properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_ms: { type: 'number', description: 'Optional per-call budget in milliseconds for long foreground commands (generators, installs); clamped to 600000. Omit for quick commands.' }, background: { type: 'boolean', description: 'Start the process as a background job and return its job id immediately instead of waiting (installs, servers, watchers). Poll with command_status; the job is killed automatically when the task ends. At most 3 background jobs run at once per task.' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { command?: unknown; args?: unknown; cwd?: unknown; timeout_ms?: unknown; background?: unknown };
    if (typeof a.command !== 'string' || !Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string')) return { call_id: '', status: 'error', output: 'command must be a string and args an array of strings', truncated: false, meta: {} };
    const allowlist = process.env.DAEDALUS_CMD_ALLOWLIST?.split(',') ?? SANDBOX_ALLOWLIST;
    if (!allowlist.includes(a.command) || INTERACTIVE_FLAG_RE.test((a.args as string[]).join(' ')) || isBlocked(a.command, a.args as string[])) return { call_id: '', status: 'denied', output: `'${a.command}' is not allowed`, truncated: false, meta: { allowlist } };
    let cwd = context.workspaceRoot;
    try { if (typeof a.cwd === 'string') cwd = await pathInWorkspace(context.workspaceRoot, a.cwd); } catch (error) { return { call_id: '', status: 'denied', output: String(error), truncated: false, meta: {} }; }
    if (a.background === true) {
      // Same allowlist/cwd discipline as the foreground path; only the
      // waiting differs. The job ignores the call's abort signal and its
      // timeout budget: its lifetime is the task's, managed by the job
      // manager (poll command_status, command_kill, task end).
      if (!context.jobs) return { call_id: '', status: 'error', output: 'background jobs are not available in this execution context (the host provided no job manager)', truncated: false, meta: { reason: 'jobs_unavailable' } };
      const started = context.jobs.start({ taskId: context.taskId ?? 'default', command: a.command, args: a.args as string[], cwd, sandbox: context.sandbox });
      if (!started.ok) {
        return {
          call_id: '',
          status: 'error',
          output: `background job limit reached: ${started.running} of ${started.max} jobs already running for this task. Poll command_status for one to finish or command_kill one before starting another.`,
          truncated: false,
          meta: { reason: 'job_limit', running: started.running, max: started.max },
        };
      }
      const job = started.job;
      return {
        call_id: '',
        status: 'ok',
        output: `started background job ${job.id}: ${[a.command, ...(a.args as string[])].join(' ')} (cwd ${cwd})\nPoll it with command_status (${job.id}) — do useful work between polls and never poll in a tight loop. The job keeps running after this call returns and is killed automatically when the task ends; stop it sooner with command_kill.`,
        truncated: false,
        meta: { background: true, job_id: job.id, command: a.command, cwd },
      };
    }
    // Host context wins; otherwise the call's own timeout_ms request
    // (clamped to the 600s cap) raises the 10s default for this call.
    const timeoutMs = context.timeoutMs ?? clampCallTimeoutMs(a.timeout_ms);
    return { call_id: '', ...(await run(a.command, a.args as string[], cwd, { timeoutMs, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput })) };
  },
};

export { gitStatusTool, gitDiffTool } from './git.ts';
export {
  BackgroundJobManager,
  JOB_OUTPUT_BUFFER_CHARS,
  JOB_STATUS_DEFAULT_TAIL_CHARS,
  JOB_TEARDOWN_DRAIN_MS,
  JOB_STATUS_MAX_TAIL_CHARS,
  MAX_BACKGROUND_JOBS_PER_TASK,
  commandKillTool,
  commandStatusTool,
  type BackgroundJob,
  type BackgroundJobHooks,
  type BackgroundJobState,
  type StartJobResult,
} from './jobs.ts';
