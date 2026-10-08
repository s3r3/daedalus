import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';
import { applySearchReplace } from './search-replace.ts';
import { applyWhitespaceTolerant } from './text-match.ts';
import { diffLines } from './diff.ts';

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

/**
 * read_file's own serving budget, aligned with the loop's tool-output
 * shaping caps (50k chars / 2000 lines) so the two layers agree on what
 * "fits". The old shared `output()` helper sliced at 16k chars with a
 * bare "…[truncated]" — a normal ~200-line source file exceeded that
 * and the model never saw its tail, which is how a read loop starts
 * (the model re-reads, gets the same first page, re-reads…). read_file
 * now paginates by whole lines inside the budget and states exactly
 * what was shown and how to continue.
 */
export const READ_FILE_MAX_LINES = 2_000;
export const READ_FILE_MAX_CHARS = 50_000;

/** Max files one read_file call may serve via `paths` (Cline read_files shape). */
export const READ_FILE_MAX_BATCH = 8;

type ReadRangeArgs = { start_line?: unknown; end_line?: unknown; offset?: unknown; limit?: unknown };

async function serveOneFile(root: string, requestedPath: string, a: ReadRangeArgs): Promise<ToolResult> {
  try {
    const resolved = await resolveExistingPath(root, requestedPath);
    const data = await readFile(resolved.target, 'utf8');
    const lines = data.split('\n');
    const total = lines.length;
    // offset is the 1-based first line (same anchor as start_line; offset wins).
    const startInput = typeof a.offset === 'number' ? a.offset : a.start_line;
    const start = typeof startInput === 'number' ? Math.max(1, Math.floor(startInput)) : 1;
    const shownPath = resolved.resolvedPath ?? requestedPath;
    if (total === 0 || (total === 1 && lines[0] === '')) {
      return output('', `[read_file ${shownPath} — empty file (0 lines)]`, { start_line: 1, end_line: 0, total_lines: 0, ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: requestedPath } : {}) });
    }
    if (start > total) {
      return output('', `[read_file ${shownPath} — past end of file: the file has ${total} line${total === 1 ? '' : 's'}; offset ${start} is beyond it. Read with offset 1 to start from the top.]`, { start_line: start, end_line: total, total_lines: total, ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: requestedPath } : {}) });
    }
    let end = typeof a.end_line === 'number' ? Math.min(total, Math.floor(a.end_line)) : total;
    if (typeof a.limit === 'number') end = Math.min(end, start + Math.max(1, Math.floor(a.limit)) - 1);
    end = Math.max(start, end);
    // Serve whole lines within the line + char budgets; narrow the
    // page instead of slicing a line in half (a mid-line cut is what
    // made re-reads rational — the model never saw the file's tail).
    let servedEnd = start - 1;
    let chars = 0;
    let charCut = false;
    for (let line = start; line <= end && servedEnd - start + 1 < READ_FILE_MAX_LINES; line++) {
      const rendered = `${line}: ${lines[line - 1] ?? ''}`;
      if (chars + rendered.length + 1 > READ_FILE_MAX_CHARS) {
        if (servedEnd < start) {
          // Even the first line exceeds the char budget (a minified
          // or generated single-line file): serve a bounded slice.
          servedEnd = line;
          charCut = true;
        }
        break;
      }
      chars += rendered.length + 1;
      servedEnd = line;
    }
    const header = `[read_file ${shownPath} — lines ${start}–${servedEnd} of ${total}]`;
    const body = charCut
      ? `${start}: ${(lines[start - 1] ?? '').slice(0, READ_FILE_MAX_CHARS)}`
      : lines.slice(start - 1, servedEnd).map((line, i) => `${start + i}: ${line}`).join('\n');
    const partial = servedEnd < total || charCut;
    const footer = !partial
      ? undefined
      : charCut
        ? `…[truncated] PARTIAL view — line ${start} alone exceeds the ${READ_FILE_MAX_CHARS}-char read budget and was cut mid-line; the rest of that line is not pageable with read_file (use run_command with head/cut for byte ranges, or read another range with offset/limit).`
        : `…[truncated] PARTIAL view — shown lines ${start}–${servedEnd} of ${total} total (${servedEnd - start + 1} lines received). Continue with read_file(path="${shownPath}", offset=${servedEnd + 1}, limit=${Math.max(1, servedEnd - start + 1)}) for the next page.`;
    const text = [header, body, ...(footer ? [footer] : [])].join('\n');
    const result: ToolResult = {
      call_id: '',
      status: 'ok',
      output: text,
      truncated: partial,
      meta: {
        start_line: start,
        end_line: servedEnd,
        total_lines: total,
        ...(partial ? { partial: true } : {}),
        ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: requestedPath } : {}),
      },
    };
    return result;
  } catch (error) { return { call_id: '', status: 'error', output: await errorWithSuggestion(error, root, requestedPath), truncated: false, meta: {} }; }
}

export const readFileTool: ToolDefinition = {
  name: 'read_file', description: 'Read UTF-8 text file(s) by 1-based line range: start_line/end_line, or offset (first line) + limit (max lines). Pass `paths` (up to 8) to read several files in one call — comparing two files (an App.tsx and its App.css) costs one step, not two. Use offset/limit to page through a spilled tool-output file or any long file instead of re-running the tool that produced it.', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: READ_FILE_MAX_BATCH }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; paths?: unknown } & ReadRangeArgs;
    if (Array.isArray(a.paths) && a.paths.length > 0) {
      if (a.paths.length > READ_FILE_MAX_BATCH) return { call_id: '', status: 'error', output: `paths may list at most ${READ_FILE_MAX_BATCH} files per call`, truncated: false, meta: {} };
      if (!a.paths.every((p) => typeof p === 'string')) return { call_id: '', status: 'error', output: 'paths must be an array of strings', truncated: false, meta: {} };
      const sections: string[] = [];
      const perFile: Array<Record<string, unknown>> = [];
      let anyOk = false;
      let anyTruncated = false;
      for (const path of a.paths as string[]) {
        const result = await serveOneFile(context.workspaceRoot, path, a);
        perFile.push({ path, status: result.status, ...result.meta });
        if (result.status === 'ok') anyOk = true;
        if (result.truncated) anyTruncated = true;
        sections.push(result.status === 'ok' ? result.output : `[read_file ${path} — error: ${result.output}]`);
      }
      return { call_id: '', status: anyOk ? 'ok' : 'error', output: sections.join('\n\n'), truncated: anyTruncated, meta: { files: perFile.length, per_file: perFile } };
    }
    if (typeof a.path !== 'string') return { call_id: '', status: 'error', output: 'path must be a string (or pass paths: an array of up to 8 paths)', truncated: false, meta: {} };
    return serveOneFile(context.workspaceRoot, a.path, a);
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

type EditSpec = { old_string: string; new_string: string };

type ApplyEditOutcome =
  | { ok: true; content: string; occurrences: number; tolerant: boolean }
  | { ok: false; reason: 'not_found' | 'ambiguous'; count: number };

/**
 * One replacement, strict-first: byte-exact unique match; with
 * replace_all, every exact occurrence; otherwise a unique
 * whitespace-tolerant match (indentation slip) — never a fuzzy guess.
 */
function applyOneEdit(content: string, edit: EditSpec, replaceAll: boolean): ApplyEditOutcome {
  const exact = content.split(edit.old_string).length - 1;
  if (replaceAll && exact > 0) return { ok: true, content: content.split(edit.old_string).join(edit.new_string), occurrences: exact, tolerant: false };
  if (exact === 1) return { ok: true, content: content.replace(edit.old_string, () => edit.new_string), occurrences: 1, tolerant: false };
  if (exact > 1) return { ok: false, reason: 'ambiguous', count: exact };
  const tolerant = applyWhitespaceTolerant(content, edit.old_string, edit.new_string);
  if (tolerant) return { ok: true, content: tolerant.content, occurrences: 1, tolerant: true };
  return { ok: false, reason: 'not_found', count: 0 };
}

const HUNK_PREVIEW_MAX_LINES = 40;

/**
 * The changed hunk, shown back to the model after its own edit
 * (SWE-agent's re-display): changed lines with one line of context,
 * collapsed elsewhere. The model verifies what it actually did instead
 * of trusting its intent — a wrong-but-applied edit is visible here.
 */
export function hunkPreview(before: string, after: string): string {
  const lines = diffLines(before, after);
  if (lines.length === 0) return '';
  const keep = lines.map((line, index) => line.kind !== 'context'
    || (lines[index - 1] !== undefined && lines[index - 1]!.kind !== 'context')
    || (lines[index + 1] !== undefined && lines[index + 1]!.kind !== 'context'));
  const out: string[] = [];
  let hiddenRun = 0;
  let changedShown = 0;
  const flushHidden = (): void => {
    if (hiddenRun > 0) out.push(`  … (${hiddenRun} unchanged line${hiddenRun === 1 ? '' : 's'})`);
    hiddenRun = 0;
  };
  for (const [index, line] of lines.entries()) {
    if (!keep[index]) { hiddenRun++; continue; }
    flushHidden();
    if (out.length >= HUNK_PREVIEW_MAX_LINES) break;
    if (line.kind !== 'context') changedShown++;
    out.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`);
  }
  flushHidden();
  const totalChanged = lines.filter((line) => line.kind !== 'context').length;
  if (changedShown < totalChanged) out.push(`… (${totalChanged - changedShown} more changed lines not shown — re-read the file to see the rest)`);
  return out.join('\n');
}

function editSuccessOutput(verb: string, shownPath: string, editsApplied: number, replacements: number, tolerantNotes: string[], before: string, after: string): string {
  const head = editsApplied > 1
    ? `${verb} ${shownPath} (${editsApplied} edits, ${replacements} replacement${replacements === 1 ? '' : 's'})`
    : `${verb} ${shownPath}`;
  const hunk = hunkPreview(before, after);
  return [head, ...tolerantNotes, ...(hunk ? ['changed hunk now in the file:', hunk] : [])].join('\n');
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file', description: 'Replace exact strings in a UTF-8 file: one edit via old_string/new_string, or several sequential edits in one call via edits[] (atomic — every edit applies or none is written). Set replace_all: true to replace every occurrence of the anchor. An anchor that differs only in indentation still applies (whitespace-tolerant, and the result says so). The result shows the changed hunk so you can verify what actually landed.', mutating: true,
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, edits: { type: 'array', items: { type: 'object', required: ['old_string', 'new_string'], properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, additionalProperties: false } }, replace_all: { type: 'boolean' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; old_string?: unknown; new_string?: unknown; edits?: unknown; replace_all?: unknown };
    if (typeof a.path !== 'string') return { call_id: '', status: 'error', output: 'path must be a string', truncated: false, meta: {} };
    const specs: EditSpec[] = [];
    if (Array.isArray(a.edits) && a.edits.length > 0) {
      for (const [index, item] of a.edits.entries()) {
        const candidate = item as { old_string?: unknown; new_string?: unknown };
        if (typeof candidate?.old_string !== 'string' || typeof candidate?.new_string !== 'string') {
          return { call_id: '', status: 'error', output: `edits[${index}] needs string old_string and new_string`, truncated: false, meta: {} };
        }
        specs.push({ old_string: candidate.old_string, new_string: candidate.new_string });
      }
    } else if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      specs.push({ old_string: a.old_string, new_string: a.new_string });
    } else {
      return { call_id: '', status: 'error', output: 'provide old_string + new_string, or edits[] with one entry per replacement', truncated: false, meta: {} };
    }
    if (specs.some((spec) => spec.old_string.length === 0)) return { call_id: '', status: 'error', output: 'old_string must not be empty', truncated: false, meta: {} };
    const replaceAll = a.replace_all === true;
    const single = specs.length === 1 ? specs[0]! : undefined;

    // Apply the edit list to `content`; returns the success result or a
    // typed failure the caller may still retarget by unique old_string.
    const applyTo = async (target: string, shownPath: string, content: string, headOverride?: string): Promise<ToolResult> => {
      let current = content;
      let replacements = 0;
      const tolerantNotes: string[] = [];
      for (const [index, spec] of specs.entries()) {
        const outcome = applyOneEdit(current, spec, replaceAll);
        if (!outcome.ok) {
          const label = specs.length > 1 ? `edit ${index + 1} of ${specs.length}: ` : '';
          if (outcome.reason === 'ambiguous') {
            return { call_id: '', status: 'error', output: `${label}old_string matched ${outcome.count} times; match must be unique (or set replace_all: true)`, truncated: false, meta: { matches: outcome.count } };
          }
          return { call_id: '', status: 'error', output: `${label}old_string not found — no exact match and no unique whitespace-tolerant match either. Re-read the file and copy the anchor exactly.`, truncated: false, meta: { matches: 0 } };
        }
        current = outcome.content;
        replacements += outcome.occurrences;
        if (outcome.tolerant) tolerantNotes.push(`note: edit ${specs.length > 1 ? `${index + 1} ` : ''}matched with whitespace tolerance — the file's own indentation was kept; verify that block below.`);
      }
      await writeFile(target, current, 'utf8');
      const outputText = headOverride
        ? [headOverride, ...tolerantNotes, ...(hunkPreview(content, current) ? ['changed hunk now in the file:', hunkPreview(content, current)] : [])].join('\n')
        : editSuccessOutput('edited', shownPath, specs.length, replacements, tolerantNotes, content, current);
      return { call_id: '', status: 'ok', output: outputText, truncated: false, meta: { path: shownPath, replacements, edits: specs.length, ...(tolerantNotes.length > 0 ? { whitespace_tolerant: true } : {}), ...(headOverride ? { resolved_path: shownPath, requested_path: a.path, resolved_by: 'old_string' } : {}) } };
    };

    try {
      const resolved = await resolveExistingPath(context.workspaceRoot, a.path);
      const data = await readFile(resolved.target, 'utf8');
      const result = await applyTo(resolved.target, resolved.resolvedPath ?? a.path, data);
      if (result.status === 'error' && single && result.meta.matches === 0) {
        // Legacy retarget: the model named the wrong file but the anchor
        // exists exactly once somewhere — that file is the edit target.
        const byContent = await findUniqueOldString(context.workspaceRoot, single.old_string);
        if (byContent && byContent !== (resolved.resolvedPath ?? a.path)) {
          const target = await pathInWorkspace(context.workspaceRoot, byContent);
          const content = await readFile(target, 'utf8');
          const retargeted = await applyTo(target, byContent, content, `edited ${byContent} (resolved from ${a.path} by unique old_string match)`);
          if (retargeted.status === 'ok') return retargeted;
        }
      }
      if (result.status === 'ok' && resolved.resolvedPath) {
        return { ...result, output: result.output.replace(`edited ${resolved.resolvedPath}`, `edited ${resolved.resolvedPath} (resolved from ${a.path})`), meta: { ...result.meta, resolved_path: resolved.resolvedPath, requested_path: a.path } };
      }
      return result;
    } catch (error) {
      if (single) {
        const byContent = await findUniqueOldString(context.workspaceRoot, single.old_string);
        if (byContent) {
          try {
            const target = await pathInWorkspace(context.workspaceRoot, byContent);
            const content = await readFile(target, 'utf8');
            const retargeted = await applyTo(target, byContent, content, `edited ${byContent} (resolved from ${a.path} by unique old_string match)`);
            if (retargeted.status === 'ok') return retargeted;
          } catch { /* fall through to original error */ }
        }
      }
      return { call_id: '', status: 'error', output: await errorWithSuggestion(error, context.workspaceRoot, a.path as string), truncated: false, meta: {} };
    }
  },
};

export const editSearchReplaceTool: ToolDefinition = {
  name: 'edit_search_replace', description: [
    'Edit an existing UTF-8 file with Aider-style SEARCH/REPLACE blocks instead of JSON string arguments.',
    'Put one or more blocks in `replacements`, each exactly:',
    '<<<<<<< SEARCH',
    '<lines copied byte-exact from the current file>',
    '=======',
    '<the lines that replace them>',
    '>>>>>>> REPLACE',
    'Each SEARCH anchor must appear exactly once in the file; on any mismatch nothing is written and the error tells you how to fix the anchor.',
  ].join('\n'), mutating: true,
  inputSchema: { type: 'object', required: ['path', 'replacements'], properties: { path: { type: 'string' }, replacements: { type: 'string', description: 'One or more SEARCH/REPLACE blocks in the format described above.' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; replacements?: unknown };
    if (typeof a.path !== 'string' || typeof a.replacements !== 'string') return { call_id: '', status: 'error', output: 'path and replacements must be strings', truncated: false, meta: {} };
    try {
      const resolved = await resolveExistingPath(context.workspaceRoot, a.path);
      const data = await readFile(resolved.target, 'utf8');
      const applied = applySearchReplace(data, a.replacements, a.path);
      if ('error' in applied) return { call_id: '', status: 'error', output: applied.error, truncated: false, meta: { path: a.path, reason: 'search_replace_mismatch' } };
      await writeFile(resolved.target, applied.content, 'utf8');
      const shownPath = resolved.resolvedPath ?? a.path;
      const hunk = hunkPreview(data, applied.content);
      const outputText = [
        `edited ${shownPath} (${applied.applied} SEARCH/REPLACE block${applied.applied === 1 ? '' : 's'} applied)`,
        ...(applied.tolerant > 0 ? [`note: ${applied.tolerant} block${applied.tolerant === 1 ? '' : 's'} matched with whitespace tolerance — the file's own indentation was kept; verify below.`] : []),
        ...(hunk ? ['changed hunk now in the file:', hunk] : []),
      ].join('\n');
      return { call_id: '', status: 'ok', output: outputText, truncated: false, meta: { path: shownPath, replacements: applied.applied, ...(applied.tolerant > 0 ? { whitespace_tolerant: true } : {}), ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath, requested_path: a.path } : {}) } };
    } catch (error) { return { call_id: '', status: 'error', output: await errorWithSuggestion(error, context.workspaceRoot, a.path), truncated: false, meta: {} }; }
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