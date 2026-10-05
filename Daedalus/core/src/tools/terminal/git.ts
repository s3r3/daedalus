import type { ToolDefinition } from '../registry.ts';
import { run } from './index.ts';

export const gitStatusTool: ToolDefinition = {
  name: 'git_status', description: 'Show workspace git status (porcelain).', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown };
    const exec = await run('git', ['status', '--porcelain'], typeof a.path === 'string' ? a.path : context.workspaceRoot, { timeoutMs: 10_000, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput });
    return { call_id: '', ...exec };
  },
};

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff', description: 'Show workspace git diff (stat or full patch).', mutating: false,
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, stat_only: { type: 'boolean' } }, additionalProperties: false },
  async execute(args, context) {
    const a = args as { path?: unknown; stat_only?: unknown };
    const gitArgs = a.stat_only === true ? ['diff', '--stat'] : ['diff', '--no-color'];
    const exec = await run('git', gitArgs, typeof a.path === 'string' ? a.path : context.workspaceRoot, { timeoutMs: 10_000, signal: context.signal, sandbox: context.sandbox, onOutput: context.onOutput });
    return { call_id: '', ...exec };
  },
};