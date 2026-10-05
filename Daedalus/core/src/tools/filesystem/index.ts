import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';

const MAX_OUTPUT = 16_000;

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

export const readFileTool: ToolDefinition = {
  name: 'read_file', description: 'Read a UTF-8 text file, optionally by 1-based inclusive line range.', mutating: false,
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; start_line?: unknown; end_line?: unknown };
    if (typeof a.path !== 'string') return { call_id: '', status: 'error', output: 'path must be a string', truncated: false, meta: {} };
    try {
      const data = await readFile(await pathInWorkspace(context.workspaceRoot, a.path), 'utf8');
      const lines = data.split('\n');
      const start = typeof a.start_line === 'number' ? Math.max(1, a.start_line) : 1;
      const end = typeof a.end_line === 'number' ? Math.min(lines.length, a.end_line) : lines.length;
      const text = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
      return output('', text, { start_line: start, end_line: end, total_lines: lines.length });
    } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file', description: 'Create or overwrite a UTF-8 file inside the workspace.', mutating: true,
  inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; content?: unknown };
    if (typeof a.path !== 'string' || typeof a.content !== 'string') return { call_id: '', status: 'error', output: 'path and content must be strings', truncated: false, meta: {} };
    try { await writeFile(await pathInWorkspace(context.workspaceRoot, a.path), a.content, 'utf8'); return { call_id: '', status: 'ok', output: `wrote ${a.path}`, truncated: false, meta: { path: a.path, bytes: Buffer.byteLength(a.content) } }; }
    catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file', description: 'Replace one unique exact string in a UTF-8 file.', mutating: true,
  inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; old_string?: unknown; new_string?: unknown };
    if (typeof a.path !== 'string' || typeof a.old_string !== 'string' || typeof a.new_string !== 'string') return { call_id: '', status: 'error', output: 'path, old_string, and new_string must be strings', truncated: false, meta: {} };
    try {
      const target = await pathInWorkspace(context.workspaceRoot, a.path); const data = await readFile(target, 'utf8');
      const count = data.split(a.old_string).length - 1;
      if (count !== 1) return { call_id: '', status: 'error', output: count === 0 ? 'old_string not found' : `old_string matched ${count} times; match must be unique`, truncated: false, meta: { matches: count } };
      await writeFile(target, data.replace(a.old_string, a.new_string), 'utf8');
      return { call_id: '', status: 'ok', output: `edited ${a.path}`, truncated: false, meta: { path: a.path, replacements: 1 } };
    } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};

export const listDirTool: ToolDefinition = {
  name: 'list_dir', description: 'List direct children of a workspace directory.', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown }; const input = typeof a.path === 'string' ? a.path : '.';
    try { const dir = await pathInWorkspace(context.workspaceRoot, input); const entries = await readdir(dir, { withFileTypes: true }); const text = entries.filter((e) => !['node_modules', '.git'].includes(e.name)).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n'); return output('', text, { path: input }); }
    catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
  },
};