import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolResult } from '../../contracts.ts';
import type { ToolDefinition } from '../registry.ts';
import { killGroup } from './index.ts';

/**
 * Background jobs: the agent-side answer to long installs and dev
 * servers (Claude's backgrounded Bash, Codex's exec_command session,
 * Crush's job_output). `run_command` with `background: true` starts a
 * process and returns a job handle immediately; `command_status` polls
 * it and `command_kill` stops it. Jobs are owned by the task that
 * started them: the runtime kills whatever is still running when the
 * task ends or is stopped.
 *
 * Jobs live in memory only (this manager). They die when the task ends;
 * if the server process itself is killed ungracefully, a detached job
 * can outlive it — the same process-group discipline as the foreground
 * runner applies everywhere else, and the documented limit.
 */

export type BackgroundJobState = 'running' | 'exited' | 'failed' | 'killed';

export type BackgroundJob = {
  id: string;
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  state: BackgroundJobState;
  exitCode: number | null;
  /** OS signal that ended the process, when the close event reported one. */
  signal: string | null;
  /** Total output bytes observed (the retained buffer is bounded below). */
  outputBytes: number;
  startedAt: string;
  finishedAt?: string;
};

/** How many background jobs one task may keep running at once. */
export const MAX_BACKGROUND_JOBS_PER_TASK = 3;
/** Retained output per job (tail); earlier output is counted, not kept. */
export const JOB_OUTPUT_BUFFER_CHARS = 32_768;
/** Largest `tail_chars` a status call may ask for. */
export const JOB_STATUS_MAX_TAIL_CHARS = 4_000;
/** Status tail the tool returns when the caller asks for nothing. */
export const JOB_STATUS_DEFAULT_TAIL_CHARS = 1_000;
/** Bounded grace task teardown gives queued exit notices to land before killing. */
export const JOB_TEARDOWN_DRAIN_MS = 250;

export type BackgroundJobHooks = {
  /** One output chunk from a running job (runtime → COMMAND_OUTPUT mirror). */
  onOutput?: (job: BackgroundJob, chunk: string) => void;
  /** The job reached a terminal state (runtime → JOB_FINISHED). */
  onFinish?: (job: BackgroundJob) => void;
};

type JobRecord = {
  job: BackgroundJob;
  child: ChildProcess;
  output: string;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
  processExit?: { code: number | null; signal: NodeJS.Signals | null };
};

export type StartJobResult =
  | { ok: true; job: BackgroundJob }
  | { ok: false; reason: 'job_limit'; running: number; max: number };

export class BackgroundJobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #hooks: BackgroundJobHooks;
  readonly #maxPerTask: number;
  #counter = 0;

  constructor(hooks: BackgroundJobHooks = {}, options: { maxPerTask?: number } = {}) {
    this.#hooks = hooks;
    this.#maxPerTask = options.maxPerTask ?? MAX_BACKGROUND_JOBS_PER_TASK;
  }

  /**
   * Start a detached process owned by `taskId`. The caller (the tool
   * layer) has already applied the sandbox allowlist and cwd confinement;
   * this manager only enforces the per-task concurrency cap.
   */
  start(input: { taskId: string; command: string; args: string[]; cwd: string; sandbox?: boolean }): StartJobResult {
    const running = this.runningCount(input.taskId);
    if (running >= this.#maxPerTask) {
      return { ok: false, reason: 'job_limit', running, max: this.#maxPerTask };
    }
    const id = `job-${++this.#counter}`;
    const env = input.sandbox
      ? { PATH: process.env.PATH ?? '/usr/bin:/usr/local/bin', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C.UTF-8', TERM: process.env.TERM ?? 'dumb' }
      : process.env;
    const child = spawn(input.command, input.args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const job: BackgroundJob = {
      id,
      taskId: input.taskId,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      state: 'running',
      exitCode: null,
      signal: null,
      outputBytes: 0,
      startedAt: new Date().toISOString(),
    };
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const record: JobRecord = { job, child, output: '', settled: false, settledPromise, resolveSettled };
    this.#jobs.set(id, record);
    const consume = (chunk: Buffer): void => {
      const text = chunk.toString();
      job.outputBytes += chunk.length;
      // Bounded ring: keep the tail, which is what status renders.
      record.output = (record.output + text).slice(-JOB_OUTPUT_BUFFER_CHARS);
      this.#hooks.onOutput?.({ ...job }, text);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('exit', (code, signal) => { record.processExit = { code, signal }; });
    child.on('error', () => this.#settle(record, job.state === 'killed' ? 'killed' : 'failed', null, null));
    child.on('close', (code, signal) => {
      if (job.state === 'killed') {
        this.#settle(record, 'killed', code, signal);
      } else {
        this.#settle(record, code === 0 ? 'exited' : 'failed', code, signal);
      }
    });
    return { ok: true, job: { ...job } };
  }

  /** Snapshot + bounded output tail for one of the task's jobs. */
  status(taskId: string, jobId: string, tailChars = JOB_STATUS_DEFAULT_TAIL_CHARS): { job: BackgroundJob; tail: string; outputTruncated: boolean } | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || record.job.taskId !== taskId) return undefined;
    const bounded = Math.min(JOB_STATUS_MAX_TAIL_CHARS, Math.max(0, Math.floor(tailChars)));
    const outputTruncated = record.output.length > bounded || record.job.outputBytes > record.output.length;
    return {
      job: { ...record.job },
      tail: bounded === 0 ? '' : record.output.slice(-bounded),
      outputTruncated,
    };
  }

  /** Jobs of one task, oldest first (snapshots). */
  list(taskId: string): BackgroundJob[] {
    return [...this.#jobs.values()]
      .filter((record) => record.job.taskId === taskId)
      .map((record) => ({ ...record.job }));
  }

  /** Kill one running job (its whole process group). Returns the snapshot. */
  kill(taskId: string, jobId: string): BackgroundJob | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || record.job.taskId !== taskId) return undefined;
    if (record.job.state === 'running') {
      // Mark first: the close event would otherwise read the group kill
      // as a failure instead of the deliberate stop it is.
      record.job.state = 'killed';
      killGroup(record.child);
    }
    return { ...record.job };
  }

  /**
   * Kill every still-running job of a task (task end / Stop / shutdown).
   * Finished jobs stay readable until the manager is discarded.
   */
  killAll(taskId: string): number {
    let killed = 0;
    for (const record of this.#jobs.values()) {
      if (record.job.taskId !== taskId || record.job.state !== 'running') continue;
      record.job.state = 'killed';
      killGroup(record.child);
      killed++;
    }
    return killed;
  }

  /**
   * End-of-task teardown with deterministic final states. A process can
   * terminate at the OS level while Node has not yet delivered its `close`
   * callback; killing in that window would relabel a natural exit as
   * `killed`. Give those queued notifications a bounded chance to settle,
   * honour a process exit whose stdio has ended if the `close` callback is
   * still pending, then kill only what remains running.
   */
  async settleAndKillAll(taskId: string, drainMs = JOB_TEARDOWN_DRAIN_MS): Promise<number> {
    const pending = [...this.#jobs.values()].filter((record) => record.job.taskId === taskId && record.job.state === 'running');
    if (pending.length === 0) return 0;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, drainMs)); });
    try {
      await Promise.race([Promise.all(pending.map((record) => record.settledPromise)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    for (const record of pending) {
      if (record.job.state !== 'running' || !record.processExit) continue;
      const stdioEnded = (!record.child.stdout || record.child.stdout.readableEnded)
        && (!record.child.stderr || record.child.stderr.readableEnded);
      if (!stdioEnded) continue;
      const { code, signal } = record.processExit;
      this.#settle(record, code === 0 ? 'exited' : 'failed', code, signal);
    }
    return this.killAll(taskId);
  }

  runningCount(taskId: string): number {
    let count = 0;
    for (const record of this.#jobs.values()) {
      if (record.job.taskId === taskId && record.job.state === 'running') count++;
    }
    return count;
  }

  #settle(record: JobRecord, state: BackgroundJobState, exitCode: number | null, signal: string | null): void {
    if (record.settled) return;
    record.settled = true;
    record.job.state = state;
    record.job.exitCode = exitCode;
    record.job.signal = signal;
    record.job.finishedAt = new Date().toISOString();
    try {
      this.#hooks.onFinish?.({ ...record.job });
    } finally {
      record.resolveSettled();
    }
  }
}

/** The job a status/kill call may act on: always scoped to the caller's task. */
function jobFromContext(args: unknown, context: { jobs?: BackgroundJobManager; taskId?: string }): { jobId: string; manager: BackgroundJobManager; taskId: string } | { error: ToolResult } {
  const jobId = (args as { job_id?: unknown } | null | undefined)?.job_id;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return { error: { call_id: '', status: 'error', output: 'job_id must be a non-empty string', truncated: false, meta: { reason: 'invalid_args' } } };
  }
  if (!context.jobs) {
    return { error: { call_id: '', status: 'error', output: 'background jobs are not available in this execution context (the host provided no job manager)', truncated: false, meta: { reason: 'jobs_unavailable' } } };
  }
  return { jobId, manager: context.jobs, taskId: context.taskId ?? 'default' };
}

export const commandStatusTool: ToolDefinition = {
  name: 'command_status',
  description:
    'Poll one background job started with run_command { background: true }: state (running/exited/failed/killed), exit code once finished, and the bounded tail of its recent output. Poll sparingly — do useful work between checks and never loop on this call waiting for a job to finish; the job keeps running in the meantime and is killed automatically when the task ends.',
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: {
      job_id: { type: 'string', description: 'The job id returned by the background run_command call.' },
      tail_chars: { type: 'number', description: `Optional output tail size in chars (default ${JOB_STATUS_DEFAULT_TAIL_CHARS}, max ${JOB_STATUS_MAX_TAIL_CHARS}).` },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const resolved = jobFromContext(args, context);
    if ('error' in resolved) return resolved.error;
    const tailArg = (args as { tail_chars?: unknown }).tail_chars;
    const tailChars = typeof tailArg === 'number' && Number.isFinite(tailArg) ? tailArg : JOB_STATUS_DEFAULT_TAIL_CHARS;
    const found = resolved.manager.status(resolved.taskId, resolved.jobId, tailChars);
    if (!found) {
      return { call_id: '', status: 'error', output: `unknown background job "${resolved.jobId}" for this task (it may belong to another task or never existed)`, truncated: false, meta: { reason: 'unknown_job', job_id: resolved.jobId } };
    }
    const { job, tail, outputTruncated } = found;
    const commandLine = [job.command, ...job.args].join(' ');
    const exit = job.state === 'exited' || job.state === 'failed' ? ` · exit ${job.exitCode ?? 'n/a'}` : '';
    const lines = [
      `${job.id} · ${job.state}${exit} · ${commandLine} (cwd ${job.cwd}, started ${job.startedAt})`,
      ...(tail.length > 0
        ? [`--- recent output (${tail.length} of ${job.outputBytes} bytes${outputTruncated ? ', earlier output dropped' : ''}) ---`, tail]
        : ['(no output yet)']),
      ...(job.state === 'running'
        ? ['job is still running: do other work and poll again later — do not poll in a tight loop; it is killed automatically when the task ends, or stop it now with command_kill.']
        : [`job finished (${job.state}${exit}); its full retained output tail is above.`]),
    ];
    return {
      call_id: '',
      status: 'ok',
      output: lines.join('\n'),
      truncated: outputTruncated,
      meta: { job_id: job.id, state: job.state, exit_code: job.exitCode, running: job.state === 'running' },
    };
  },
};

export const commandKillTool: ToolDefinition = {
  name: 'command_kill',
  description:
    'Stop one background job started with run_command { background: true } (the whole process group is terminated). Killing a job that already finished is reported, not an error. Jobs are also killed automatically when the task ends or is stopped.',
  mutating: true,
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: {
      job_id: { type: 'string', description: 'The job id returned by the background run_command call.' },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const resolved = jobFromContext(args, context);
    if ('error' in resolved) return resolved.error;
    const before = resolved.manager.status(resolved.taskId, resolved.jobId, 0);
    if (!before) {
      return { call_id: '', status: 'error', output: `unknown background job "${resolved.jobId}" for this task (it may belong to another task or never existed)`, truncated: false, meta: { reason: 'unknown_job', job_id: resolved.jobId } };
    }
    const job = resolved.manager.kill(resolved.taskId, resolved.jobId)!;
    const commandLine = [job.command, ...job.args].join(' ');
    if (before.job.state !== 'running') {
      return {
        call_id: '',
        status: 'ok',
        output: `${job.id} (${commandLine}) already ${before.job.state}${before.job.exitCode !== null ? ` (exit ${before.job.exitCode})` : ''}; nothing to kill`,
        truncated: false,
        meta: { job_id: job.id, state: before.job.state, exit_code: before.job.exitCode, already_finished: true },
      };
    }
    return {
      call_id: '',
      status: 'ok',
      output: `killed ${job.id} (${commandLine}) — its process group was terminated; any final output remains available via command_status`,
      truncated: false,
      meta: { job_id: job.id, state: 'killed', exit_code: null },
    };
  },
};
