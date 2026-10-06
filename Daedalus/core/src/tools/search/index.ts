import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import { IGNORED_DIRECTORY_NAMES, confined } from '../filesystem/index.ts';

const MAX_RESULTS = 100;
// Same prune set as list_dir (node_modules, .git, .daedalus, dist): search
// must never walk the task store or vendor trees either.
const IGNORE = IGNORED_DIRECTORY_NAMES;

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

export const grepTool: ToolDefinition = {
  name: 'grep', description: 'Search UTF-8 workspace files with a regular expression.', mutating: false,
  inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, ignore_case: { type: 'boolean' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { pattern?: unknown; path?: unknown; ignore_case?: unknown };
    if (typeof a.pattern !== 'string') return { call_id: '', status: 'error', output: 'pattern must be a string', truncated: false, meta: {} };
    try {
      const root = await confined(context.workspaceRoot, typeof a.path === 'string' ? a.path : '.');
      const regex = new RegExp(a.pattern, typeof a.ignore_case === 'boolean' && a.ignore_case ? 'i' : '');
      const matches: string[] = [];
      for (const file of await walk(root)) {
        if (matches.length >= MAX_RESULTS) break;
        let text: string; try { text = await readFile(file, 'utf8'); } catch { continue; }
        for (const [index, line] of text.split('\n').entries()) {
          if (regex.test(line)) matches.push(`${relative(context.workspaceRoot, file)}:${index + 1}: ${line}`);
          if (matches.length >= MAX_RESULTS) break;
        }
      }
      return { call_id: '', status: 'ok', output: matches.join('\n'), truncated: matches.length >= MAX_RESULTS, meta: { count: matches.length, limit: MAX_RESULTS } };
    } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

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
