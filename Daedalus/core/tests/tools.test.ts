import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  createDefaultRegistry,
  editFileTool,
  EventBus,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runCommandTool,
  TaskStore,
  ToolRegistry,
  writeFileTool,
} from '../src/index.ts';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function workspace(): string { dir = mkdtempSync(join(tmpdir(), 'daedalus-tools-')); return dir; }
const ctx = (root: string) => ({ workspaceRoot: root });

describe('ToolRegistry', () => {
  test('registers, looks up, and rejects duplicates/unknown tools', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    expect(registry.get('read_file')).toBe(readFileTool);
    expect(() => registry.register(readFileTool)).toThrow(/already registered/);
    expect(() => registry.get('nope')).toThrow(/unknown tool/);
  });

  test('model-facing schemas leak no host-only fields', () => {
    const schemas = createDefaultRegistry().schemas();
    for (const schema of schemas) {
      expect(Object.keys(schema.function).sort()).toEqual(['description', 'name', 'parameters']);
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toContain('"mutating"');
      expect(serialized).not.toContain('"execute"');
      expect(serialized).not.toContain('"timeoutMs"');
    }
  });

  test('dispatch sets tool meta and mutating flag', async () => {
    const root = workspace();
    const registry = createDefaultRegistry();
    const result = await registry.execute(
      { id: 'c1', task_id: 't1', turn_id: 'u1', tool: 'read_file', args: { path: 'a.txt' }, started_at: '' },
      ctx(root),
    );
    expect(result.status).toBe('error');
    expect(result.meta.tool).toBe('read_file');
    expect(result.meta.mutating).toBe(false);
  });
});

describe('file tools', () => {
  test('read_file supports line range and reports truncation metadata', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.txt'), 'l1\nl2\nl3\n');
    const result = await readFileTool.execute({ path: 'a.txt', start_line: 2, end_line: 3 }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('2: l2');
    expect(result.meta.total_lines).toBe(4);
  });

  test('read_file truncates oversized files', async () => {
    const root = workspace();
    // Fixture grew 40k → 60k: read_file's serving budget is now aligned
    // with the loop's 50k shaping cap (a 40k file is served whole, by
    // design — sub-cap truncation was the read-loop bug). The assertion
    // is unchanged: an over-budget file reports truncation.
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(60_000));
    const result = await readFileTool.execute({ path: 'big.txt' }, ctx(root));
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('[truncated]');
  });

  test('write_file then read_file round trip', async () => {
    const root = workspace();
    const write = await writeFileTool.execute({ path: 'new.txt', content: 'hello' }, ctx(root));
    expect(write.status).toBe('ok');
    expect(write.meta.bytes).toBe(5);
    const read = await readFileTool.execute({ path: 'new.txt' }, ctx(root));
    expect(read.output).toContain('hello');
  });

  test('edit_file replaces a unique match and rejects ambiguous ones', async () => {
    const root = workspace();
    writeFileSync(join(root, 'e.txt'), 'foo bar foo');
    const ambiguous = await editFileTool.execute({ path: 'e.txt', old_string: 'foo', new_string: 'baz' }, ctx(root));
    expect(ambiguous.status).toBe('error');
    expect(ambiguous.meta.matches).toBe(2);
    writeFileSync(join(root, 'u.txt'), 'one bar two');
    const ok = await editFileTool.execute({ path: 'u.txt', old_string: 'bar', new_string: 'baz' }, ctx(root));
    expect(ok.status).toBe('ok');
    expect(ok.meta.replacements).toBe(1);
  });

  test('edit_file reports missing match', async () => {
    const root = workspace();
    writeFileSync(join(root, 'm.txt'), 'content');
    const result = await editFileTool.execute({ path: 'm.txt', old_string: 'nope', new_string: 'x' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.output).toContain('not found');
  });

  test('list_dir ignores node_modules and marks directories', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'src', 'index.ts'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx(root));
    expect(result.output).toContain('src/');
    expect(result.output).not.toContain('node_modules');
  });

  test('list_dir hides .daedalus state and dist so listings stay about the project', async () => {
    const root = workspace();
    mkdirSync(join(root, '.daedalus', 'tasks', 'task-1'), { recursive: true });
    writeFileSync(join(root, '.daedalus', 'tasks', 'task-1', 'events.jsonl'), '{}\n');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'bundle.js'), '');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx(root));
    expect(result.output).toContain('src/');
    expect(result.output).not.toContain('.daedalus');
    expect(result.output).not.toContain('events.jsonl');
    expect(result.output).not.toContain('dist/');
  });

  test('list_dir caps very large listings and reports how many entries were omitted', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    for (let i = 0; i < 175; i++) writeFileSync(join(root, 'src', `file-${String(i).padStart(3, '0')}.ts`), '');
    const result = await listDirTool.execute({ path: '.' }, ctx(root));
    const lines = result.output.split('\n');
    expect(lines.length).toBeLessThanOrEqual(151); // 150 entries + remainder note
    expect(lines[lines.length - 1]).toMatch(/^… \(\d+ more entries, truncated\)$/);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.entries).toBe(150);
  });

  test('all path-taking file tools deny workspace escapes', async () => {
    const root = workspace();
    for (const tool of [readFileTool, writeFileTool, editFileTool, listDirTool]) {
      const result = await tool.execute({ path: '../../etc/passwd', content: 'x', old_string: 'a', new_string: 'b' }, ctx(root));
      expect(result.status).toBe('error');
      expect(result.output).toContain('escapes workspace root');
    }
  });
});

describe('search tools', () => {
  test('grep finds matches with file:line and caps results', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'const needle = 1;\nconst other = 2;');
    const result = await grepTool.execute({ pattern: 'needle' }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('a.ts:1:');
    expect(result.meta.count).toBe(1);
  });

  test('grep reports truncation when capped', async () => {
    const root = workspace();
    writeFileSync(join(root, 'many.ts'), Array.from({ length: 150 }, (_, i) => `hit ${i}`).join('\n'));
    const result = await grepTool.execute({ pattern: 'hit' }, ctx(root));
    expect(result.truncated).toBe(true);
    expect(result.meta.count).toBe(100);
  });

  test('grep respects ignore_case and rejects bad input', async () => {
    const root = workspace();
    writeFileSync(join(root, 'x.ts'), 'Needle');
    expect((await grepTool.execute({ pattern: 'needle', ignore_case: true }, ctx(root))).meta.count).toBe(1);
    expect((await grepTool.execute({ pattern: 5 }, ctx(root))).status).toBe('error');
  });

  test('glob matches paths and validates input', async () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), '');
    const result = await globTool.execute({ pattern: 'src/*.ts' }, ctx(root));
    expect(result.output).toContain('src/index.ts');
    expect((await globTool.execute({ pattern: {} }, ctx(root))).status).toBe('error');
  });

  test('grep and glob never descend into .daedalus state', async () => {
    const root = workspace();
    mkdirSync(join(root, '.daedalus', 'tasks', 't1'), { recursive: true });
    writeFileSync(join(root, '.daedalus', 'tasks', 't1', 'log.txt'), 'needle in state\n');
    writeFileSync(join(root, 'real.ts'), 'const needle = 1;');
    const grepResult = await grepTool.execute({ pattern: 'needle' }, ctx(root));
    expect(grepResult.output).toContain('real.ts:1:');
    expect(grepResult.output).not.toContain('.daedalus');
    const globResult = await globTool.execute({ pattern: '**/*.txt' }, ctx(root));
    expect(globResult.output).not.toContain('.daedalus');
  });
});

describe('terminal tools', () => {
  test('run_command denies commands outside the allowlist', async () => {
    const root = workspace();
    const result = await runCommandTool.execute({ command: 'rm', args: ['-rf', '/'] }, ctx(root));
    expect(result.status).toBe('denied');
    expect(result.output).toContain('not allowed');
  });

  test('run_command captures output and exit code', async () => {
    const root = workspace();
    const result = await runCommandTool.execute({ command: 'echo', args: ['hi'] }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output.trim()).toBe('hi');
    expect(result.meta.exit_code).toBe(0);
  });

  test('run_command validates args shape', async () => {
    const root = workspace();
    expect((await runCommandTool.execute({ command: 'echo' }, ctx(root))).status).toBe('error');
  });
});

describe('AgentLoop + ToolRegistry integration', () => {
  test('tool dispatch through the loop emits TOOL_CALL_FINISHED with the real ToolResult', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.txt'), 'hello world');
    const registry = createDefaultRegistry();
    const store = new TaskStore(join(root, '.daedalus'));
    const bus = new EventBus();
    const finished: Array<{ status: string; tool?: unknown; mutating?: unknown }> = [];
    bus.on('TOOL_CALL_FINISHED', (event) => {
      const payload = event.payload as { result: { status: string; meta: Record<string, unknown> } };
      finished.push({ status: payload.result.status, tool: payload.result.meta.tool, mutating: payload.result.meta.mutating });
    });
    const provider = {
      name: 'tool-caller',
      async chat() {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }],
          },
        };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider, bus, store,
      stopPolicy: { max_iterations: 3, max_errors: 1 },
      executeTool: (call) => registry.execute(call, { workspaceRoot: root }),
    });
    const state = await loop.run('Read the file\ndone: read a.txt');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toEqual({ status: 'ok', tool: 'read_file', mutating: false });
    expect(state.steps[0]?.status).toBe('done');
  });
});