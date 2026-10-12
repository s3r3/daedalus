import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '../contracts.ts';
import { killGroup } from '../tools/terminal/index.ts';

/**
 * Project hooks: shell commands a workspace ships in `.daedalus/hooks.json`
 * that run before/after tool calls. A pre-tool hook can veto a call (exit
 * code 2, or a stdout JSON body `{"block": true, "reason": "..."}`); a
 * post-tool hook's stdout is appended to the tool result so the model sees
 * it. `hooks.json` is trusted project config — like a Makefile, it runs
 * shell commands by design — so it only ever runs for the workspace that
 * defines it, and `DAEDALUS_HOOKS=off` disables it outright. Timeouts,
 * crashes, and malformed config are fail-open: hooks advise and veto
 * explicitly, they never hang or silently break a run.
 */

export const HOOKS_CONFIG_RELATIVE_PATH = '.daedalus/hooks.json';

export type HookPhase = 'pre_tool' | 'post_tool';

export type HookRule = {
  /** Tool-name pattern: `write_file`, `run_command`, `*` (any), or `a|b` alternatives; `*` is a wildcard inside a name. */
  match: string;
  /** Shell command, run with `sh -c` in the workspace root. */
  command: string;
  timeoutMs?: number;
};

export type HooksConfig = {
  pre_tool: HookRule[];
  post_tool: HookRule[];
};

export type LoadHooksResult = {
  hooks: HooksConfig;
  /** Human-readable problem (missing-shape entries, invalid JSON); config stays usable (fail-open). */
  warning?: string;
};

export type HookExecution = {
  phase: HookPhase;
  tool: string;
  command: string;
  outcome: 'allowed' | 'blocked' | 'error' | 'timeout';
  reason?: string;
  duration_ms: number;
};

const EMPTY_HOOKS: HooksConfig = { pre_tool: [], post_tool: [] };
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_OUTPUT_CHARS = 32_000;
const MAX_HOOK_NOTE_CHARS = 500;
const MAX_INLINE_ARGS_CHARS = 16_000;

export async function loadHooksConfig(workspaceRoot: string): Promise<LoadHooksResult> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceRoot, HOOKS_CONFIG_RELATIVE_PATH), 'utf8');
  } catch {
    return { hooks: EMPTY_HOOKS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { hooks: EMPTY_HOOKS, warning: `${HOOKS_CONFIG_RELATIVE_PATH} is not valid JSON (${(error as Error).message}); hooks ignored` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { hooks: EMPTY_HOOKS, warning: `${HOOKS_CONFIG_RELATIVE_PATH} must contain a JSON object; hooks ignored` };
  }
  const problems: string[] = [];
  const hooks: HooksConfig = {
    pre_tool: parseRules((parsed as Record<string, unknown>).pre_tool, 'pre_tool', problems),
    post_tool: parseRules((parsed as Record<string, unknown>).post_tool, 'post_tool', problems),
  };
  return problems.length ? { hooks, warning: problems.join('; ') } : { hooks };
}

function parseRules(value: unknown, phase: HookPhase, problems: string[]): HookRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${phase} must be an array; ignored`);
    return [];
  }
  const rules: HookRule[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${phase}[${index}] is not an object; skipped`);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.command !== 'string' || record.command.trim() === '') {
      problems.push(`${phase}[${index}] has no shell "command"; skipped`);
      return;
    }
    rules.push({
      match: typeof record.match === 'string' && record.match.trim() !== '' ? record.match : '*',
      command: record.command,
      ...(typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? { timeoutMs: record.timeoutMs } : {}),
    });
  });
  return rules;
}

/** `*` matches any tool; `a|b` is an alternation; a `*` inside a name is a glob wildcard. */
export function hookMatches(pattern: string, toolName: string): boolean {
  return pattern.split('|').some((alternative) => {
    const trimmed = alternative.trim();
    if (trimmed === '' || trimmed === '*') return true;
    const regex = new RegExp(`^${trimmed.split('*').map(escapeRegExp).join('.*')}$`);
    return regex.test(toolName);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type ShellOutcome = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout: stdout.slice(0, MAX_HOOK_OUTPUT_CHARS), stderr: stderr.slice(0, MAX_HOOK_OUTPUT_CHARS), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

async function hookEnv(base: {
  phase: HookPhase;
  tool: string;
  args: unknown;
  result?: ToolResult;
  command: string;
}): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'daedalus-hook-'));
  const argsFile = join(dir, 'args.json');
  await writeFile(argsFile, JSON.stringify(base.args ?? null, null, 2), 'utf8');
  const argsJson = JSON.stringify(base.args ?? null);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DAEDALUS_HOOK_PHASE: base.phase,
    DAEDALUS_HOOK_TOOL: base.tool,
    DAEDALUS_HOOK_COMMAND: base.command,
    DAEDALUS_HOOK_ARGS_FILE: argsFile,
    ...(argsJson.length <= MAX_INLINE_ARGS_CHARS ? { DAEDALUS_HOOK_ARGS_JSON: argsJson } : {}),
  };
  if (base.result) {
    const resultFile = join(dir, 'result.json');
    await writeFile(resultFile, JSON.stringify({ status: base.result.status, output: base.result.output.slice(0, 8_000), truncated: base.result.truncated }, null, 2), 'utf8');
    env.DAEDALUS_HOOK_RESULT_STATUS = base.result.status;
    env.DAEDALUS_HOOK_RESULT_FILE = resultFile;
  }
  return { env, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
}

function blockReasonFrom(outcome: ShellOutcome): string | undefined {
  const stdout = outcome.stdout.trim();
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as { block?: unknown; reason?: unknown };
      if (parsed && parsed.block === true) {
        return typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'blocked by hook';
      }
    } catch {
      // Not JSON: exit code decides, stdout becomes the reason (below).
    }
  }
  if (outcome.exitCode === 2) {
    const firstLine = (stdout || outcome.stderr.trim()).split('\n').map((line) => line.trim()).find(Boolean);
    return firstLine ?? 'blocked by hook (exit 2)';
  }
  return undefined;
}

export type PreToolHookOutcome = {
  blocked: boolean;
  reason?: string;
  command?: string;
  executions: HookExecution[];
};

/**
 * Run matching pre-tool hooks in order. The first explicit veto (exit 2 or
 * a JSON `{"block": true}` body) blocks the call; every other failure —
 * timeout, crash, non-zero exit — is recorded and the call proceeds.
 */
export async function runPreToolHooks(options: {
  workspaceRoot: string;
  hooks: HooksConfig;
  tool: string;
  args: unknown;
}): Promise<PreToolHookOutcome> {
  const executions: HookExecution[] = [];
  for (const rule of options.hooks.pre_tool) {
    if (!hookMatches(rule.match, options.tool)) continue;
    const started = Date.now();
    let outcome: ShellOutcome;
    let env: NodeJS.ProcessEnv;
    let cleanup: () => Promise<void>;
    try {
      ({ env, cleanup } = await hookEnv({ phase: 'pre_tool', tool: options.tool, args: options.args, command: rule.command }));
    } catch {
      executions.push({ phase: 'pre_tool', tool: options.tool, command: rule.command, outcome: 'error', reason: 'could not prepare hook environment', duration_ms: Date.now() - started });
      continue;
    }
    try {
      outcome = await runShell(rule.command, options.workspaceRoot, env, rule.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
    } finally {
      await cleanup();
    }
    const duration = Date.now() - started;
    if (outcome.timedOut) {
      executions.push({ phase: 'pre_tool', tool: options.tool, command: rule.command, outcome: 'timeout', duration_ms: duration });
      continue;
    }
    const reason = blockReasonFrom(outcome);
    if (reason !== undefined) {
      executions.push({ phase: 'pre_tool', tool: options.tool, command: rule.command, outcome: 'blocked', reason, duration_ms: duration });
      return { blocked: true, reason, command: rule.command, executions };
    }
    executions.push({
      phase: 'pre_tool',
      tool: options.tool,
      command: rule.command,
      outcome: outcome.exitCode === 0 || outcome.exitCode === null ? 'allowed' : 'error',
      ...(outcome.exitCode !== null && outcome.exitCode !== 0 ? { reason: `exit ${outcome.exitCode} (fail-open: call allowed)` } : {}),
      duration_ms: duration,
    });
  }
  return { blocked: false, executions };
}

export type PostToolHookOutcome = {
  /** Trimmed stdout notes to append to the tool result as `hook: …` lines. */
  notes: string[];
  executions: HookExecution[];
};

/** Run matching post-tool hooks; their stdout (trimmed, capped) advises the model via the tool result. */
export async function runPostToolHooks(options: {
  workspaceRoot: string;
  hooks: HooksConfig;
  tool: string;
  args: unknown;
  result: ToolResult;
}): Promise<PostToolHookOutcome> {
  const notes: string[] = [];
  const executions: HookExecution[] = [];
  for (const rule of options.hooks.post_tool) {
    if (!hookMatches(rule.match, options.tool)) continue;
    const started = Date.now();
    let prepared: { env: NodeJS.ProcessEnv; cleanup: () => Promise<void> };
    try {
      prepared = await hookEnv({ phase: 'post_tool', tool: options.tool, args: options.args, result: options.result, command: rule.command });
    } catch {
      executions.push({ phase: 'post_tool', tool: options.tool, command: rule.command, outcome: 'error', reason: 'could not prepare hook environment', duration_ms: Date.now() - started });
      continue;
    }
    let outcome: ShellOutcome;
    try {
      outcome = await runShell(rule.command, options.workspaceRoot, prepared.env, rule.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
    } finally {
      await prepared.cleanup();
    }
    const duration = Date.now() - started;
    if (outcome.timedOut) {
      executions.push({ phase: 'post_tool', tool: options.tool, command: rule.command, outcome: 'timeout', duration_ms: duration });
      continue;
    }
    const note = outcome.stdout.trim();
    if (note) notes.push(note.length > MAX_HOOK_NOTE_CHARS ? `${note.slice(0, MAX_HOOK_NOTE_CHARS)}…` : note);
    executions.push({
      phase: 'post_tool',
      tool: options.tool,
      command: rule.command,
      outcome: outcome.exitCode === 0 || outcome.exitCode === null ? 'allowed' : 'error',
      ...(outcome.exitCode !== null && outcome.exitCode !== 0 ? { reason: `exit ${outcome.exitCode} (fail-open)` } : {}),
      duration_ms: duration,
    });
  }
  return { notes, executions };
}

/** Format one post-hook note the way it is appended to a tool result. */
export function hookNoteLine(note: string): string {
  return `hook: ${note}`;
}
