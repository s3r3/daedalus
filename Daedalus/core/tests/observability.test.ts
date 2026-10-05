import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventBus,
  TaskRunner,
  TaskStore,
  changedLineCounts,
  diffLines,
  renderPatch,
  type Event,
  type LLMProvider,
} from '../src/index.ts';

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-obs-ws-'));
  home = mkdtempSync(join(tmpdir(), 'daedalus-obs-home-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Provider that walks a fixed script of tool calls, then reports completion. */
function scriptedProvider(script: Array<{ tool: string; args: unknown }>): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } },
          ],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

async function runScripted(script: Array<{ tool: string; args: unknown }>) {
  const store = new TaskStore(home);
  const bus = new EventBus();
  const runner = new TaskRunner({
    workspaceRoot: workspace,
    store,
    bus,
    provider: scriptedProvider(script),
    approvalPolicy: 'auto',
    maxIterations: 8,
  });
  const result = await runner.run({ goal: 'inspect and patch the workspace' });
  return { result, events: store.replay(result.state.id) };
}

describe('run observability', () => {
  test('command tools emit COMMAND_STARTED/OUTPUT/FINISHED with the exit code', async () => {
    const { events } = await runScripted([{ tool: 'run_command', args: { command: 'echo', args: ['hello-daedalus'] } }]);

    const started = events.find((e) => e.type === 'COMMAND_STARTED');
    expect(started).toBeDefined();
    expect((started?.payload as { command: string }).command).toBe('echo hello-daedalus');

    const output = events
      .filter((e) => e.type === 'COMMAND_OUTPUT')
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join('');
    expect(output).toContain('hello-daedalus');

    const finished = events.find((e) => e.type === 'COMMAND_FINISHED');
    expect((finished?.payload as { exit_code: number }).exit_code).toBe(0);
    expect((finished?.payload as { status: string }).status).toBe('ok');

    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('failing command records a non-zero exit code', async () => {
    const { events } = await runScripted([{ tool: 'run_command', args: { command: 'node', args: ['-e', 'process.exit(3)'] } }]);
    const finished = events.find((e) => e.type === 'COMMAND_FINISHED');
    expect((finished?.payload as { exit_code: number }).exit_code).toBe(3);
    expect((finished?.payload as { status: string }).status).toBe('error');
  });

  test('write_file emits FILE_CHANGED with add/remove counts and a patch', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'one\ntwo\n', 'utf8');
    const { events, result } = await runScripted([
      { tool: 'write_file', args: { path: 'notes.md', content: 'one\ntwo\nthree\n' } },
    ]);

    const changed = events.find((e) => e.type === 'FILE_CHANGED') as Event | undefined;
    const payload = changed?.payload as { path: string; operation: string; added: number; removed: number; patch: string; lines: Array<{ kind: string; text: string }> };
    expect(payload.path).toBe('notes.md');
    expect(payload.operation).toBe('modified');
    expect(payload.added).toBe(1);
    expect(payload.removed).toBe(0);
    expect(payload.lines).toContainEqual({ kind: 'add', text: 'three' });
    expect(payload.patch).toContain('+++ b/notes.md');
    expect(result.report.diff).toContain('+++ b/notes.md');
    expect(result.report.metrics.files_changed).toBe(1);
    expect(result.report.evidence.join(' ')).toContain('modified notes.md');
  });

  test('new file reports operation created', async () => {
    const { events } = await runScripted([{ tool: 'write_file', args: { path: 'fresh.ts', content: 'export const a = 1\n' } }]);
    const payload = events.find((e) => e.type === 'FILE_CHANGED')?.payload as { operation: string; added: number };
    expect(payload.operation).toBe('created');
    expect(payload.added).toBe(1);
    expect(existsSync(join(workspace, 'fresh.ts'))).toBe(true);
    expect(readFileSync(join(workspace, 'fresh.ts'), 'utf8')).toContain('export const a = 1');
  });

  test('the final report is persisted for the interfaces to render', async () => {
    const store = new TaskStore(home);
    const bus = new EventBus();
    const runner = new TaskRunner({
      workspaceRoot: workspace,
      store,
      bus,
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'a.txt', content: 'x\n' } }]),
      approvalPolicy: 'auto',
    });
    const result = await runner.run({ goal: 'write a file' });
    expect(store.loadReport(result.state.id)).toEqual(result.report);
    expect(result.report.metrics.tool_calls).toBeGreaterThan(0);
  });
});

describe('diff utility', () => {
  test('marks added and removed lines', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(lines.filter((l) => l.kind === 'remove').map((l) => l.text)).toEqual(['b']);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['B', 'd']);
    expect(changedLineCounts(lines)).toEqual({ added: 2, removed: 1 });
  });

  test('identical content produces no lines', () => {
    expect(diffLines('same\n', 'same\n')).toEqual([]);
    expect(renderPatch('f.txt', [])).toBe('');
  });

  test('empty to content counts as pure addition', () => {
    const lines = diffLines('', 'new\n');
    expect(lines).toEqual([{ kind: 'add', text: 'new' }]);
  });
});