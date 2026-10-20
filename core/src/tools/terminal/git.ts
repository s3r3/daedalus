import type { ToolDefinition } from '../registry.ts';
import { pathInWorkspace } from '../filesystem/index.ts';
import { run } from './index.ts';

async function confinedCwd(args: { path?: unknown }, context: { workspaceRoot: string }): Promise<string> {
  return typeof args.path === 'string' ? pathInWorkspace(context.workspaceRoot, args.path) : context.workspaceRoot;
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status', description: 'Show workspace git status (porcelain).', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown };
    let cwd: string;
    try { cwd = await confinedCwd(a, context); } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
    const exec = await run('git', ['status', '--porcelain'], cwd, { timeoutMs: 10_000, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput });
    return { call_id: '', ...exec };
  },
};

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff', description: 'Show workspace git diff (stat or full patch).', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, stat_only: { type: 'boolean' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; stat_only?: unknown };
    let cwd: string;
    try { cwd = await confinedCwd(a, context); } catch (error) { return { call_id: '', status: 'error', output: String(error), truncated: false, meta: {} }; }
    const gitArgs = a.stat_only === true ? ['diff', '--stat'] : ['diff', '--no-color'];
    const exec = await run('git', gitArgs, cwd, { timeoutMs: 10_000, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput });
    return { call_id: '', ...exec };
  },
};