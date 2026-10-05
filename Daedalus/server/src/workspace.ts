import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Directories never worth listing in the workspace explorer. */
export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".daedalus",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".pytest_cache",
  ".mypy_cache",
]);

export const MAX_FILE_BYTES = 512 * 1024;

export type WorkspaceEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
};

export type WorkspaceTreeNode = WorkspaceEntry & { children?: WorkspaceTreeNode[] };

/** Reject any path that resolves outside the workspace root. */
export function resolveInside(root: string, target: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(absoluteRoot, target);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (rel.startsWith("..")) throw new Error("path escapes workspace root");
  return absoluteTarget;
}

export function isIgnored(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

/** Direct children of a directory, directories first, then files, each alphabetical. */
export function listDirectory(root: string, target: string): WorkspaceEntry[] {
  const absolute = resolveInside(root, target);
  const entries = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => !isIgnored(entry.name))
    .map((entry) => {
      const child = join(absolute, entry.name);
      const isDirectory = entry.isDirectory();
      let size: number | undefined;
      if (!isDirectory) {
        try {
          size = statSync(child).size;
        } catch {
          size = undefined;
        }
      }
      return { name: entry.name, path: relative(resolve(root), child), isDirectory, ...(size === undefined ? {} : { size }) };
    });
  return sortEntries(entries);
}

/**
 * Breadth-limited tree for the file explorer: `depth` levels of nesting, with
 * a global entry budget so a large monorepo cannot blow up the response.
 */
export function buildTree(root: string, target: string, depth: number, maxEntries = 2000): WorkspaceTreeNode {
  const entries = listDirectory(root, target);
  const budget = { remaining: Math.max(1, maxEntries - 1) };
  return {
    name: target === "." || target === "" ? baseName(root) : baseName(root, target),
    path: target,
    isDirectory: true,
    children: entries.map((entry) => {
      budget.remaining -= 1;
      const nested = entry.isDirectory && depth > 1 && budget.remaining > 0 ? buildTree(root, entry.path, depth - 1, budget.remaining).children : undefined;
      return { ...entry, ...(nested === undefined ? {} : { children: nested ?? [] }) };
    }),
  };
}

function baseName(root: string, target?: string): string {
  if (target !== undefined) return relative(resolve(root), resolveInside(root, target));
  const absolute = resolve(root);
  return absolute === "/" ? "/" : absolute.slice(absolute.lastIndexOf("/") + 1);
}

function absoluteName(root: string, target: string): string {
  return relative(resolve(root), resolveInside(root, target));
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Candidate workspace roots: the server cwd plus repositories already used by tasks. */
export function collectRoots(cwd: string, recorded: string[]): Array<{ path: string; name: string }> {
  const seen = new Set<string>();
  const roots: Array<{ path: string; name: string }> = [];
  for (const candidate of [cwd, ...recorded]) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    roots.push({ path: absolute, name: absolute === "/" ? "/" : absolute.slice(absolute.lastIndexOf("/") + 1) });
  }
  return roots;
}