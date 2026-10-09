import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  EventBus,
  TaskStore,
  createDefaultRegistry,
  type LLMProvider,
  type Message,
  type TaskSpec,
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

type ScriptStep = { tool: string; args: unknown } | { text: string };

/** Same scripted-provider shape as the completion-gate suite: unscripted turns claim done. */
function scriptedProvider(steps: ScriptStep[], seen?: Message[][]): LLMProvider {
  let index = 0;
  return {
    name: 'slide-gate-scripted',
    async chat(messages: Message[]) {
      seen?.push(messages);
      const step = steps[index++];
      if (!step) return { message: { role: 'assistant' as const, content: 'done: nothing further scripted' } };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text } };
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

function makeLoop(root: string, provider: LLMProvider): { loop: AgentLoop; store: TaskStore } {
  const registry = createDefaultRegistry();
  const store = new TaskStore(join(root, '.daedalus-tasks'));
  const loop = new AgentLoop({
    provider,
    bus: new EventBus(),
    store,
    stopPolicy: { max_iterations: 12, max_errors: 5 },
    executeTool: (call) => registry.execute(call, { workspaceRoot: root }),
  });
  return { loop, store };
}

function spec(root: string, id: string, goal: string, domain?: 'slide', criteria: string[] = ['outline deck dibuat', 'isi slide lengkap', 'deck ter-export ke pptx']): TaskSpec {
  return {
    id,
    goal,
    repo_path: root,
    constraints: [],
    done_criteria: criteria,
    created_at: new Date().toISOString(),
    ...(domain ? { domain } : {}),
  };
}

function pptxFiles(root: string): string[] {
  const dir = join(root, 'deck');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pptx')) : [];
}

function systemOf(messages: Message[] | undefined): string {
  const content = messages?.find((message) => message.role === 'system')?.content;
  return typeof content === 'string' ? content : '';
}

describe('slide completion gate in the agent loop', () => {
  test('a slide task that exports before claiming done succeeds and leaves a .pptx', async () => {
    const root = temp('daedalus-slide-gate-ok-');
    const provider = scriptedProvider([
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin Utama', points: ['satu', 'dua'] } } },
      { tool: 'export_deck', args: {} },
    ]);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-ok', 'buatkan deck presentasi tentang keamanan anak', 'slide'));
    expect(state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('claiming done over an unexported deck buys one repair turn, then fails slide_export_missing', async () => {
    const root = temp('daedalus-slide-gate-refuse-');
    const seen: Message[][] = [];
    const provider = scriptedProvider([
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
    ], seen);
    const { loop, store } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-refuse', 'buatkan deck presentasi tentang keamanan anak', 'slide'));
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('slide_export_missing');
    // create + add + first done-claim + refusal repair + second done-claim.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const recoveries = store.replay('gate-refuse').filter((event) => event.type === 'RECOVERY_STARTED');
    expect(recoveries).toHaveLength(1);
    expect(JSON.stringify(recoveries[0]?.payload ?? {})).toContain('slide_export_missing');
    expect(pptxFiles(root)).toHaveLength(0);
  });

  test('after the repair turn, exporting lets the next done-claim succeed', async () => {
    const root = temp('daedalus-slide-gate-repair-');
    const provider = scriptedProvider([
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
      { text: 'done: deck selesai' },
      { tool: 'export_deck', args: {} },
    ]);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-repair', 'buatkan deck presentasi tentang keamanan anak', 'slide'));
    expect(state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a presentation goal with zero deck work is refused: the markdown shortcut cannot report success', async () => {
    const root = temp('daedalus-slide-gate-markdown-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'slides.md', content: '# Slide draft\n' } },
      { text: 'done: slide selesai' },
      { text: 'done: slide selesai' },
    ]);
    const { loop, store } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-markdown', 'buatkan slide tentang keamanan anak', 'slide'));
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('slide_export_missing');
    const recoveries = store.replay('gate-markdown').filter((event) => event.type === 'RECOVERY_STARTED');
    expect(recoveries).toHaveLength(1);
    expect(JSON.stringify(recoveries[0]?.payload ?? {})).toContain('slide_export_missing');
  });

  test('after a markdown refusal, building and exporting the deck still succeeds', async () => {
    const root = temp('daedalus-slide-gate-markdown-fix-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'slides.md', content: '# Slide draft\n' } },
      { text: 'done: slide selesai' },
      { tool: 'create_deck', args: { title: 'Keamanan Anak' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Poin', points: ['satu'] } } },
      { tool: 'export_deck', args: {} },
    ]);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-markdown-fix', 'buatkan slide tentang keamanan anak', 'slide'));
    expect(state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a read-only slide question is never export-gated', async () => {
    const root = temp('daedalus-slide-gate-question-');
    mkdirSync(join(root, 'deck'), { recursive: true });
    writeFileSync(join(root, 'deck', 'deck.json'), '{"slides":[{},{}]}\n');
    const provider = scriptedProvider([{ tool: 'read_file', args: { path: 'deck/deck.json' } }]);
    const { loop, store } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-question', 'ada berapa slide di deck workspace ini?', 'slide', ['pertanyaan terjawab']));
    // The assertion is the gate's absence: no export repair is started and
    // the task never fails for the slide reason. (How question-shaped
    // goals fare as tasks is a separate harness concern.)
    expect(state.last_error).not.toBe('slide_export_missing');
    expect(store.replay('gate-question').filter((event) => event.type === 'RECOVERY_STARTED')).toEqual([]);
  });

  test('a coding task doing the same work is never slide-gated', async () => {
    const root = temp('daedalus-slide-gate-coding-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'catatan.txt', content: 'halo\n' } },
    ]);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-coding', 'buatkan file catatan', undefined, ['file catatan dibuat']));
    expect(state.status).toBe('done');
    expect(state.last_error).toBeUndefined();
  });

  test('a coding-domain presentation goal is export-gated: a markdown draft cannot report success', async () => {
    const root = temp('daedalus-slide-gate-coding-md-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'slides-biologi.md', content: '# Biologi\n' } },
      { text: 'done: slide selesai' },
      { text: 'done: slide selesai' },
    ]);
    const { loop, store } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-coding-md', 'buatkan 8 slide tentang biologi', undefined, ['deck presentasi dibuat dengan deck tools', 'pptx ter-export']));
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('slide_export_missing');
    expect(pptxFiles(root)).toHaveLength(0);
    const recoveries = store.replay('gate-coding-md').filter((event) => event.type === 'RECOVERY_STARTED');
    expect(recoveries).toHaveLength(1);
    expect(JSON.stringify(recoveries[0]?.payload ?? {})).toContain('slide_export_missing');
  });

  test('a coding-domain presentation goal completes once the deck is built and exported', async () => {
    const root = temp('daedalus-slide-gate-coding-export-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'slides-biologi.md', content: '# Biologi\n' } },
      { text: 'done: slide selesai' },
      { tool: 'create_deck', args: { title: 'Biologi' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Sel', points: ['satu', 'dua'] } } },
      { tool: 'export_deck', args: {} },
    ]);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-coding-export', 'buatkan 8 slide tentang biologi', undefined, ['deck presentasi dibuat dengan deck tools', 'pptx ter-export']));
    expect(state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a coding-domain ordinary goal stays ungated and unsteered', async () => {
    const root = temp('daedalus-slide-gate-coding-plain-');
    const seen: Message[][] = [];
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'ringkasan.md', content: '# Ringkasan biologi\n' } },
    ], seen);
    const { loop, store } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-coding-plain', 'buatkan ringkasan tentang biologi', undefined, ['ringkasan dibuat']));
    expect(state.status).toBe('done');
    expect(state.last_error).toBeUndefined();
    expect(store.replay('gate-coding-plain').filter((event) => event.type === 'RECOVERY_STARTED')).toEqual([]);
    expect(systemOf(seen[0])).not.toContain('Slide goal in the Coding domain');
  });

  test('a coding-domain presentation goal is steered to the deck tools in its prompt', async () => {
    const root = temp('daedalus-slide-gate-coding-steer-');
    const seen: Message[][] = [];
    const provider = scriptedProvider([
      { tool: 'create_deck', args: { title: 'Biologi' } },
      { tool: 'add_slide', args: { layout: 'bullets', content: { title: 'Sel', points: ['satu', 'dua'] } } },
      { tool: 'export_deck', args: {} },
    ], seen);
    const { loop } = makeLoop(root, provider);
    const state = await loop.run(spec(root, 'gate-coding-steer', 'buatkan 8 slide tentang biologi', undefined, ['deck presentasi dibuat dengan deck tools', 'pptx ter-export']));
    expect(state.status).toBe('done');
    const system = systemOf(seen[0]);
    expect(system).toContain('Slide goal in the Coding domain');
    expect(system).toContain('export_deck');
  });
});
