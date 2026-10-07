import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** Images the Web file viewer previews as pictures (extension → media type). */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

/** Images read larger than text files: a preview is display-only, never editor text. */
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;

export type WorkspaceEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
};

export type WorkspaceTreeNode = WorkspaceEntry & { children?: WorkspaceTreeNode[] };

export type FlatWorkspaceEntry = { path: string; type: "file" | "dir" };

/** Flat file index budget: enough for @-mention completion in large repos without unbounded walks. */
export const MAX_FLAT_FILE_ENTRIES = 2000;

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

/**
 * Flat index of every mentionable workspace path (files and directories),
 * for @-completion in the composer. Mirrors the agent's own listing hygiene:
 * IGNORED_DIRECTORIES are pruned and hidden entries (dotfiles, dot-dirs —
 * which covers `.daedalus`/`.git` too) are skipped. Symlinks are reported as
 * files and never descended, so link cycles cannot loop the walk. The result
 * is sorted by path and capped; `truncated` says the cap cut entries off.
 */
export function listFilesFlat(root: string, maxEntries = MAX_FLAT_FILE_ENTRIES): { files: FlatWorkspaceEntry[]; truncated: boolean } {
  const absoluteRoot = resolve(root);
  const files: FlatWorkspaceEntry[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      const isDirectory = entry.isDirectory();
      if (isDirectory && isIgnored(entry.name)) continue;
      if (files.length >= maxEntries) {
        truncated = true;
        return;
      }
      const child = join(dir, entry.name);
      files.push({ path: relative(absoluteRoot, child), type: isDirectory ? "dir" : "file" });
      if (isDirectory) walk(child);
    }
  };
  walk(absoluteRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

/** One plan produced by Plan mode: a folder under `.daedalus/plans/`. */
export type PlanDocumentGroup = {
  slug: string;
  /** Workspace-relative paths of the documents, plan.md first when present. */
  documents: string[];
  /** First markdown heading in plan.md/the first doc, when cheap to read. */
  title: string | null;
  /** Newest document mtime, ISO; null when unreadable. */
  updatedAt: string | null;
};

export const MAX_PLAN_DOCUMENTS = 50;

/**
 * Plan-mode output for one workspace: every slug folder under
 * `.daedalus/plans/`, newest first. Surfaced to the Web as persistent plan
 * chips above the composer, since `@`-mention completion prunes `.daedalus`
 * (hidden entries) and never sees them. A missing plans folder is a plain
 * empty list. Nothing outside `.daedalus/plans/` is read.
 */
export function listPlanDocuments(root: string): PlanDocumentGroup[] {
  const absoluteRoot = resolve(root);
  const plansDir = join(absoluteRoot, ".daedalus", "plans");
  let entries;
  try {
    entries = readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const groups: PlanDocumentGroup[] = [];
  for (const entry of entries) {
    if (groups.length >= MAX_PLAN_DOCUMENTS) break;
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = join(plansDir, slug);
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const markdown = files.filter((file) => file.isFile() && file.name.toLowerCase().endsWith(".md"));
    if (markdown.length === 0) continue;
    const names = markdown.map((file) => file.name).sort((a, b) => a.localeCompare(b));
    const ordered = [...names.filter((name) => name.toLowerCase() === "plan.md"), ...names.filter((name) => name.toLowerCase() !== "plan.md")];
    let updatedAtMs = 0;
    let title: string | null = null;
    for (const name of names) {
      try {
        updatedAtMs = Math.max(updatedAtMs, statSync(join(dir, name)).mtimeMs);
      } catch {
        /* an unreadable stat degrades to no timestamp, never a failed list */
      }
    }
    const titleSource = ordered[0];
    if (titleSource) {
      try {
        const heading = readFileSync(join(dir, titleSource), "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.startsWith("#"));
        title = heading ? heading.replace(/^#+\s*/, "").trim() || null : null;
      } catch {
        title = null;
      }
    }
    groups.push({
      slug,
      documents: ordered.map((name) => `.daedalus/plans/${slug}/${name}`),
      title,
      updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : null,
    });
  }
  groups.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.slug.localeCompare(b.slug));
  return groups;
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