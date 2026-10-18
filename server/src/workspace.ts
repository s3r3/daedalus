import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** One recently-modified file for the Dae Captain Workspace "Terbaru" section. */
export type RecentWorkspaceFile = { path: string; mtimeMs: number; size: number };

/** Recent-files budget: enough for the "Terbaru" section without unbounded walks. */
export const MAX_RECENT_FILE_ENTRIES = 50;

/** Flat file index budget: enough for @-mention completion in large repos without unbounded walks. */
export const MAX_FLAT_FILE_ENTRIES = 2000;

/** Reject any path that resolves outside the workspace root. */
const escapesRoot = (rel: string): boolean => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

export function resolveInside(root: string, target: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(absoluteRoot, target);
  // B21: cek leksikal dulu (juga perbaiki false positive "..data").
  if (escapesRoot(relative(absoluteRoot, absoluteTarget))) throw new Error("path escapes workspace root");
  // B21: cek lagi setelah symlink diselesaikan, pada leluhur terdekat yang
  // sudah ada (target boleh belum ada, mis. file baru).
  let probe = absoluteTarget;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (escapesRoot(relative(realpathSync(absoluteRoot), realpathSync(probe)))) throw new Error("path escapes workspace root");
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

/**
 * Files modified within the last `hours` hours (Dae Captain v2 Fase 8:
 * the Workspace page's "Terbaru" section), newest first. Same listing
 * hygiene as listFilesFlat: dotfiles/dot-dirs and IGNORED_DIRECTORIES
 * are pruned, symlinks are never descended. Additive — the flat index is
 * untouched.
 */
export function listRecentFiles(
  root: string,
  hours = 24,
  maxEntries = MAX_RECENT_FILE_ENTRIES,
): { files: RecentWorkspaceFile[]; truncated: boolean } {
  const absoluteRoot = resolve(root);
  const cutoff = Date.now() - Math.max(1, hours) * 3_600_000;
  const files: RecentWorkspaceFile[] = [];
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
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnored(entry.name)) continue;
        walk(child);
        continue;
      }
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) continue;
      if (files.length >= maxEntries) {
        truncated = true;
        return;
      }
      files.push({ path: relative(absoluteRoot, child), mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(absoluteRoot);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
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
  /**
   * The plan-mode task that produced these documents, resolved by the
   * server from the task store (null when unknown — e.g. documents copied
   * in by hand). Lets a plan execution carry plan_task_id even when the
   * producing task is not on screen, so the follow-up is never mistaken
   * for a fresh underspecified brief.
   */
  taskId: string | null;
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
      taskId: null,
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