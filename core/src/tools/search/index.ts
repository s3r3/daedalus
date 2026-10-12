import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import { IGNORED_DIRECTORY_NAMES, confined } from '../filesystem/index.ts';

const MAX_RESULTS = 100;
// Same prune set as list_dir (node_modules, .git, .daedalus, dist): search
// must never walk the task store or vendor trees either.
const IGNORE = IGNORED_DIRECTORY_NAMES;
/** Files above this are not worth regex-scanning line by line (build output, bundles). */
const GREP_MAX_FILE_BYTES = 5_000_000;
/** rg runaway guard: matches beyond this stop the search (reported as truncated). */
const RG_OUTPUT_CAP_BYTES = 16_000_000;

async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export type GrepLine = { path: string; line: number; text: string; context: boolean };

type GrepQuery = { pattern: string; regex: RegExp; ignoreCase: boolean; context: number; mode: GrepOutputMode; glob: RegExp | undefined };

/**
 * The pure-JS scan. Used when ripgrep is absent and as the semantic
 * reference: both engines render identical output from a GrepLine[].
 * Context lines are emitted around matches (bounded, overlapping
 * windows merged by construction of the walk order).
 */
async function grepWithJs(workspaceRoot: string, root: string, query: GrepQuery): Promise<GrepLine[]> {
  const lines: GrepLine[] = [];
  let matchCount = 0;
  for (const file of await walk(root)) {
    const rel = relative(workspaceRoot, file);
    if (query.glob && !query.glob.test(relative(root, file))) continue;
    let info; try { info = await stat(file); } catch { continue; }
    if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) continue;
    let text: string; try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue; // binary: not searchable text
    const fileLines = text.split('\n');
    const matched = new Set<number>();
    for (const [index, line] of fileLines.entries()) {
      if (query.regex.test(line)) { matched.add(index); matchCount++; }
    }
    if (matched.size === 0) continue;
    if (query.mode === 'content') {
      const shown = new Set<number>();
      for (const index of matched) {
        for (let c = Math.max(0, index - query.context); c <= Math.min(fileLines.length - 1, index + query.context); c++) shown.add(c);
      }
      for (const index of [...shown].sort((x, y) => x - y)) {
        lines.push({ path: rel, line: index + 1, text: fileLines[index] ?? '', context: !matched.has(index) });
      }
    } else {
      // files/count modes derive from bare match lines (renderGrep
      // ignores the text), so push one line per match without context.
      for (const index of [...matched].sort((x, y) => x - y)) {
        lines.push({ path: rel, line: index + 1, text: fileLines[index] ?? '', context: false });
      }
    }
    if (matchCount >= MAX_RESULTS * 20) break; // pathological tree: stop scanning
  }
  return lines;
}

function countPerFile(lines: GrepLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) if (!line.context) counts.set(line.path, (counts.get(line.path) ?? 0) + 1);
  return counts;
}

/** rg arguments mirroring the JS semantics (ignore set, size cap, JSON stream). Exported for tests. */
export function ripgrepArgs(query: { pattern: string; ignoreCase: boolean; context: number; glob?: string }): string[] {
  const args = ['--json', '--no-messages', '--max-filesize', String(GREP_MAX_FILE_BYTES), '-e', query.pattern];
  if (query.ignoreCase) args.push('-i');
  if (query.context > 0) args.push('-C', String(query.context));
  for (const dir of IGNORED_DIRECTORY_NAMES) args.push('--glob', `!${dir}`, '--glob', `!**/${dir}/**`);
  if (query.glob) args.push('--glob', query.glob);
  // Explicit path: without one, ripgrep reads STDIN whenever it is not a
  // terminal — a spawned pipe would hang the search forever.
  args.push('.');
  return args;
}

type RgEvent = {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
};

/** Parse `rg --json` output into GrepLine[] (paths normalized to workspace-relative). Exported for tests. */
export function parseRipgrepJson(stdout: string, workspaceRoot: string, root: string): GrepLine[] {
  const lines: GrepLine[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    let event: RgEvent;
    try { event = JSON.parse(raw) as RgEvent; } catch { continue; }
    if (event.type !== 'match' && event.type !== 'context') continue;
    const pathText = event.data?.path?.text;
    const lineNo = event.data?.line_number;
    if (typeof pathText !== 'string' || typeof lineNo !== 'number') continue;
    const abs = pathText.startsWith('/') ? pathText : join(root, pathText);
    lines.push({
      path: relative(workspaceRoot, abs),
      line: lineNo,
      text: (event.data?.lines?.text ?? '').replace(/\n$/, ''),
      context: event.type === 'context',
    });
  }
  return lines;
}

async function grepWithRipgrep(workspaceRoot: string, root: string, query: GrepQuery, globPattern: string | undefined): Promise<GrepLine[]> {
  const args = ripgrepArgs({ pattern: query.pattern, ignoreCase: query.ignoreCase, context: query.context, ...(globPattern ? { glob: globPattern } : {}) });
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > RG_OUTPUT_CAP_BYTES) { killed = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1 || killed) resolvePromise(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`ripgrep exited with code ${code ?? 'unknown'}`));
    });
  });
  return parseRipgrepJson(stdout, workspaceRoot, root);
}

let ripgrepAvailableCache: Promise<boolean> | undefined;
function ripgrepAvailable(): Promise<boolean> {
  ripgrepAvailableCache ??= new Promise<boolean>((resolvePromise) => {
    execFile('rg', ['--version'], { timeout: 5_000 }, (error) => resolvePromise(!error));
  });
  return ripgrepAvailableCache;
}

function renderGrep(lines: GrepLine[], mode: GrepOutputMode): { output: string; count: number; truncated: boolean } {
  if (mode === 'files_with_matches') {
    const files = [...new Set(lines.filter((l) => !l.context).map((l) => l.path))].sort();
    const shown = files.slice(0, MAX_RESULTS);
    return { output: shown.join('\n'), count: files.length, truncated: files.length > MAX_RESULTS };
  }
  if (mode === 'count') {
    const counts = countPerFile(lines);
    const files = [...counts.keys()].sort();
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const shown = files.slice(0, MAX_RESULTS).map((file) => `${file}: ${counts.get(file)}`);
    return { output: shown.join('\n'), count: total, truncated: files.length > MAX_RESULTS };
  }
  const matches = lines.filter((l) => !l.context);
  const truncated = matches.length > MAX_RESULTS;
  const shown = truncated
    ? (() => {
        const kept: GrepLine[] = [];
        let keptMatches = 0;
        for (const line of lines) {
          if (!line.context) {
            if (keptMatches >= MAX_RESULTS) break;
            keptMatches++;
          }
          kept.push(line);
        }
        return kept;
      })()
    : lines;
  return {
    output: shown.map((line) => `${line.path}${line.context ? '-' : ':'}${line.line}${line.context ? '-' : ':'} ${line.text}`).join('\n'),
    // Legacy contract: a truncated content result reports the cap, not
    // the (possibly much larger) true total.
    count: truncated ? MAX_RESULTS : matches.length,
    truncated,
  };
}

export function createGrepTool(options: { useRipgrep?: boolean } = {}): ToolDefinition {
  return {
    name: 'grep', description: 'Search UTF-8 workspace files with a regular expression (ripgrep when available). output_mode: "content" (default; matching lines), "files_with_matches" (just the paths — cheaper when you only need to know where), or "count" (matches per file). context adds surrounding lines; glob filters paths (e.g. "src/**/*.ts").', mutating: false,
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, ignore_case: { type: 'boolean' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, context: { type: 'integer', minimum: 0, maximum: 5 }, glob: { type: 'string' } }, additionalProperties: false },
    async execute(args, context) {
      const a = args as { pattern?: unknown; path?: unknown; ignore_case?: unknown; output_mode?: unknown; context?: unknown; glob?: unknown };
      if (typeof a.pattern !== 'string') return { call_id: '', status: 'error', output: 'pattern must be a string', truncated: false, meta: {} };
      try {
        const root = await confined(context.workspaceRoot, typeof a.path === 'string' ? a.path : '.');
        const mode: GrepOutputMode = a.output_mode === 'files_with_matches' || a.output_mode === 'count' ? a.output_mode : 'content';
        const contextLines = typeof a.context === 'number' && Number.isFinite(a.context) ? Math.min(5, Math.max(0, Math.floor(a.context))) : 0;
        const query: GrepQuery = {
          pattern: a.pattern,
          regex: new RegExp(a.pattern, a.ignore_case === true ? 'i' : ''),
          ignoreCase: a.ignore_case === true,
          context: contextLines,
          mode,
          glob: typeof a.glob === 'string' ? globRegex(a.glob) : undefined,
        };
        const wantRg = options.useRipgrep ?? (await ripgrepAvailable());
        let lines: GrepLine[];
        let engine = 'js';
        if (wantRg) {
          try {
            lines = await grepWithRipgrep(context.workspaceRoot, root, query, typeof a.glob === 'string' ? a.glob : undefined);
            engine = 'ripgrep';
          } catch {
            lines = await grepWithJs(context.workspaceRoot, root, query);
          }
        } else {
          lines = await grepWithJs(context.workspaceRoot, root, query);
        }
        const sorted = [...lines].sort((x, y) => (x.path === y.path ? x.line - y.line : x.path < y.path ? -1 : 1));
        const rendered = renderGrep(sorted, mode);
        return { call_id: '', status: 'ok', output: rendered.output, truncated: rendered.truncated, meta: { count: rendered.count, mode, engine, limit: MAX_RESULTS } };
      } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
    },
  };
}

export const grepTool: ToolDefinition = createGrepTool();

function globRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
}

export const globTool: ToolDefinition = {
  name: 'glob', description: 'Find workspace files matching a glob pattern.', mutating: false,
  inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { pattern?: unknown; path?: unknown };
    if (typeof a.pattern !== 'string') return { call_id: '', status: 'error', output: 'pattern must be a string', truncated: false, meta: {} };
    try {
      const root = await confined(context.workspaceRoot, typeof a.path === 'string' ? a.path : '.');
      const regex = globRegex(a.pattern);
      const matches = (await walk(root)).map((f) => relative(root, f)).filter((f) => regex.test(f)).slice(0, MAX_RESULTS);
      return { call_id: '', status: 'ok', output: matches.join('\n'), truncated: matches.length >= MAX_RESULTS, meta: { count: matches.length, limit: MAX_RESULTS } };
    } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};
