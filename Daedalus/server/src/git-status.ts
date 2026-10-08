import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The Web's git surface: worktree status for the panel, plus a narrow
 * per-file revert. Shells out to the user's own git in the workspace
 * root — the same state the terminal would show — and never touches
 * remotes, the index beyond the one requested file, or branches.
 */

const run = promisify(execFile);

export type GitFileStatusKind = "untracked" | "added" | "modified" | "deleted" | "renamed" | "changed";

export type GitFileStatus = { path: string; status: GitFileStatusKind };

export type WorkspaceGitStatus = { isRepo: boolean; branch: string | null; files: GitFileStatus[] };

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** `git status --porcelain=v1` lines: two status letters, a space, path. */
export function parseGitPorcelain(text: string): GitFileStatus[] {
  const files: GitFileStatus[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    // Renames arrive as "old -> new": the live file is the destination.
    const arrow = path.lastIndexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (!path) continue;
    let status: GitFileStatusKind = "changed";
    if (code === "??") status = "untracked";
    else if (code.includes("R")) status = "renamed";
    else if (code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("M")) status = "modified";
    files.push({ path, status });
  }
  return files;
}

export async function gitStatus(root: string): Promise<WorkspaceGitStatus> {
  let isRepo = false;
  try {
    isRepo = (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    isRepo = false;
  }
  if (!isRepo) return { isRepo: false, branch: null, files: [] };
  const [branchOut, porcelain] = await Promise.all([
    git(root, ["branch", "--show-current"]).catch(() => ""),
    git(root, ["status", "--porcelain=v1"]),
  ]);
  return { isRepo: true, branch: branchOut.trim() || null, files: parseGitPorcelain(porcelain) };
}

export type RevertOutcome =
  | { ok: true }
  | { ok: false; reason: "not_a_repo" | "not_changed" | "untracked" };

/**
 * Restore one changed file to its HEAD content (index + worktree).
 * Refuses files git does not currently list as changed, and untracked
 * files — deleting a file the agent created is an editor action, and a
 * button labelled "revert" must not quietly become "delete".
 */
export async function revertFileToHead(root: string, relativePath: string): Promise<RevertOutcome> {
  const status = await gitStatus(root);
  if (!status.isRepo) return { ok: false, reason: "not_a_repo" };
  const entry = status.files.find((file) => file.path === relativePath);
  if (!entry) return { ok: false, reason: "not_changed" };
  if (entry.status === "untracked") return { ok: false, reason: "untracked" };
  await git(root, ["checkout", "HEAD", "--", relativePath]);
  return { ok: true };
}
