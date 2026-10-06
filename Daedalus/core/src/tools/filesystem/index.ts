import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';

const MAX_OUTPUT = 16_000;

/**
 * Directories the file tools never descend into or list: dependency/vendor
 * trees, VCS metadata, and Daedalus's own state (`.daedalus/` holds the
 * task store — expanding it into a listing floods the model's context with
 * dozens of unrelated task directories and teaches it nothing about the
 * user's project). Shared by list_dir, the search tools, and path helpers.
 */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', '.daedalus', 'dist']);

/** Hard cap on entries emitted by one list_dir call; the remainder is counted and reported, not dumped. */
export const MAX_LIST_ENTRIES = 150;

/**
 * Walk a directory into shallow-tree lines (directories first, ignored
 * directories pruned). Lines stop at `maxEntries`, but the walk keeps
 * counting (up to `countLimit`) so callers can report how much was omitted.
 */
export async function walkTreeLines(
  dir: string,
  options: { maxDepth?: number; maxEntries?: number; countLimit?: number } = {},
): Promise<{ lines: string[]; total: number; truncated: boolean }> {
  const maxDepth = options.maxDepth ?? 3;
  const maxEntries = options.maxEntries ?? MAX_LIST_ENTRIES;
  const countLimit = options.countLimit ?? 5_000;
  const lines: string[] = [];
  let total = 0;
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => !(entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)))
      .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
    for (const entry of entries) {
      total++;
      if (lines.length < maxEntries) lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth < maxDepth && total < countLimit) await walk(join(current, entry.name), `${prefix}  `, depth + 1);
      if (total >= countLimit) return;
    }
  };
  await walk(dir, '', 1);
  return { lines, total, truncated: total > lines.length };
}

/**
 * Resolve a workspace-relative target to an absolute path, throwing if it escapes
 * the resolved workspace root. Returns the resolved absolute path.
 */
export async function pathInWorkspace(root: string, target: string): Promise<string> {
  const base = await realpath(root);
  const path = resolve(base, target);
  if (relative(base, path).startsWith('..') || relative(base, path) === '..') throw new Error('path escapes workspace root');
  return path;
}

export async function confined(root: string, target: string): Promise<string> {
  return pathInWorkspace(root, target);
}

function output(callId: string, text: string, meta: Record<string, unknown> = {}): ToolResult {
  const truncated = text.length > MAX_OUTPUT;
  return { call_id: callId, status: 'ok', output: truncated ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text, truncated, meta };
}

/** If a model uses a plausible but wrong path, point it at the one matching file instead of a dead-end ENOENT. */
async function pathSuggestion(root: string, requested: string): Promise<string | undefined> {
  const wanted = basename(requested);
  if (!wanted || wanted === '.' || wanted === '/') return undefined;
  try {
    const base = await realpath(root);
    const matches: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 6 || matches.length > 1) return;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        const full = join(current, entry.name);
        if (entry.isFile() && entry.name === wanted) matches.push(relative(base, full));
        else if (entry.isDirectory()) await walk(full, depth + 1);
        if (matches.length > 1) return;
      }
    };
    await walk(base, 1);
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

async function errorWithSuggestion(error: unknown, root: string, requested: string): Promise<string> {
  const message = String(error);
  if (!message.includes('ENOENT')) return message;
  const suggestion = await pathSuggestion(root, requested);
  return suggestion ? `${message}\nPath not found. A unique file with this name exists at: ${suggestion}. Retry with that exact path.` : message;
}

/**
 * Resolve a read/edit target. If the requested path is missing but exactly one
 * workspace file has that basename, use it and report the resolution; models
 * often know the file name and content but drop a leading `src/` segment.
 */
async function resolveExistingPath(root: string, requested: string): Promise<{ target: string; resolvedPath?: string }> {
  const target = await pathInWorkspace(root, requested);
  try {
    const info = await stat(target);
    if (info.isFile()) return { target };
  } catch {
    const suggestion = await pathSuggestion(root, requested);
    if (suggestion) return { target: await pathInWorkspace(root, suggestion), resolvedPath: suggestion };
  }
  return { target };
}

/**
 * Last-resort edit target resolution: if the model supplied the wrong path
 * but an exact `old_string` occurs once in the whole workspace, that file is
 * the unambiguous edit target. This is bounded to small text files.
 */
async function findUniqueOldString(root: string, oldString: string): Promise<string | undefined> {
  if (!oldString) return undefined;
  try {
    const base = await realpath(root);
    let found: string | undefined;
    let total = 0;
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 6 || total > 1) return;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) {
          try {
            const info = await stat(full);
            if (info.size > 200_000) continue;
            const data = await readFile(full, 'utf8');
            const count = data.split(oldString).length - 1;
            if (count > 0) { total += count; found = relative(base, full); }
          } catch { /* ignore unreadable/binary files */ }
        }
        if (total > 1) return;
      }
    };
    await walk(base, 1);
    return total === 1 ? found : undefined;
  } catch {
    return undefined;
  }
}

export const readFileTool: ToolDefinition = {
  name: 'read_file', description: 'Read a UTF-8 text file, optionally by 1-based inclusive line range.', mutating: false,
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; start_line?: unknown; end_line?: unknown };
    if (typeof a.path !== 'string') return { call_id: '', status: 'error', output: 'path must be a string', truncated: false, meta: {} };
    try {
      const resolved = await resolveExistingPath(context.workspaceRoot, a.path);
      const data = await readFile(resolved.target, 'utf8');
      const lines = data.split('\n');
      const start = typeof a.start_line === 'number' ? Math.max(1, a.start_line) : 1;
      const end = typeof a.end_line === 'number' ? Math.min(lines.length, a.end_line) : lines.length;
      const text = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
      return output('', text, { start_line: start, end_line: end, total_lines: lines.length, ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: a.path } : {}) });
    } catch (error) { return { call_id: '', status: 'error', output: await errorWithSuggestion(error, context.workspaceRoot, a.path), truncated: false, meta: {} }; }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file', description: 'Create or overwrite a UTF-8 file inside the workspace.', mutating: true,
  inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; content?: unknown };
    if (typeof a.path !== 'string' || typeof a.content !== 'string') return { call_id: '', status: 'error', output: 'path and content must be strings', truncated: false, meta: {} };
    try {
      const target = await pathInWorkspace(context.workspaceRoot, a.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, a.content, 'utf8');
      return { call_id: '', status: 'ok', output: `wrote ${a.path}`, truncated: false, meta: { path: a.path, bytes: Buffer.byteLength(a.content) } };
    }
    catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

export const createDirTool: ToolDefinition = {
  name: 'create_dir', description: 'Create a directory (and any missing parents) inside the workspace.', mutating: true,
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown };
    if (typeof a.path !== 'string' || a.path.trim().length === 0) return { call_id: '', status: 'error', output: 'path must be a non-empty string', truncated: false, meta: {} };
    try {
      const target = await pathInWorkspace(context.workspaceRoot, a.path);
      await mkdir(target, { recursive: true });
      return { call_id: '', status: 'ok', output: `created directory ${a.path}`, truncated: false, meta: { path: a.path } };
    } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file', description: 'Replace one unique exact string in a UTF-8 file.', mutating: true,
  inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; old_string?: unknown; new_string?: unknown };
    if (typeof a.path !== 'string' || typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return { call_id: '', status: 'error', output: 'path, old_string, and new_string must be strings', truncated: false, meta: {} };
    try {
      const resolved = await resolveExistingPath(context.workspaceRoot, a.path); const data = await readFile(resolved.target, 'utf8');
      const count = data.split(a.old_string).length - 1;
      if (count !== 1) {
        const byContent = await findUniqueOldString(context.workspaceRoot, a.old_string);
        if (byContent && byContent !== resolved.resolvedPath) {
          const target = await pathInWorkspace(context.workspaceRoot, byContent);
          const content = await readFile(target, 'utf8');
          await writeFile(target, content.replace(a.old_string, a.new_string), 'utf8');
          return { call_id: '', status: 'ok', output: `edited ${byContent} (resolved from ${a.path} by unique old_string match)`, truncated: false, meta: { path: byContent, replacements: 1, resolved_path: byContent, requested_path: a.path, resolved_by: 'old_string' } };
        }
        return { call_id: '', status: 'error', output: count === 0 ? 'old_string not found' : `old_string matched ${count} times; match must be unique`, truncated: false, meta: { matches: count } };
      }
      await writeFile(resolved.target, data.replace(a.old_string, a.new_string), 'utf8');
      const shownPath = resolved.resolvedPath ?? a.path;
      return { call_id: '', status: 'ok', output: resolved.resolvedPath ? `edited ${shownPath} (resolved from ${a.path})` : `edited ${a.path}`, truncated: false, meta: { path: shownPath, replacements: 1, ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: a.path } : {}) } };
    } catch (error) {
      const byContent = await findUniqueOldString(context.workspaceRoot, a.old_string);
      if (byContent) {
        try {
          const target = await pathInWorkspace(context.workspaceRoot, byContent);
          const content = await readFile(target, 'utf8');
          if (content.split(a.old_string).length - 1 === 1) {
            await writeFile(target, content.replace(a.old_string, a.new_string), 'utf8');
            return { call_id: '', status: 'ok', output: `edited ${byContent} (resolved from ${a.path} by unique old_string match)`, truncated: false, meta: { path: byContent, replacements: 1, resolved_path: byContent, requested_path: a.path, resolved_by: 'old_string' } };
          }
        } catch { /* fall through to original error */ }
      }
      return { call_id: '', status: 'error', output: await errorWithSuggestion(error, context.workspaceRoot, a.path), truncated: false, meta: {} };
    }
  },
};

export const listDirTool: ToolDefinition = {
  name: 'list_dir', description: 'List a workspace directory as a shallow tree (depth 3), so nested source files are visible without guessing paths. Dependency/state folders (node_modules, .git, .daedalus, dist) are omitted and very large listings are truncated with a count of what was left out.', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 6 } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; depth?: unknown }; const input = typeof a.path === 'string' ? a.path : '.';
    const maxDepth = typeof a.depth === 'number' && Number.isInteger(a.depth) ? Math.min(6, Math.max(1, a.depth)) : 3;
    try {
      const dir = await pathInWorkspace(context.workspaceRoot, input);
      const { lines, total, truncated } = await walkTreeLines(dir, { maxDepth });
      const text = truncated ? [...lines, `… (${total - lines.length} more entries, truncated)`].join('\n') : lines.join('\n');
      return output('', text, { path: input, depth: maxDepth, entries: lines.length, ...(truncated ? { truncated: true, total_entries: total } : {}) });
    }
    catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};