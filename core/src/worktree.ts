import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Git worktree-per-task isolation: a task runs in its own checkout on its
 * own `daedalus/<task>` branch, so parallel tasks never fight over the same
 * working tree. The worktree and branch are KEPT after the run for review;
 * nothing is merged automatically — `daedalus apply <task-id>` applies the
 * worktree's diff to the main workspace as a patch (refusing on conflicts)
 * and then removes the worktree. Worktree isolation requires git: a
 * non-git workspace fails loudly before the task runs, never silently
 * falls back to running in the shared tree.
 */

export type WorktreeRecord = {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Branch created for the task (`daedalus/<task-id-short>`). */
  branch: string;
  /** Absolute path of the main workspace the worktree was created from. */
  workspace: string;
  created_at: string;
};

export function taskBranchName(taskId: string): string {
  return `daedalus/${taskId.slice(0, 8)}`;
}

export function worktreePathFor(daedalusHome: string, taskId: string): string {
  return join(daedalusHome, 'worktrees', taskId);
}

type GitResult = { code: number; stdout: string; stderr: string };

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function gitOrThrow(cwd: string, args: string[], context: string): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`;
    throw new Error(`worktree isolation: ${context} failed: ${detail}`);
  }
  return result.stdout;
}

/** True when `git` runs and the directory is inside a git work tree. */
export async function isGitWorkTree(workspaceRoot: string): Promise<boolean> {
  try {
    const result = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
    return result.code === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Create the task's worktree on a fresh branch. Throws a clear error —
 * before anything runs — when git is missing or the workspace is not a
 * git repository.
 */
export async function createTaskWorktree(options: {
  workspaceRoot: string;
  daedalusHome: string;
  taskId: string;
}): Promise<WorktreeRecord> {
  const probe = await runGit(options.workspaceRoot, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined);
  if (!probe || probe.code !== 0) {
    throw new Error(
      `worktree isolation requires git: could not run git in ${options.workspaceRoot} (${probe?.stderr.trim() || 'git unavailable'}). ` +
      'Run the task without --isolation in a non-git workspace.',
    );
  }
  if (probe.stdout.trim() !== 'true') {
    throw new Error(
      `worktree isolation requires a git repository: ${options.workspaceRoot} is not inside a git work tree. ` +
      'Initialise git there (git init) or run the task without --isolation.',
    );
  }
  const branch = taskBranchName(options.taskId);
  const path = worktreePathFor(options.daedalusHome, options.taskId);
  await mkdir(dirname(path), { recursive: true });
  await gitOrThrow(options.workspaceRoot, ['worktree', 'add', '-b', branch, path, 'HEAD'], `creating worktree ${path}`);
  return { path, branch, workspace: options.workspaceRoot, created_at: new Date().toISOString() };
}

/** Workspace-relative paths a worktree changed (modified, added, deleted, renamed-to). */
export async function worktreeChangedFiles(worktreePath: string): Promise<string[]> {
  const stdout = await gitOrThrow(worktreePath, ['status', '--porcelain=v1', '-uall'], 'reading worktree status');
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let path = line.slice(3);
    const rename = path.indexOf(' -> ');
    if (rename >= 0) path = path.slice(rename + 4);
    files.push(path.replace(/^"|"$/g, ''));
  }
  return files;
}

/** Full patch of everything the worktree changed (staged in place to capture untracked files). */
export async function worktreePatch(worktreePath: string): Promise<string> {
  await gitOrThrow(worktreePath, ['add', '-A'], 'staging worktree changes');
  return gitOrThrow(worktreePath, ['diff', '--cached', '--binary'], 'diffing worktree changes');
}

/**
 * Apply the worktree's changes to the main workspace as a patch. Refuses —
 * leaving both trees untouched — when the patch does not apply cleanly.
 * Does not remove the worktree; call `removeTaskWorktree` after a
 * successful apply.
 */
export async function applyTaskWorktree(options: {
  workspaceRoot: string;
  record: WorktreeRecord;
}): Promise<{ applied: string[]; patch: string }> {
  const applied = await worktreeChangedFiles(options.record.path);
  const patch = await worktreePatch(options.record.path);
  if (patch.trim() === '') return { applied: [], patch };
  const applyCheck = await gitWithInput(options.workspaceRoot, ['apply', '--check', '--whitespace=nowarn'], patch);
  if (!applyCheck.ok) {
    throw new Error(
      `cannot apply worktree ${options.record.branch} to ${options.workspaceRoot}: the patch conflicts with the current workspace ` +
      `(${applyCheck.stderr.split('\n').find((line) => line.trim()) ?? 'apply check failed'}). The worktree was kept at ${options.record.path} for manual merging.`,
    );
  }
  const appliedResult = await gitWithInput(options.workspaceRoot, ['apply', '--whitespace=nowarn'], patch);
  if (!appliedResult.ok) {
    throw new Error(`cannot apply worktree ${options.record.branch}: ${appliedResult.stderr.trim() || 'git apply failed'}. The worktree was kept at ${options.record.path}.`);
  }
  return { applied, patch };
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolvePromise({ ok: !error, stderr: String(stderr) });
    });
    child.stdin?.end(input);
  });
}

/** Remove the task worktree and delete its branch (after a successful apply, or on demand). */
export async function removeTaskWorktree(options: {
  workspaceRoot: string;
  record: WorktreeRecord;
}): Promise<void> {
  await gitOrThrow(options.workspaceRoot, ['worktree', 'remove', '--force', options.record.path], `removing worktree ${options.record.path}`);
  await gitOrThrow(options.workspaceRoot, ['branch', '-D', options.record.branch], `deleting branch ${options.record.branch}`);
}
