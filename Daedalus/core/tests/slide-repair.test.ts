import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventBus, TaskRunner, TaskStore, ToolRegistry, newDeck, newSlideId, readDeck, validateDeck, writeDeck, type LLMProvider, type Message, type ToolCall, type ToolResult } from '../src/index.ts';
import { exportDeckToPptx } from '../src/slides/export-pptx.ts';
import { SLIDE_TOOLS } from '../src/tools/slides.ts';

/**
 * Slide-system repair tests: deck-state handling, slide identity
 * integrity, and the empty-deck export hole (an exported placeholder
 * title slide must never count as a generated presentation).
 */

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function slideRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of SLIDE_TOOLS) r.register(t);
  return r;
}

let callSeq = 0;
async function run(reg: ToolRegistry, root: string, tool: string, args: unknown): Promise<ToolResult> {
  callSeq += 1;
  const call: ToolCall = { id: `c${callSeq}`, task_id: 't-repair', turn_id: 'u1', tool, args, started_at: new Date().toISOString() };
  return reg.execute(call, { workspaceRoot: root });
}

function pptxFiles(root: string): string[] {
  const dir = join(root, 'deck');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pptx')) : [];
}

describe('deck tools before create_deck', () => {
  test('read/add/update/validate/export on a fresh workspace return one clear no-deck state, never an ENOENT', async () => {
    const root = temp('daedalus-repair-nodeck-');
    const reg = slideRegistry();
    for (const [tool, args] of [
      ['read_deck', {}],
      ['add_slide', { layout: 'bullets', content: { title: 'X', points: ['a'] } }],
      ['update_slide', { slideId: 's-1', content: { title: 'Y' } }],
      ['validate_deck', {}],
      ['export_deck', {}],
    ] as Array<[string, unknown]>) {
      const res = await run(reg, root, tool, args);
      expect(res.status).toBe('error');
      expect(res.output).toContain('no deck yet: run create_deck first');
      expect(res.output).not.toContain('ENOENT');
    }
    expect(existsSync(join(root, 'deck', 'deck.json'))).toBe(false);

    // And create_deck then works from that same state (no wedged files).
    const created = await run(reg, root, 'create_deck', { title: 'Baru' });
    expect(created.status).toBe('ok');
    expect(await readDeck(root)).not.toBeNull();
  });
});

describe('slide identity integrity', () => {
  test('validateDeck flags duplicate and missing slide ids as errors', () => {
    const deck = newDeck('Ids');
    deck.slides.push(
      { id: 's-1', layout: 'bullets', content: { title: 'A', points: ['a'] } },
      { id: 's-1', layout: 'bullets', content: { title: 'B', points: ['b'] } },
      { id: '', layout: 'bullets', content: { title: 'C', points: ['c'] } },
    );
    const issues = validateDeck(deck);
    expect(issues.some((i) => i.code === 'duplicate-slide-id' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'missing-slide-id' && i.severity === 'error')).toBe(true);

    const healthy = newDeck('Fine');
    healthy.slides.push({ id: newSlideId(), layout: 'bullets', content: { title: 'A', points: ['a'] } });
    expect(validateDeck(healthy).filter((i) => i.code.endsWith('slide-id'))).toHaveLength(0);
  });
});

describe('empty deck export', () => {
  test('exportDeckToPptx refuses an empty deck and writes no file', async () => {
    const root = temp('daedalus-repair-empty-');
    const deck = newDeck('Kosong');
    await writeDeck(root, deck);
    await expect(exportDeckToPptx(deck, root)).rejects.toThrow(/empty deck/);
    expect(pptxFiles(root)).toHaveLength(0);
  });

  test('export_deck on an empty deck errors and produces no .pptx (gate cannot be satisfied by a placeholder)', async () => {
    const root = temp('daedalus-repair-emptytool-');
    const reg = slideRegistry();
    expect((await run(reg, root, 'create_deck', { title: 'Kosong' })).status).toBe('ok');
    const res = await run(reg, root, 'export_deck', {});
    expect(res.status).toBe('error');
    expect(res.output).toContain('empty deck');
    expect(pptxFiles(root)).toHaveLength(0);
  });
});

type RawStep = { tool: string; rawArgs: string } | { text: string };

/** Scripted provider that can emit raw (even malformed) argument strings. */
function rawProvider(steps: RawStep[], seen?: Message[][]): LLMProvider {
  let index = 0;
  return {
    name: 'slide-repair-scripted',
    async chat(messages: Message[]) {
      seen?.push(messages);
      const step = steps[index++];
      if (!step) return { message: { role: 'assistant' as const, content: 'done: nothing further scripted' } };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text } };
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: `raw-${index}`, type: 'function' as const, function: { name: step.tool, arguments: step.rawArgs } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

const J = (value: unknown): string => JSON.stringify(value);

describe('Standard vs Smart flows (harness level)', () => {
  test('Smart: a mid-fill invalid slide is an error result, not a task failure; the deck so far survives and export completes', async () => {
    const root = temp('daedalus-repair-smart-');
    const seen: Message[][] = [];
    const provider = rawProvider([
      { tool: 'create_deck', rawArgs: J({ title: 'Smart Deck' }) },
      { tool: 'add_slide', rawArgs: J({ layout: 'title', content: { title: 'Smart Deck' } }) },
      { tool: 'add_slide', rawArgs: J({ layout: 'stats', content: { title: 'Angka', stats: [{ value: '42' }] } }) },
      { tool: 'add_slide', rawArgs: J({ layout: 'bullets', content: { title: 'Isi', points: ['satu', 'dua'] } }) },
      { tool: 'export_deck', rawArgs: J({}) },
    ], seen);
    const store = new TaskStore(temp('daedalus-repair-smart-store-'));
    const runner = new TaskRunner({ workspaceRoot: root, store, bus: new EventBus(), provider, approvalPolicy: 'auto' });
    const { state } = await runner.run({
      goal: 'buatkan deck smart\ndeck dibuat dan terisi\ndeck ter-export ke pptx',
      taskId: 'repair-smart',
      domain: 'slide',
      slide: { generation: 'smart' },
    });
    expect(state.status).toBe('done');
    expect((await readDeck(root))?.slides).toHaveLength(2);
    expect(pptxFiles(root)).toHaveLength(1);
    const transcript = JSON.stringify(seen);
    expect(transcript).toContain('invalid content for layout stats');
  });

  test('Standard: the outline checkpoint answer steers the same skeleton deck (theme applied, skeleton slide filled, not rebuilt)', async () => {
    const root = temp('daedalus-repair-standard-');
    const seen: Message[][] = [];
    // The skeleton bullets slide is the most recently added one, so its
    // id is the last "(slide-…)" mentioned in the tool results.
    const skeletonId = (messages: Message[]): string => {
      const matches = JSON.stringify(messages).match(/\(slide-[0-9a-z-]{4,}\)/g) ?? [];
      const last = matches[matches.length - 1];
      return last ? last.slice(1, -1) : '';
    };
    const provider: LLMProvider = {
      name: 'slide-repair-standard',
      async chat(messages: Message[]) {
        seen.push(messages);
        const step = seen.length;
        const call = (tool: string, args: unknown) => ({
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: `std-${step}`, type: 'function' as const, function: { name: tool, arguments: J(args) } }],
          },
        });
        if (step === 1) return call('create_deck', { title: 'Standar' });
        if (step === 2) return call('add_slide', { layout: 'title', content: { title: 'Standar' } });
        if (step === 3) return call('add_slide', { layout: 'bullets', content: { title: 'Kerangka', points: ['kerangka'] } });
        if (step === 4) return call('ask_user', { question: 'Pilih desain untuk presentasi ini:', options: [{ label: 'Midnight Scholar' }, { label: 'Ocean' }] });
        if (step === 5) return call('set_deck_theme', { templateId: 'midnight-scholar' });
        if (step === 6) return call('update_slide', { slideId: skeletonId(messages), content: { title: 'Kerangka', points: ['isi final satu', 'isi final dua'] } });
        if (step === 7) return call('export_deck', {});
        return { message: { role: 'assistant' as const, content: 'done: deck selesai' } };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const store = new TaskStore(temp('daedalus-repair-std-store-'));
    const runner = new TaskRunner({ workspaceRoot: root, store, bus: new EventBus(), provider, approvalPolicy: 'auto' });
    const { state, events } = await runner.run({
      goal: 'buatkan deck standar\ndeck dibuat dan terisi\ndeck ter-export ke pptx',
      taskId: 'repair-standard',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 2, language: 'Bahasa Indonesia' },
      onEvent: (event) => {
        if (event.type === 'QUESTION_REQUESTED') {
          const question = (event.payload as { question?: { id: string } }).question;
          if (question) setTimeout(() => runner.questions.answer(question.id, 'Midnight Scholar'), 5);
        }
      },
    });
    expect(events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(true);
    expect(events.some((event) => event.type === 'QUESTION_ANSWERED')).toBe(true);
    expect(state.status).toBe('done');
    const deck = await readDeck(root);
    expect(deck?.theme.templateId).toBe('midnight-scholar');
    expect(deck?.slides).toHaveLength(2);
    expect(deck?.slides[1]?.content.points).toEqual(['isi final satu', 'isi final dua']);
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a tool call with truncated JSON arguments gets an invalid-arguments result and the task recovers', async () => {
    const root = temp('daedalus-repair-truncated-');
    const seen: Message[][] = [];
    const provider = rawProvider([
      { tool: 'create_deck', rawArgs: J({ title: 'Potong' }) },
      { tool: 'add_slide', rawArgs: '{"layout":"bullets","content":{"title":"Terpotong"' },
      { tool: 'add_slide', rawArgs: J({ layout: 'bullets', content: { title: 'Utuh', points: ['satu'] } }) },
      { tool: 'export_deck', rawArgs: J({}) },
    ], seen);
    const store = new TaskStore(temp('daedalus-repair-trunc-store-'));
    const runner = new TaskRunner({ workspaceRoot: root, store, bus: new EventBus(), provider, approvalPolicy: 'auto' });
    const { state, events } = await runner.run({
      goal: 'buatkan deck\ndeck dibuat dan terisi\ndeck ter-export ke pptx',
      taskId: 'repair-truncated',
      domain: 'slide',
      slide: { generation: 'smart' },
    });
    expect(state.status).toBe('done');
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(1);
    expect(deck?.slides[0]?.content.title).toBe('Utuh');
    // The malformed call never executed: no slide was added for it, no
    // tool-call events carry it, and the model was told its reply was
    // invalid instead of the task crashing or looping.
    expect(events.filter((event) => event.type === 'TOOL_CALL_STARTED')).toHaveLength(3);
    expect(JSON.stringify(seen)).toContain('Invalid model response');
    expect(pptxFiles(root)).toHaveLength(1);
  });
});

describe('per-slide failure recovery (Smart-style incremental fill)', () => {
  test('an invalid add_slide names the problem, preserves the deck so far, and the next valid add succeeds', async () => {
    const root = temp('daedalus-repair-recover-');
    const reg = slideRegistry();
    expect((await run(reg, root, 'create_deck', { title: 'Pemulihan' })).status).toBe('ok');
    expect((await run(reg, root, 'add_slide', { layout: 'title', content: { title: 'Pemulihan' } })).status).toBe('ok');

    const bad = await run(reg, root, 'add_slide', { layout: 'stats', content: { title: 'Angka', stats: [{ value: '42' }] } });
    expect(bad.status).toBe('error');
    expect(bad.output).toContain('invalid content for layout stats');

    const after = await readDeck(root);
    expect(after?.slides).toHaveLength(1);
    expect(after?.slides[0]?.layout).toBe('title');

    const good = await run(reg, root, 'add_slide', { layout: 'bullets', content: { title: 'Isi', points: ['satu', 'dua'] } });
    expect(good.status).toBe('ok');
    expect((await readDeck(root))?.slides).toHaveLength(2);
  });
});
