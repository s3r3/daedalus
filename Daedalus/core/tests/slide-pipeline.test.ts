import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  EventBus,
  TaskStore,
  createDefaultRegistry,
  createSlideRegistry,
  readDeck,
  type LLMProvider,
  type Message,
  type TaskSpec,
  type ToolRegistry,
} from '../src/index.ts';
import type { ToolCall, ToolResult } from '../src/contracts.ts';

/**
 * Slide generation pipeline: code owns sequencing (outline → fill →
 * validate → export), the model only fills schema-bound JSON slots.
 * These tests drive the pipeline tools with scripted providers — the
 * same harness style as the completion-gate suite — and check the real
 * deck state on disk, not just tool output strings.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let callSeq = 0;
async function run(reg: ToolRegistry, root: string, tool: string, args: unknown): Promise<ToolResult> {
  callSeq += 1;
  const call: ToolCall = { id: `c${callSeq}`, task_id: 't-pipeline', turn_id: 'u1', tool, args, started_at: new Date().toISOString() };
  return reg.execute(call, { workspaceRoot: root });
}

function pptxFiles(root: string): string[] {
  const dir = join(root, 'deck');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pptx')) : [];
}

function textOf(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return '';
}

function outlineJson(topic: string, n: number): string {
  const items: Array<{ title: string; layoutId: string; keyMessage: string }> = [];
  for (let i = 0; i < n; i += 1) {
    const layoutId = i === 0 ? 'title' : i === n - 1 && n >= 3 ? 'closing' : i % 2 === 1 ? 'bullets' : 'icon-grid';
    items.push({ title: `${topic} — bagian ${i + 1}`, layoutId, keyMessage: `Pesan kunci ${i + 1} tentang ${topic}` });
  }
  return JSON.stringify(items);
}

function fillContentFor(layout: string, title: string): Record<string, unknown> {
  switch (layout) {
    case 'title': return { title, subtitle: 'Ringkasan' };
    case 'closing': return { title, cta: 'Terima kasih' };
    case 'section': return { title };
    case 'bullets': return { title, points: [`Poin satu tentang ${title}`, 'Poin dua'] };
    case 'quote': return { text: 'Kutipan yang relevan.', author: 'Sumber' };
    case 'two-column': return { title, left: { heading: 'Sisi A', points: ['Satu'] }, right: { heading: 'Sisi B', points: ['Dua'] } };
    case 'comparison': return { title, left: { title: 'Sisi A', points: ['Satu'] }, right: { title: 'Sisi B', points: ['Dua'] } };
    case 'icon-grid': return { title, items: [{ icon: 'zap', title: 'Satu' }, { icon: 'shield', title: 'Dua' }, { icon: 'heart', title: 'Tiga' }] };
    case 'timeline': return { title, events: [{ when: '1900', title: 'Awal' }, { when: '2000', title: 'Akhir' }] };
    default: return { title };
  }
}

/** A cooperative pipeline model: answers the outline and fill stages from the prompts themselves. `failLayout` makes one layout's fill return unfillable content until cleared. */
function pipelineFake(topic = 'Sejarah Komputer'): {
  provider: LLMProvider;
  calls: Message[][];
  setFailLayout: (layout: string | undefined) => void;
} {
  const calls: Message[][] = [];
  let failLayout: string | undefined;
  const provider: LLMProvider = {
    name: 'slide-pipeline-scripted',
    async chat(messages: Message[]) {
      calls.push(messages);
      const system = textOf(messages[0]);
      const firstUser = textOf(messages.find((m) => m.role === 'user'));
      if (system.includes('OUTLINE stage')) {
        const n = Number(firstUser.match(/slide_count: (\d+)/)?.[1] ?? 3);
        return { message: { role: 'assistant' as const, content: outlineJson(topic, n) } };
      }
      if (system.includes('FILL stage')) {
        const layout = system.match(/Layout: (\S+) \(/)?.[1] ?? 'bullets';
        const title = firstUser.match(/slide title: (.+)/)?.[1] ?? 'Slide';
        if (layout === failLayout) return { message: { role: 'assistant' as const, content: '{}' } };
        return { message: { role: 'assistant' as const, content: JSON.stringify(fillContentFor(layout, title)) } };
      }
      return { message: { role: 'assistant' as const, content: '{}' } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return {
    provider,
    calls,
    setFailLayout: (layout) => { failLayout = layout; },
  };
}

/** A queue-driven provider for retry tests: each chat returns the next scripted raw response. */
function queueProvider(responses: string[]): { provider: LLMProvider; calls: Message[][] } {
  const calls: Message[][] = [];
  let index = 0;
  const provider: LLMProvider = {
    name: 'slide-pipeline-queue',
    async chat(messages: Message[]) {
      calls.push(messages);
      const content = responses[Math.min(index, responses.length - 1)] ?? '{}';
      index += 1;
      return { message: { role: 'assistant' as const, content } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, calls };
}

describe('slide generation pipeline tools', () => {
  test('standard outline: persists a skeleton deck and returns the outline + template choices', async () => {
    const root = temp('daedalus-pipeline-outline-');
    const fake = pipelineFake();
    const reg = createSlideRegistry(fake.provider);
    const res = await run(reg, root, 'generate_deck_outline', { topic: 'Sejarah Komputer', slideCount: 4, language: 'Bahasa Indonesia' });
    expect(res.status).toBe('ok');
    expect(res.meta.exported).toBe(false);
    const outline = res.meta.outline as Array<{ title: string; layoutId: string; keyMessage: string }>;
    expect(outline).toHaveLength(4);
    expect(outline[0]?.layoutId).toBe('title');
    expect(res.meta.templates).toContain('midnight-scholar');
    expect(res.output).toContain('ask_user');
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(4);
    expect(deck?.slides.every((s) => s.status === 'skeleton')).toBe(true);
    expect(deck?.slides.every((s) => typeof s.keyMessage === 'string' && s.keyMessage.length > 0)).toBe(true);
    expect(pptxFiles(root)).toHaveLength(0);
  });

  test('standard fill: completes the SAME skeleton slides (updated, not duplicated) and exports a real pptx', async () => {
    const root = temp('daedalus-pipeline-fill-');
    const fake = pipelineFake();
    const reg = createSlideRegistry(fake.provider);
    await run(reg, root, 'generate_deck_outline', { topic: 'Sejarah Komputer', slideCount: 4 });
    const before = await readDeck(root);
    const idsBefore = before?.slides.map((s) => s.id);
    const res = await run(reg, root, 'generate_deck_slides', {});
    expect(res.status).toBe('ok');
    expect(res.meta.exported).toBe(true);
    expect(String(res.meta.path)).toMatch(/\.pptx$/);
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(4);
    expect(deck?.slides.map((s) => s.id)).toEqual(idsBefore);
    expect(deck?.slides.every((s) => s.status === 'filled')).toBe(true);
    const bullets = deck?.slides.find((s) => s.layout === 'bullets');
    expect(bullets?.content.points).toEqual([expect.stringContaining('Poin satu'), 'Poin dua']);
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('smart flow: generate_deck runs outline→fill→validate→export in one call', async () => {
    const root = temp('daedalus-pipeline-smart-');
    const fake = pipelineFake('Biologi Sel');
    const reg = createSlideRegistry(fake.provider);
    const res = await run(reg, root, 'generate_deck', { topic: 'Biologi Sel', slideCount: 3 });
    expect(res.status).toBe('ok');
    expect(res.meta.exported).toBe(true);
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(3);
    expect(deck?.slides.every((s) => s.status === 'filled')).toBe(true);
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('outline stage retries with the verbatim issues appended, then succeeds', async () => {
    const root = temp('daedalus-pipeline-retry-');
    const wrongCount = JSON.stringify([
      { title: 'Satu', layoutId: 'title', keyMessage: 'a' },
      { title: 'Dua', layoutId: 'closing', keyMessage: 'b' },
    ]);
    const badLayout = JSON.stringify([
      { title: 'Satu', layoutId: 'title', keyMessage: 'a' },
      { title: 'Dua', layoutId: 'banana', keyMessage: 'b' },
      { title: 'Tiga', layoutId: 'bullets', keyMessage: 'c' },
      { title: 'Empat', layoutId: 'closing', keyMessage: 'd' },
    ]);
    const queue = queueProvider([wrongCount, badLayout, outlineJson('Topik Uji', 4)]);
    const reg = createSlideRegistry(queue.provider);
    const res = await run(reg, root, 'generate_deck_outline', { topic: 'Topik Uji', slideCount: 4 });
    expect(res.status).toBe('ok');
    expect(queue.calls).toHaveLength(3);
    const secondFeedback = queue.calls[1]?.map((m) => textOf(m)).join('\n') ?? '';
    expect(secondFeedback).toContain('expected exactly 4 outline items, got 2');
    const thirdFeedback = queue.calls[2]?.map((m) => textOf(m)).join('\n') ?? '';
    expect(thirdFeedback).toContain('unknown layoutId "banana"');
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(4);
  });

  test('an outline that never validates fails honestly and persists no deck', async () => {
    const root = temp('daedalus-pipeline-badoutline-');
    const queue = queueProvider(['ini bukan json', 'masih bukan json', '{"tidak": "sesuai"}']);
    const reg = createSlideRegistry(queue.provider);
    const res = await run(reg, root, 'generate_deck_outline', { topic: 'Topik Uji', slideCount: 3 });
    expect(res.status).toBe('error');
    expect(res.output).toContain('invalid after 3 attempts');
    expect(existsSync(join(root, 'deck', 'deck.json'))).toBe(false);
    expect(pptxFiles(root)).toHaveLength(0);
  });

  test('a slide failing every fill attempt stays skeleton, blocks export, and resume finishes it', async () => {
    const root = temp('daedalus-pipeline-partial-');
    const fake = pipelineFake('Biologi');
    const reg = createSlideRegistry(fake.provider);
    await run(reg, root, 'generate_deck_outline', { topic: 'Biologi', slideCount: 3 });
    fake.setFailLayout('bullets');
    const partial = await run(reg, root, 'generate_deck_slides', {});
    expect(partial.status).toBe('ok');
    expect(partial.meta.exported).toBe(false);
    expect(partial.output).toContain('PARTIAL');
    expect(pptxFiles(root)).toHaveLength(0);
    const midDeck = await readDeck(root);
    const stuck = midDeck?.slides.find((s) => s.layout === 'bullets');
    expect(stuck?.status).toBe('skeleton');
    expect(partial.output).toContain(stuck?.id ?? 'none');
    fake.setFailLayout(undefined);
    const resumed = await run(reg, root, 'generate_deck_slides', {});
    expect(resumed.status).toBe('ok');
    expect(resumed.meta.exported).toBe(true);
    const deck = await readDeck(root);
    expect(deck?.slides.every((s) => s.status === 'filled')).toBe(true);
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('registry composition: pipeline tools exist only in the provider-bound slide registry', async () => {
    const fake = pipelineFake();
    const pipelineNames = ['generate_deck_outline', 'generate_deck_slides', 'generate_deck'];
    const codingNames = createDefaultRegistry().schemas().map((s) => s.function.name);
    for (const name of pipelineNames) expect(codingNames).not.toContain(name);
    const slideNames = createSlideRegistry(fake.provider).schemas().map((s) => s.function.name);
    for (const name of pipelineNames) expect(slideNames).toContain(name);
    expect(slideNames).toContain('create_deck');
    expect(slideNames).toContain('export_deck');
    const unboundNames = createSlideRegistry().schemas().map((s) => s.function.name);
    for (const name of pipelineNames) expect(unboundNames).not.toContain(name);
  });
});

/* ------------------------------------------------------------ loop */

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(steps: ScriptStep[]): LLMProvider {
  let index = 0;
  return {
    name: 'slide-pipeline-agent-scripted',
    async chat() {
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

function makeLoop(root: string, provider: LLMProvider, registry: ToolRegistry): { loop: AgentLoop; store: TaskStore } {
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

describe('slide completion gate with pipeline tools', () => {
  test('a slide task driven only by pipeline tools satisfies the gate', async () => {
    const root = temp('daedalus-pipeline-gate-ok-');
    const pipeline = pipelineFake();
    const agent = scriptedProvider([
      { tool: 'generate_deck_outline', args: { topic: 'Sejarah Komputer', slideCount: 3 } },
      { tool: 'generate_deck_slides', args: {} },
    ]);
    const { loop } = makeLoop(root, agent, createSlideRegistry(pipeline.provider));
    const state = await loop.run(spec(root, 'pipe-gate-ok', 'buatkan slide tentang sejarah komputer', 'slide'));
    expect(state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a partial pipeline generation cannot satisfy the gate', async () => {
    const root = temp('daedalus-pipeline-gate-partial-');
    const pipeline = pipelineFake('Biologi');
    pipeline.setFailLayout('bullets');
    const agent = scriptedProvider([
      { tool: 'generate_deck', args: { topic: 'Biologi', slideCount: 3 } },
      { text: 'done: deck selesai' },
      { text: 'done: deck selesai' },
    ]);
    const { loop } = makeLoop(root, agent, createSlideRegistry(pipeline.provider));
    const state = await loop.run(spec(root, 'pipe-gate-partial', 'buatkan slide tentang biologi', 'slide'));
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('slide_export_missing');
    expect(pptxFiles(root)).toHaveLength(0);
    const deck = await readDeck(root);
    expect(deck?.slides.some((s) => s.status === 'skeleton')).toBe(true);
  });

  test('an ordinary coding task is unaffected by the pipeline wiring', async () => {
    const root = temp('daedalus-pipeline-gate-coding-');
    const agent = scriptedProvider([
      { tool: 'write_file', args: { path: 'catatan.txt', content: 'halo\n' } },
    ]);
    const { loop } = makeLoop(root, agent, createDefaultRegistry());
    const state = await loop.run(spec(root, 'pipe-gate-coding', 'buatkan file catatan', undefined, ['file catatan dibuat']));
    expect(state.status).toBe('done');
    expect(state.last_error).toBeUndefined();
  });
});
