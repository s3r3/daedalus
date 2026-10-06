import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  EventBus,
  TaskStore,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_MAX_LINES,
  loadSettings,
  readFileTool,
  shapeToolOutput,
  truncateHeadTail,
  type LLMProvider,
  type ToolCall,
  type ToolResult,
} from '../src/index.ts';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** `L001-xxxx…` lines of 5 + pad chars each, joined with newlines. */
const numberedLines = (count: number, pad = 10): string =>
  Array.from({ length: count }, (_, i) => `L${String(i + 1).padStart(3, '0')}-${'x'.repeat(pad)}`).join('\n');

describe('shapeToolOutput', () => {
  test('passes under-cap output through untouched and never mints a spill path', async () => {
    let spillCalls = 0;
    const shaped = await shapeToolOutput('hello\nworld', {
      tool: 'read_file',
      limits: { maxChars: 5_000, maxLines: 100 },
      spillPathFor: () => {
        spillCalls++;
        return join(tmpDir('daedalus-spill-'), 'x.txt');
      },
    });
    expect(shaped.truncated).toBe(false);
    expect(shaped.output).toBe('hello\nworld');
    expect(shaped.spillPath).toBeUndefined();
    expect(shaped.totalChars).toBe(11);
    expect(shaped.shownLines).toBe(2);
    expect(spillCalls).toBe(0);
  });

  test('over cap: keeps head and tail, appends the marker, spills the exact full text', async () => {
    const dir = tmpDir('daedalus-spill-');
    const full = numberedLines(100);
    const spillPath = join(dir, 'tool-output', '1-run_command.txt');
    const shaped = await shapeToolOutput(full, {
      tool: 'run_command',
      limits: { maxChars: 280, maxLines: 20 },
      spillPathFor: () => spillPath,
    });
    expect(shaped.truncated).toBe(true);
    expect(shaped.spillPath).toBe(spillPath);
    expect(readFileSync(spillPath, 'utf8')).toBe(full);
    expect(shaped.output.startsWith('L001-')).toBe(true);
    expect(shaped.output).toContain('L100-');
    expect(shaped.output).not.toContain('L050-');
    expect(shaped.output.length).toBeLessThan(full.length);
    expect(shaped.shownLines).toBeLessThanOrEqual(20);
    expect(shaped.output).toContain(
      `[output truncated: showed ${shaped.shownLines} of 100 lines / ${full.length} chars — full output saved to ${spillPath}; read it with read_file using offset/limit if you need the middle]`,
    );
  });

  test('line cap alone truncates by whole lines in a 60/40 split', async () => {
    const shaped = await shapeToolOutput(numberedLines(100, 2), {
      tool: 'grep',
      limits: { maxChars: 100_000, maxLines: 10 },
    });
    expect(shaped.truncated).toBe(true);
    expect(shaped.shownLines).toBe(10);
    const contentLines = shaped.output.split('\n').slice(0, -1);
    expect(contentLines).toHaveLength(10);
    expect(contentLines[0]).toContain('L001');
    expect(contentLines[5]).toContain('L006');
    expect(contentLines[6]).toContain('L097');
    expect(contentLines[9]).toContain('L100');
    // No spill sink was provided, so the marker must not invent a path.
    expect(shaped.spillPath).toBeUndefined();
    expect(shaped.output).toContain('full output not saved');
  });

  test('a single huge line is char-capped head+tail and still counts as one line', async () => {
    const shaped = await shapeToolOutput('x'.repeat(5_000), {
      tool: 'grep',
      limits: { maxChars: 100, maxLines: 2_000 },
    });
    expect(shaped.truncated).toBe(true);
    expect(shaped.totalLines).toBe(1);
    expect(shaped.shownLines).toBe(1);
    const content = shaped.output.split('\n')[0]!;
    expect(content).toHaveLength(100);
    expect(/^x+$/.test(content)).toBe(true);
    expect(shaped.output).toContain('/ 5000 chars');
  });

  test('spill disabled: output is still capped and the marker says so honestly', async () => {
    const dir = tmpDir('daedalus-spill-');
    const spillPath = join(dir, 'never-written.txt');
    const shaped = await shapeToolOutput(numberedLines(100), {
      tool: 'run_command',
      limits: { maxChars: 200, maxLines: 20, spill: false },
      spillPathFor: () => spillPath,
    });
    expect(shaped.truncated).toBe(true);
    expect(shaped.spillPath).toBeUndefined();
    expect(shaped.output).toContain('full output not saved');
    expect(existsSync(spillPath)).toBe(false);
  });

  test('a spill write failure degrades to the not-saved marker instead of throwing', async () => {
    const dir = tmpDir('daedalus-spill-');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const shaped = await shapeToolOutput(numberedLines(100), {
      tool: 'run_command',
      limits: { maxChars: 200, maxLines: 20 },
      spillPathFor: () => join(blocker, 'spill.txt'),
    });
    expect(shaped.truncated).toBe(true);
    expect(shaped.spillPath).toBeUndefined();
    expect(shaped.output).toContain('full output not saved');
  });
});

describe('truncateHeadTail', () => {
  test('keeps the first 60% and last 40% of the line budget', () => {
    const { text, shownLines } = truncateHeadTail(numberedLines(100, 2), 100_000, 10);
    const lines = text.split('\n');
    expect(shownLines).toBe(10);
    expect(lines[0]).toContain('L001');
    expect(lines[6]).toContain('L097');
    expect(lines.at(-1)).toContain('L100');
  });
});

describe('read_file offset/limit', () => {
  test('offset+limit page through a file; start_line/end_line keep working', async () => {
    const root = tmpDir('daedalus-read-');
    writeFileSync(join(root, 'rows.txt'), Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join('\n'));
    const paged = await readFileTool.execute({ path: 'rows.txt', offset: 5, limit: 3 }, { workspaceRoot: root });
    expect(paged.status).toBe('ok');
    expect(paged.output).toContain('5: row-5');
    expect(paged.output).toContain('7: row-7');
    expect(paged.output).not.toContain('row-8');
    expect(paged.meta).toMatchObject({ start_line: 5, end_line: 7, total_lines: 20 });

    const ranged = await readFileTool.execute({ path: 'rows.txt', start_line: 2, end_line: 3 }, { workspaceRoot: root });
    expect(ranged.output).toContain('2: row-2');
    expect(ranged.output).not.toContain('row-4');

    // limit also caps an explicit end_line window.
    const capped = await readFileTool.execute({ path: 'rows.txt', offset: 2, end_line: 19, limit: 2 }, { workspaceRoot: root });
    expect(capped.output).toContain('3: row-3');
    expect(capped.output).not.toContain('row-4');
  });
});

describe('tool-output settings', () => {
  test('env caps parse, spill toggles off, invalid values fail fast', () => {
    const custom = loadSettings({
      DAEDALUS_TOOL_OUTPUT_MAX_CHARS: '12345',
      DAEDALUS_TOOL_OUTPUT_MAX_LINES: '321',
      DAEDALUS_TOOL_SPILL: 'off',
    });
    expect(custom.toolOutput).toEqual({ maxChars: 12_345, maxLines: 321, spill: false });
    const defaults = loadSettings({});
    expect(defaults.toolOutput).toEqual({ maxChars: TOOL_OUTPUT_MAX_CHARS, maxLines: TOOL_OUTPUT_MAX_LINES, spill: true });
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(50_000);
    expect(TOOL_OUTPUT_MAX_LINES).toBe(2_000);
    expect(() => loadSettings({ DAEDALUS_TOOL_OUTPUT_MAX_CHARS: 'lots' })).toThrow(/DAEDALUS_TOOL_OUTPUT_MAX_CHARS/);
    expect(() => loadSettings({ DAEDALUS_TOOL_OUTPUT_MAX_LINES: '0' })).toThrow(/DAEDALUS_TOOL_OUTPUT_MAX_LINES/);
  });
});

describe('AgentLoop tool-output shaping (end to end)', () => {
  test('a huge tool result reaches the next request as head+tail+marker, full text spilled, event untouched', async () => {
    const store = new TaskStore(tmpDir('daedalus-store-'));
    const bus = new EventBus();
    const rows = Array.from({ length: 300 }, (_, i) => `row-${String(i + 1).padStart(4, '0')} ${'x'.repeat(40)}`);
    const fullOutput = rows.join('\n');
    const requests: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'fake',
      async chat(messages) {
        calls++;
        requests.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"npm","args":["test"]}' } }],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
        };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus,
      store,
      stopPolicy: { max_iterations: 6, max_errors: 3 },
      toolOutput: { maxChars: 1_200, maxLines: 40 },
      executeTool: async (call: ToolCall): Promise<ToolResult> => ({
        call_id: call.id,
        status: 'ok',
        output: call.tool === 'run_command' ? fullOutput : 'small readme',
        truncated: false,
        meta: { tool: call.tool },
      }),
    });
    const state = await loop.run('Dump the test log\ndone: log dumped\ndone: readme checked');
    expect(state.status).toBe('done');
    expect(requests).toHaveLength(2);

    // The second request carries the shaped observation, not the raw dump.
    const second = requests[1]!;
    expect(second).toContain('row-0001');
    expect(second).toContain('row-0300');
    expect(second).not.toContain('row-0150');
    expect(second).toContain('[output truncated:');
    expect(second).toContain('read it with read_file using offset/limit');
    expect(second.length).toBeLessThan(fullOutput.length);

    // The full text is recoverable from the task store, exactly as produced.
    const spillDir = join(store.taskDir(state.id), 'tool-output');
    expect(readdirSync(spillDir)).toEqual(['1-run_command.txt']);
    const spillPath = join(spillDir, '1-run_command.txt');
    expect(readFileSync(spillPath, 'utf8')).toBe(fullOutput);
    expect(second).toContain(spillPath);

    // The event log keeps the executor's untouched result plus additive flags;
    // the small second result is not flagged at all.
    const finished = store.replay(state.id).filter((e) => e.type === 'TOOL_CALL_FINISHED');
    expect(finished).toHaveLength(2);
    const first = finished[0]?.payload as { result: ToolResult; output_truncated?: boolean; spill_path?: string };
    expect(first.output_truncated).toBe(true);
    expect(first.spill_path).toBe(spillPath);
    expect(first.result.output).toBe(fullOutput);
    expect(first.result.truncated).toBe(false);
    const secondPayload = finished[1]?.payload as { output_truncated?: boolean };
    expect(secondPayload.output_truncated).toBeUndefined();
  });
});
