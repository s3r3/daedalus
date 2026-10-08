/**
 * Read-loop stall fixes (WS3): the read pagination contract + unchanged
 * stub, the identical-call breaker (warn → suppress → directive →
 * hard-pause), the stall definition (alternating read/search accrues;
 * mutations reset), schema validation before dispatch, the input-token
 * budget, the tailor early-trigger, text-protocol invoke-dialect
 * parsing, and the search_images next-step template.
 *
 * The incident these pin: a live run re-read the same page.tsx 8× and
 * re-searched 3×, never downloaded or edited, and burned 264k input
 * tokens — the file tool's own 16k slice made every read partial with
 * no continuation path, so re-reading was rational.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  CONDENSED_TOOL_OUTPUT,
  EventBus,
  ModelPoolProvider,
  TaskRunner,
  TaskStore,
  createSearchImagesTool,
  listDirTool,
  parseTextToolCalls,
  readFileTool,
  toolCallParseErrorOutput,
  validateToolCallArguments,
  writeFileTool,
  type ChatResponse,
  type Event,
  type ImageSearchFetchImpl,
  type LLMProvider,
  type Message,
  type ToolDefinition,
  type ValidationResult,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Reply = { content?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }>; usage?: ChatResponse['usage'] };

/** Sequence-scripted provider; records the messages of every request. */
function scriptedProvider(replies: Reply[]): { provider: LLMProvider; requests: Message[][] } {
  const requests: Message[][] = [];
  let index = 0;
  const provider: LLMProvider = {
    name: 'fake',
    async chat(messages): Promise<ChatResponse> {
      requests.push(messages);
      const reply = replies[index] ?? { content: 'done: script exhausted' };
      index += 1;
      if (reply.toolCalls?.length) {
        return {
          message: {
            role: 'assistant',
            content: reply.content ?? '',
            tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })),
          },
          finish_reason: 'tool_calls',
          ...(reply.usage ? { usage: reply.usage } : {}),
        };
      }
      return { message: { role: 'assistant', content: reply.content ?? 'done: finished' }, finish_reason: 'stop', ...(reply.usage ? { usage: reply.usage } : {}) };
    },
    async *stream() {
      yield { type: 'delta', content: 'done' };
    },
  };
  return { provider, requests };
}

const readTool = (id: string, path = 'page.txt') => ({ id, name: 'read_file', args: { path } });

describe('read_file pagination contract (P0-1/P0-2)', () => {
  test('a ~200-line file NEVER truncates under the read caps', async () => {
    const ws = temp('daedalus-read-ws-');
    const body = Array.from({ length: 200 }, (_, i) => `export const line${i} = "value ${i}"; // padding`).join('\n');
    writeFileSync(join(ws, 'page.tsx'), body);
    const result = await readFileTool.execute({ path: 'page.tsx' }, { workspaceRoot: ws });
    expect(result.status).toBe('ok');
    expect(result.truncated).toBe(false);
    expect(result.output).toContain('[read_file page.tsx — lines 1–200 of 200]');
    expect(result.output).not.toContain('PARTIAL');
    expect(result.output).toContain('200: export const line199');
    expect(result.meta).toMatchObject({ start_line: 1, end_line: 200, total_lines: 200 });
  });

  test('above the caps: PARTIAL notice with totals and the exact continuation call', async () => {
    const ws = temp('daedalus-read-ws-');
    writeFileSync(join(ws, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
    const result = await readFileTool.execute({ path: 'big.txt' }, { workspaceRoot: ws });
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('of 3000 total (2000 lines received)');
    expect(result.output).toContain('read_file(path="big.txt", offset=2001, limit=2000)');
    expect(result.meta).toMatchObject({ partial: true, end_line: 2000, total_lines: 3000 });
  });

  test('an explicit limit page is PARTIAL with a continuation offset', async () => {
    const ws = temp('daedalus-read-ws-');
    writeFileSync(join(ws, 'page.txt'), Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'));
    const result = await readFileTool.execute({ path: 'page.txt', limit: 10 }, { workspaceRoot: ws });
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('lines 1–10 of 200');
    expect(result.output).toContain('(10 lines received)');
    expect(result.output).toContain('offset=11');
  });

  test('a single over-budget line is cut mid-line with a non-pageable notice', async () => {
    const ws = temp('daedalus-read-ws-');
    writeFileSync(join(ws, 'min.js'), 'x'.repeat(60_000));
    const result = await readFileTool.execute({ path: 'min.js' }, { workspaceRoot: ws });
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('[truncated]');
    expect(result.output).toContain('not pageable with read_file');
    expect(result.output.length).toBeLessThan(50_500);
  });

  test('empty file and past-EOF reads are explicit notices, not truncations', async () => {
    const ws = temp('daedalus-read-ws-');
    writeFileSync(join(ws, 'empty.txt'), '');
    writeFileSync(join(ws, 'small.txt'), 'one\ntwo');
    const empty = await readFileTool.execute({ path: 'empty.txt' }, { workspaceRoot: ws });
    expect(empty.output).toContain('empty file (0 lines)');
    expect(empty.truncated).toBe(false);
    const past = await readFileTool.execute({ path: 'small.txt', offset: 99 }, { workspaceRoot: ws });
    expect(past.output).toContain('past end of file');
    expect(past.output).toContain('the file has 2 lines');
    expect(past.truncated).toBe(false);
  });
});

describe('unchanged-read stub (fix 1)', () => {
  test('repeat read of an unchanged file is stubbed; after an edit the full content returns', async () => {
    const home = temp('daedalus-stub-home-');
    const ws = temp('daedalus-stub-ws-');
    writeFileSync(join(ws, 'page.txt'), 'original line\n');
    const { provider, requests } = scriptedProvider([
      { toolCalls: [readTool('c1')] },
      { toolCalls: [readTool('c2')] },
      { toolCalls: [{ id: 'c3', name: 'write_file', args: { path: 'page.txt', content: 'brand new line\n' } }] },
      { toolCalls: [readTool('c4')] },
      { toolCalls: [{ id: 'c5', name: 'write_file', args: { path: 'confirm.txt', content: 'confirmed\n' } }] },
      { content: 'done: finished' },
    ]);
    const store = new TaskStore(home);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      executeTool: async (call) => {
        // The runner's harness stamps mutating on results in production;
        // mirror it so plan steps complete only on the writes.
        if (call.tool === 'read_file') {
          const result = await readFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: false } };
        }
        if (call.tool === 'write_file') {
          const result = await writeFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: true } };
        }
        return { call_id: call.id, status: 'error', output: `unexpected ${call.tool}`, truncated: false, meta: {} };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({ id: 'stub-task', goal: 'read then update the file', constraints: [], done_criteria: ['page.txt updated with the new line', 'confirmation file written'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
    // Request 3 follows the second read: the model must see the stub, not the file again.
    const afterSecondRead = JSON.stringify(requests[2]);
    expect(afterSecondRead).toContain('[unchanged since your earlier read:');
    expect(afterSecondRead).toContain('lines 1–2 of 2');
    expect(afterSecondRead).not.toContain('original line');
    // Request 5 follows the post-edit read: fresh content, no stub.
    const afterEditRead = JSON.stringify(requests[4]);
    expect(afterEditRead).toContain('brand new line');
    expect(afterEditRead).not.toContain('[unchanged since your earlier read');
    // The event ledger keeps the executor's raw results; the stub is
    // flagged additively so UIs can show a read was served from context.
    const finished = store.replay('stub-task').filter((event) => event.type === 'TOOL_CALL_FINISHED');
    expect(finished.map((event) => (event.payload as { unchanged_stub?: unknown }).unchanged_stub === true)).toEqual([false, true, false, false, false]);
    expect((finished[1]?.payload as { result: { output: string } }).result.output).toContain('original line');
  });

  test('repeat list_dir of an unchanged directory is stubbed', async () => {
    const home = temp('daedalus-stub-home-');
    const ws = temp('daedalus-stub-ws-');
    writeFileSync(join(ws, 'a.txt'), 'a');
    const { provider, requests } = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ id: 'c2', name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ id: 'c3', name: 'write_file', args: { path: 'end.txt', content: 'x\n' } }] },
      { toolCalls: [{ id: 'c4', name: 'write_file', args: { path: 'end2.txt', content: 'y\n' } }] },
      { content: 'done: listed' },
    ]);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      executeTool: async (call) => {
        if (call.tool === 'write_file') {
          const result = await writeFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: true } };
        }
        const result = await listDirTool.execute(call.args, { workspaceRoot: ws });
        return { ...result, call_id: call.id, meta: { ...result.meta, mutating: false } };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    await loop.run({ id: 'stub-list', goal: 'look around', constraints: [], done_criteria: ['contents reported', 'confirmation file written'], repo_path: ws, status: 'draft' });
    expect(JSON.stringify(requests[2])).toContain('[unchanged since your earlier listing:');
  });
});

describe('unchanged-read stub after condensing (tesvite CSS loop, 2026-10-08)', () => {
  test('an identical re-read after condensing gets the honest stub, never a second full serve', async () => {
    const home = temp('daedalus-condensed-home-');
    const ws = temp('daedalus-condensed-ws-');
    writeFileSync(join(ws, 'page.txt'), 'original line\n');
    const { provider, requests } = scriptedProvider([
      { toolCalls: [readTool('c1')] },
      { toolCalls: [readTool('c2')] },
      { toolCalls: [readTool('c3')] },
      { toolCalls: [{ id: 'c4', name: 'write_file', args: { path: 'confirm.txt', content: 'confirmed\n' } }] },
      { content: 'done: finished' },
    ]);
    // A context that reports one condensed tool output from the second
    // turn on — the production squeeze, made deterministic.
    let builds = 0;
    const context = {
      async buildMessages(state: { last_observation?: string; goal: string }) {
        builds += 1;
        const messages: Message[] = [
          { role: 'system', content: 'test system' },
          { role: 'user', content: state.last_observation ?? state.goal },
        ];
        if (builds >= 2) messages.push({ role: 'tool', content: CONDENSED_TOOL_OUTPUT, tool_call_id: 'condensed-marker' });
        return messages;
      },
      async compact(messages: Message[]) { return messages; },
      estimate(messages: Message[]) { return messages.length; },
    };
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      context,
      executeTool: async (call) => {
        if (call.tool === 'read_file') {
          const result = await readFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: false } };
        }
        if (call.tool === 'write_file') {
          const result = await writeFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: true } };
        }
        return { call_id: call.id, status: 'error', output: `unexpected ${call.tool}`, truncated: false, meta: {} };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({ id: 'condensed-stub-task', goal: 'read then update the file', constraints: [], done_criteria: ['confirmation file written'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
    // The request after the first condensed re-read: the honest stub, and
    // the file body is NOT served a second time (the old forget-on-condense
    // behavior re-emitted it on every repeat until the budget died).
    const afterCondensedRead = JSON.stringify(requests[2]);
    expect(afterCondensedRead).toContain('[already read earlier in this task:');
    expect(afterCondensedRead).toContain('pushed out of your visible context');
    expect(afterCondensedRead).not.toContain('[unchanged since your earlier read:');
    expect(afterCondensedRead).not.toContain('original line');
    // A third identical read is still the cheap stub, not a full serve.
    const afterThirdRead = JSON.stringify(requests[3]);
    expect(afterThirdRead).toContain('[already read earlier in this task:');
    expect(afterThirdRead).not.toContain('original line');
  });
});

describe('session anchor for conversation follow-ups (tesvite CSS loop, 2026-10-08)', () => {
  test('a follow-up inherits the recorded target and is told its working folder up front', async () => {
    const home = temp('daedalus-anchor-home-');
    const ws = temp('daedalus-anchor-ws-');
    mkdirSync(join(ws, 'tesvite', 'src'), { recursive: true });
    writeFileSync(join(ws, 'tesvite', 'src', 'App.tsx'), 'export default function App() { return null; }\n');
    const priorContext = [
      "Earlier in this conversation (most recent last) — the user's follow-ups refer to this; continue from it instead of starting cold:",
      'User: buat project vite react di folder tesvite, buat halaman website tentang biodata presiden putin dari russia yang lengkap',
      'Daedalus: Selesai. (buat project vite react di folder tesvite, buat halaman website tentang biodata presiden putin dari russia yang lengkap)',
      'target_dir: tesvite',
    ].join('\n');
    const { provider, requests } = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'tesvite/src/App.tsx', content: 'export default function App() { return <main className="parallax-container" />; }\n' } }] },
      { content: 'done: styling wired in tesvite' },
    ]);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      executeTool: async (call) => {
        if (call.tool === 'write_file') {
          const result = await writeFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: true } };
        }
        return { call_id: call.id, status: 'error', output: `unexpected ${call.tool}`, truncated: false, meta: {} };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({
      id: 'anchor-followup',
      goal: 'tapi gk diterapkan kan kok masih gini nih polos dia di app.tsx bukan jsx',
      constraints: [priorContext],
      done_criteria: ['App.tsx styling updated inside tesvite'],
      repo_path: ws,
      status: 'draft',
      conversation_id: 'conv-tesvite',
    });
    expect(state.status).toBe('done');
    expect(state.target_dir).toBe('tesvite');
    // The very first request names the working folder and the file the
    // user's "app.tsx" means — no exploring same-named files elsewhere.
    expect(JSON.stringify(requests[0])).toContain('Session anchor');
    expect(JSON.stringify(requests[0])).toContain('tesvite/src/App.tsx');
  });
});

describe('identical-call breaker (P0-3)', () => {
  function breakerLoop(replies: Reply[], extra: Record<string, unknown> = {}) {
    const home = temp('daedalus-breaker-home-');
    const ws = temp('daedalus-breaker-ws-');
    const { provider, requests } = scriptedProvider(replies);
    const store = new TaskStore(home);
    let executions = 0;
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      executeTool: async (call) => {
        executions += 1;
        return call.tool === 'write_file'
          ? { call_id: call.id, status: 'ok', output: 'wrote', truncated: false, meta: { mutating: true } }
          : { call_id: call.id, status: 'ok', output: 'file body', truncated: false, meta: { mutating: false } };
      },
      stopPolicy: { max_iterations: 30, max_errors: 10 },
      ...extra,
    });
    return { loop, store, ws, requests, executions: () => executions };
  }

  test('warn at 3, suppress at 4, hard-pause at 5 — stop ends the task as loop_hard_pause', async () => {
    const { loop, store, ws, executions } = breakerLoop(
      Array.from({ length: 8 }, (_, i) => ({ toolCalls: [readTool(`c${i}`, 'same.txt')] })),
      { onLoopHardPause: async () => 'stop' as const },
    );
    const state = await loop.run({ id: 'breaker-stop', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('loop_hard_pause');
    expect(executions()).toBe(3);
    const events = store.replay('breaker-stop');
    const warnings = events.filter((event) => event.type === 'LOOP_WARNING');
    expect(warnings.some((event) => (event.payload as { repeats?: number }).repeats === 3)).toBe(true);
    expect(warnings.some((event) => (event.payload as { kind?: string }).kind === 'hard_pause')).toBe(true);
    const reasons = events
      .filter((event) => event.type === 'TOOL_CALL_FINISHED')
      .map((event) => (event.payload as { result: { meta?: { reason?: string } } }).result.meta?.reason);
    expect(reasons.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(reasons[3]).toBe('repeat_suppressed');
    expect(reasons[4]).toBe('loop_hard_pause');
  });

  test('without a pause seam the 5th identical call stops the task the same way', async () => {
    const { loop, ws } = breakerLoop(Array.from({ length: 8 }, (_, i) => ({ toolCalls: [readTool(`c${i}`, 'same.txt')] })));
    const state = await loop.run({ id: 'breaker-default', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('loop_hard_pause');
  });

  test('user continue re-arms: the repeated call executes again under a different-approach directive', async () => {
    const { loop, store, ws, requests, executions } = breakerLoop(
      [
        ...Array.from({ length: 5 }, (_, i) => ({ toolCalls: [readTool(`c${i}`, 'same.txt')] })),
        { toolCalls: [{ id: 'c6', name: 'write_file', args: { path: 'out.txt', content: 'x\n' } }] },
        { content: 'done: recovered with a different approach' },
      ],
      { onLoopHardPause: async () => 'continue' as const },
    );
    const state = await loop.run({ id: 'breaker-continue', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
    // After the continue, the next request carries the re-arm directive.
    const afterPause = JSON.stringify(requests[5]);
    expect(afterPause).toContain('You were paused: read_file with the same arguments was repeated 5 times');
    expect(afterPause).toContain('Do NOT repeat that call');
    const warnings = store.replay('breaker-continue').filter((event) => event.type === 'LOOP_WARNING');
    expect(warnings.some((event) => (event.payload as { kind?: string }).kind === 'hard_pause')).toBe(true);
    // 3 reads executed, the 4th suppressed, the 5th executed after the
    // re-arm, then the write: 5 executions total.
    expect(executions()).toBe(5);
  });
});

describe('stall definition (fix 2)', () => {
  test('alternating read/list with no new information stalls out as no_progress, reported partial', async () => {
    const home = temp('daedalus-stall-home-');
    const ws = temp('daedalus-stall-ws-');
    writeFileSync(join(ws, 'page.txt'), 'body\n');
    let n = 0;
    const provider: LLMProvider = {
      name: 'fake',
      async chat(): Promise<ChatResponse> {
        n += 1;
        const call = n % 2 === 1
          ? { id: `c${n}`, name: 'read_file', args: { path: 'page.txt' } }
          : { id: `c${n}`, name: 'list_dir', args: { path: '.' } };
        return { message: { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: 'tool_calls' };
      },
      async *stream() {
        yield { type: 'delta', content: 'done' };
      },
    };
    const runner = new TaskRunner({ workspaceRoot: ws, store: new TaskStore(home), provider, approvalPolicy: 'auto', maxIterations: 40 });
    const result = await runner.run({ goal: 'tambahkan gambar putin', cwd: ws });
    expect(result.state.status).toBe('failed');
    expect(result.state.last_error).toBe('no_progress');
    expect(result.report.outcome).toBe('partial');
    expect(result.report.evidence.join('\n')).toContain('stuck:');
    expect(result.report.evidence.join('\n')).toContain('no file change, no successful command, no download, no new information');
    // Nowhere near the incident's 14 requests: the stall backstop
    // stops the run after a handful of turns.
    expect(result.events.filter((event) => event.type === 'MODEL_REQUEST_FINISHED').length).toBeLessThanOrEqual(10);
  });

  test('a mutating call resets the stall counter mid-sequence', async () => {
    const home = temp('daedalus-stall-home-');
    const ws = temp('daedalus-stall-ws-');
    // 4 duplicate reads (stall 1..3 after the first), then a write
    // (progress), then done — must complete, never hard-stop.
    const { provider } = scriptedProvider([
      { toolCalls: [readTool('c1')] },
      { toolCalls: [readTool('c2')] },
      { toolCalls: [readTool('c3')] },
      { toolCalls: [readTool('c4')] },
      { toolCalls: [{ id: 'c5', name: 'write_file', args: { path: 'page.txt', content: 'changed\n' } }] },
      { content: 'done: updated' },
    ]);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      executeTool: async (call) => {
        if (call.tool === 'read_file') {
          const result = await readFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: false } };
        }
        if (call.tool === 'write_file') {
          const result = await writeFileTool.execute(call.args, { workspaceRoot: ws });
          return { ...result, call_id: call.id, meta: { ...result.meta, mutating: true } };
        }
        return { call_id: call.id, status: 'error', output: 'unexpected', truncated: false, meta: {} };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    writeFileSync(join(ws, 'page.txt'), 'body\n');
    const state = await loop.run({ id: 'stall-reset', goal: 'update the file', constraints: [], done_criteria: ['page.txt updated'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
  });
});

describe('schema validation before dispatch (P0-4)', () => {
  test('the 9Router corruption shape ("3,10" as a string) is a typed parse error, never executed', async () => {
    const home = temp('daedalus-schema-home-');
    const ws = temp('daedalus-schema-ws-');
    writeFileSync(join(ws, 'page.txt'), 'a\nb\nc\n');
    let executions = 0;
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'page.txt', start_line: '3,10' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', args: {} }] },
      { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'page.txt' } }] },
      { content: 'done: read it properly' },
    ]);
    const store = new TaskStore(home);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      // The loop validates against the offered tools' schemas (the
      // runner passes the real registry; here the read_file schema).
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: readFileTool.inputSchema as Record<string, unknown> } }],
      executeTool: async (call) => {
        executions += 1;
        return { ...(await readFileTool.execute(call.args, { workspaceRoot: ws })), call_id: call.id };
      },
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({ id: 'schema-task', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
    expect(executions).toBe(1);
    const finished = store.replay('schema-task').filter((event) => event.type === 'TOOL_CALL_FINISHED');
    const first = finished[0]?.payload as { result: { output: string; meta?: { reason?: string; field?: string } } };
    expect(first.result.meta).toMatchObject({ reason: 'tool_call_parse_error', field: 'start_line' });
    expect(first.result.output).toContain('tool_call parse error');
    expect(first.result.output).toContain('start_line');
    expect(first.result.output).toContain('integer');
    expect(first.result.output).toContain('NOT executed');
    const second = finished[1]?.payload as { result: { meta?: { reason?: string; field?: string } } };
    expect(second.result.meta).toMatchObject({ reason: 'tool_call_parse_error', field: 'path' });
  });

  test('validateToolCallArguments: types, required fields, extras unpoliced', () => {
    const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'integer' }, deep: { type: 'boolean' } } };
    expect(validateToolCallArguments('read_file', schema, { path: 'a', limit: 5, extra: 1 }).ok).toBe(true);
    expect(validateToolCallArguments('read_file', schema, { path: 'a', limit: 5.5 })).toMatchObject({ ok: false, field: 'limit' });
    expect(validateToolCallArguments('read_file', schema, { path: 'a', deep: 'yes' })).toMatchObject({ ok: false, field: 'deep' });
    expect(validateToolCallArguments('read_file', schema, 'nope')).toMatchObject({ ok: false });
    expect(validateToolCallArguments('read_file', undefined, { anything: true }).ok).toBe(true);
    const out = toolCallParseErrorOutput('read_file', { ok: false, field: 'limit', reason: 'bad' }, schema);
    expect(out).toContain('limit (integer');
  });
});

describe('input-token budget (P0-5)', () => {
  const usage = { prompt_tokens: 60_000, completion_tokens: 10, total_tokens: 60_010 };

  test('crossing 100k input tokens stops the task with the spend stated', async () => {
    const home = temp('daedalus-budget-home-');
    const ws = temp('daedalus-budget-ws-');
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: 'a' } }], usage },
      { toolCalls: [{ id: 'c2', name: 'list_dir', args: { path: 'b' } }], usage },
      { toolCalls: [{ id: 'c3', name: 'list_dir', args: { path: 'c' } }], usage },
      { content: 'done: never reached' },
    ]);
    const store = new TaskStore(home);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      inputTokenBudget: 100_000,
      executeTool: async (call) => (call.tool === 'write_file'
        ? { call_id: call.id, status: 'ok', output: 'wrote', truncated: false, meta: { mutating: true } }
        : { call_id: call.id, status: 'ok', output: 'entries', truncated: false, meta: { mutating: false } }),
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({ id: 'budget-task', goal: 'look around', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('input_token_budget');
    expect(state.last_observation).toContain('120000 input tokens');
    const budgetWarnings = store.replay('budget-task').filter((event) => event.type === 'LOOP_WARNING' && (event.payload as { kind?: string }).kind === 'token_budget');
    expect(budgetWarnings).toHaveLength(1);
  });

  test('budget 0 disables the stop entirely', async () => {
    const home = temp('daedalus-budget-home-');
    const ws = temp('daedalus-budget-ws-');
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: 'a' } }], usage },
      { toolCalls: [{ id: 'c2', name: 'list_dir', args: { path: 'b' } }], usage },
      { toolCalls: [{ id: 'c3', name: 'write_file', args: { path: 'end.txt', content: 'x\n' } }], usage },
      { content: 'done: looked', usage },
    ]);
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(home),
      inputTokenBudget: 0,
      executeTool: async (call) => (call.tool === 'write_file'
        ? { call_id: call.id, status: 'ok', output: 'wrote', truncated: false, meta: { mutating: true } }
        : { call_id: call.id, status: 'ok', output: 'entries', truncated: false, meta: { mutating: false } }),
      stopPolicy: { max_iterations: 20, max_errors: 5 },
    });
    const state = await loop.run({ id: 'budget-off', goal: 'look around', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    expect(state.status).toBe('done');
  });
});

describe('tailor early-trigger (fix 3)', () => {
  const TIERS = { 'weak-m': 'fast', 'strong-m': 'strong' } as const;

  function response(content: string): ChatResponse {
    return { message: { role: 'assistant' as const, content }, finish_reason: 'stop' as const };
  }
  function toolCall(id: string, name: string, args: unknown): { type: 'tool_calls'; call: { id: string; name: string; args: unknown } } {
    return { type: 'tool_calls', call: { id, name, args } };
  }
  function scriptedModel(script: Array<ChatResponse | ReturnType<typeof toolCall>>): LLMProvider {
    let index = 0;
    return {
      name: 'scripted',
      async chat(): Promise<ChatResponse> {
        const next = script[index];
        index += 1;
        if (next && 'type' in next && next.type === 'tool_calls') {
          return {
            message: { role: 'assistant' as const, content: '', tool_calls: [{ id: next.call.id, type: 'function' as const, function: { name: next.call.name, arguments: JSON.stringify(next.call.args) } }] },
            finish_reason: 'tool_calls' as const,
          };
        }
        return next ?? response('done: script exhausted');
      },
      async *stream() {
        yield { type: 'delta', content: 'done' };
      },
    };
  }
  function pool(scripts: Record<string, Array<ChatResponse | ReturnType<typeof toolCall>>>): ModelPoolProvider {
    return new ModelPoolProvider({
      models: Object.keys(scripts),
      tiers: TIERS,
      routing: false,
      createProvider: (model: string) => scriptedModel(scripts[model] ?? []),
    });
  }
  const passingValidator = (): { validate: () => Promise<ValidationResult> } => ({
    validate: async () => ({ checks: [{ name: 'test', cmd: 'true', status: 'pass', exit_code: 0, summary: 'ok', diagnostics: [] }] }),
  });

  test('loop warning escalates ONCE to the strongest model, which finishes the task', async () => {
    const home = temp('daedalus-early-home-');
    const ws = temp('daedalus-early-ws-');
    writeFileSync(join(ws, 'index.ts'), 'export const x = 1\n');
    const runner = new TaskRunner({
      workspaceRoot: ws,
      store: new TaskStore(home),
      provider: pool({
        'weak-m': [toolCall('w1', 'read_file', { path: 'index.ts' }), toolCall('w2', 'read_file', { path: 'index.ts' }), toolCall('w3', 'read_file', { path: 'index.ts' })],
        'strong-m': [toolCall('s1', 'write_file', { path: 'fix.txt', content: 'fixed\n' }), toolCall('s2', 'write_file', { path: 'verify.txt', content: 'verified\n' }), response('done: fixed')],
      }),
      approvalPolicy: 'auto',
      validator: passingValidator(),
      maxIterations: 12,
      modelTiers: TIERS,
      onLoopHardPause: async () => 'stop',
    });
    const result = await runner.run({ goal: 'fix the thing', cwd: ws, model: 'weak-m' });
    expect(result.report.outcome).toBe('success');
    const escalations = result.events.filter((event) => event.type === 'TAILOR_ESCALATED');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.payload).toMatchObject({ reason: 'loop_warning', from_model: 'weak-m', to_model: 'strong-m' });
    expect(result.report.evidence.join('\n')).toContain('tailor early escalation: loop_warning');
    const pins = result.events.filter((event) => event.type === 'PROVIDER_CHANGED' && (event.payload as { reason?: string }).reason === 'tailor_early_escalation');
    expect(pins).toHaveLength(1);
  });

  test('no strong tier configured: no TAILOR_ESCALATED, the fail-fast still applies', async () => {
    const home = temp('daedalus-early-home-');
    const ws = temp('daedalus-early-ws-');
    writeFileSync(join(ws, 'page.txt'), 'body\n');
    const { provider } = scriptedProvider(Array.from({ length: 8 }, (_, i) => ({ toolCalls: [readTool(`c${i}`)] })));
    const runner = new TaskRunner({
      workspaceRoot: ws,
      store: new TaskStore(home),
      provider,
      approvalPolicy: 'auto',
      maxIterations: 20,
      onLoopHardPause: async () => 'stop',
    });
    const result = await runner.run({ goal: 'read the file and report', cwd: ws });
    expect(result.events.filter((event) => event.type === 'TAILOR_ESCALATED')).toHaveLength(0);
    expect(result.state.last_error).toBe('loop_hard_pause');
    expect(result.report.outcome).toBe('partial');
  });

  test('a healthy progressing task never escalates', async () => {
    const home = temp('daedalus-early-home-');
    const ws = temp('daedalus-early-ws-');
    writeFileSync(join(ws, 'index.ts'), 'export const x = 1\n');
    const runner = new TaskRunner({
      workspaceRoot: ws,
      store: new TaskStore(home),
      provider: pool({
        'weak-m': [toolCall('w1', 'write_file', { path: 'a.txt', content: 'a\n' }), toolCall('w2', 'write_file', { path: 'b.txt', content: 'b\n' }), toolCall('w3', 'write_file', { path: 'c.txt', content: 'c\n' }), response('done: wrote it')],
        'strong-m': [response('done: unused')],
      }),
      approvalPolicy: 'auto',
      validator: passingValidator(),
      maxIterations: 12,
      modelTiers: TIERS,
      onLoopHardPause: async () => 'stop',
    });
    const result = await runner.run({ goal: 'write a file', cwd: ws, model: 'weak-m' });
    expect(result.report.outcome).toBe('success');
    expect(result.events.filter((event) => event.type === 'TAILOR_ESCALATED')).toHaveLength(0);
    expect(result.events.filter((event) => event.type === 'LOOP_WARNING')).toHaveLength(0);
  });
});

describe('text-protocol invoke dialect (amendment d)', () => {
  const tools: ToolDefinition[] = [
    { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'integer' } } } } },
    { type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } } },
  ];

  test('a complete <invoke> block parses, with schema-typed coercion', () => {
    const result = parseTextToolCalls('<invoke name="read_file"><parameter name="path">src/app/page.tsx</parameter><parameter name="limit">20</parameter></invoke>', tools);
    expect(result.malformed).toBeNull();
    expect(result.calls).toEqual([{ name: 'read_file', args: { path: 'src/app/page.tsx', limit: 20 } }]);
  });

  test('prose before the invoke is kept as text; multi-line + CDATA parameters survive', () => {
    const result = parseTextToolCalls('Writing the file now.\n<invoke name="write_file"><parameter name="path">a.html</parameter><parameter name="content"><![CDATA[<div>\n  hi\n</div>]]></parameter></invoke>', tools);
    expect(result.malformed).toBeNull();
    expect(result.textBefore).toBe('Writing the file now.');
    expect(result.calls).toEqual([{ name: 'write_file', args: { path: 'a.html', content: '<div>\n  hi\n</div>' } }]);
  });

  test('the leaked fragment shape: an orphan </invoke> is a typed malformed, never silence', () => {
    const result = parseTextToolCalls('Almost done </invoke>', tools);
    expect(result.calls).toEqual([]);
    expect(result.malformed).not.toBeNull();
    expect(result.malformed?.reason).toContain('</invoke>');
    expect(result.malformed?.reason).toContain('<tool_call name="...">');
  });

  test('an unterminated invoke is malformed and executes nothing', () => {
    const result = parseTextToolCalls('<invoke name="read_file"><parameter name="path">x.txt', tools);
    expect(result.calls).toEqual([]);
    expect(result.malformed).not.toBeNull();
  });

  test('an unknown tool in invoke form names the valid tools', () => {
    const result = parseTextToolCalls('<invoke name="fly_to_moon"><parameter name="path">x</parameter></invoke>', tools);
    expect(result.calls).toEqual([]);
    expect(result.malformed?.reason).toContain('unknown tool');
    expect(result.malformed?.reason).toContain('read_file');
  });

  test('the canonical <tool_call> form still parses (regression)', () => {
    const result = parseTextToolCalls('<tool_call name="read_file"><path>a.txt</path></tool_call>', tools);
    expect(result.malformed).toBeNull();
    expect(result.calls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }]);
  });
});

describe('search_images next-step template (fix 4)', () => {
  test('results end with a concrete download → view → reference sequence from result 1', async () => {
    const ws = temp('daedalus-img-ws-');
    const impl: ImageSearchFetchImpl = async (url: string) => {
      if (url.startsWith('https://api.openverse.org/')) {
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({
            result_count: 1,
            results: [{
              title: 'Vladimir Putin portrait',
              foreign_landing_url: 'https://www.flickr.com/photos/example/9',
              url: 'https://live.staticflickr.com/9/putin.jpg',
              width: 800,
              height: 1000,
              license: 'by',
              license_version: '2.0',
              license_url: 'https://creativecommons.org/licenses/by/2.0/',
              creator: 'Jane Photographer',
              attribution: '"Vladimir Putin portrait" by Jane Photographer is licensed under CC BY 2.0',
            }],
          }),
        };
      }
      return { status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ query: { pages: [] } }) };
    };
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'vladimir putin' }, { workspaceRoot: ws });
    expect(result.status).toBe('ok');
    expect(result.output).toContain('Suggested sequence');
    expect(result.output).toContain('download_file { url: "https://live.staticflickr.com/9/putin.jpg", dest: "public/vladimir-putin-portrait.jpg"');
    expect(result.output).toContain('source_url: "https://www.flickr.com/photos/example/9"');
    expect(result.output).toContain('author: "Jane Photographer"');
    expect(result.output).toContain('license: "CC BY 2.0"');
    expect(result.output).toContain('view_image { path: "public/vladimir-putin-portrait.jpg" }');
    expect(result.output).toContain('never hotlink');
  });

  test('empty results carry no template', async () => {
    const ws = temp('daedalus-img-ws-');
    const impl: ImageSearchFetchImpl = async () => ({ status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ result_count: 0, results: [], query: { pages: [] } }) });
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'zzz-no-match' }, { workspaceRoot: ws });
    expect(result.output).toContain('No openly-licensed images found');
    expect(result.output).not.toContain('Suggested sequence');
  });
});

describe('hard-pause vs token budget ordering (live bug 2026-10-07)', () => {
  /**
   * Five identical reads where the 5th reply's usage crosses a small
   * budget in the SAME step that fires the hard-pause: usage accounting
   * records input_token_budget before the tool calls are processed, so
   * the card opens with the budget already blown. The task must wait
   * for the answer — under the bug it failed behind the card.
   */
  function blownBudgetLoop() {
    const replies: Reply[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ toolCalls: [readTool(`c${i}`, 'same.txt')], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } })),
      { toolCalls: [readTool('c4', 'same.txt')], usage: { prompt_tokens: 500, completion_tokens: 0, total_tokens: 500 } },
    ];
    const home = temp('daedalus-pause-budget-home-');
    const ws = temp('daedalus-pause-budget-ws-');
    const { provider } = scriptedProvider(replies);
    const store = new TaskStore(home);
    let executions = 0;
    let resolvePause: ((decision: 'continue' | 'stop') => void) | undefined;
    let signalAsked: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => { signalAsked = resolve; });
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store,
      inputTokenBudget: 100,
      executeTool: async (call) => {
        executions += 1;
        return { call_id: call.id, status: 'ok', output: 'file body', truncated: false, meta: { mutating: false } };
      },
      stopPolicy: { max_iterations: 30, max_errors: 10 },
      onLoopHardPause: () => new Promise<'continue' | 'stop'>((resolve) => {
        resolvePause = resolve;
        signalAsked?.();
      }),
    });
    return { loop, store, ws, asked, executions: () => executions, answer: (decision: 'continue' | 'stop') => resolvePause?.(decision) };
  }

  test('budget crossed at the 5th repeat: the task waits on the pending question, then Continue ends it with input_token_budget', async () => {
    const { loop, store, ws, asked, executions, answer } = blownBudgetLoop();
    let settled = false;
    const runPromise = loop
      .run({ id: 'pause-budget', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' })
      .then((state) => { settled = true; return state; });

    // The hard-pause question is pending — the blown budget must NOT
    // have ended the task underneath it.
    await asked;
    expect(settled).toBe(false);
    expect(store.replay('pause-budget').some((event) => event.type === 'TASK_COMPLETED')).toBe(false);

    answer('continue');
    const state = await runPromise;
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('input_token_budget');
    expect(state.last_observation).toContain('input token budget reached');
    // Repeats 1–3 executed, the 4th was suppressed, the 5th executed
    // after the user's continue re-armed it.
    expect(executions()).toBe(4);
    const events = store.replay('pause-budget');
    const hardPauseAt = events.findIndex((event) => event.type === 'LOOP_WARNING' && (event.payload as { kind?: string }).kind === 'hard_pause');
    const completedAt = events.findIndex((event) => event.type === 'TASK_COMPLETED');
    expect(hardPauseAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(hardPauseAt);
  });

  test('same setup, Stop ends the task as loop_hard_pause, not the queued budget stop', async () => {
    const { loop, store, ws, asked, executions, answer } = blownBudgetLoop();
    const runPromise = loop.run({ id: 'pause-stop', goal: 'read the file', constraints: [], done_criteria: ['result reported'], repo_path: ws, status: 'draft' });
    await asked;
    answer('stop');
    const state = await runPromise;
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('loop_hard_pause');
    expect(executions()).toBe(3);
    expect(store.replay('pause-stop').some((event) => event.type === 'TASK_COMPLETED')).toBe(true);
  });
});
