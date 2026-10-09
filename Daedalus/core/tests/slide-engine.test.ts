import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  TaskRunner,
  TaskStore,
  newDeck,
  readDeck,
  writeDeck,
  type Event,
  type LLMProvider,
  type Message,
} from '../src/index.ts';
import { regenerateSlideStage } from '../src/slides/pipeline.ts';

/**
 * SlideEngine suite (slide/agent core separation): slide-domain tasks run
 * on Slide's own engine — code-sequenced generation stages, the Standard
 * checkpoint over the shared question broker, structured edit ops, and
 * the engine's own completion verdict. No AgentLoop, no tool registry,
 * no coding completion gate is involved: the providers here record every
 * call and would expose any tool surface if one were offered.
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

function text(message: Message | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

type RecordedCall = { system: string; user: string; convo: string; tools: unknown };

/** Structured-call provider: the handler answers per prompt; every call is recorded with the tools it was offered. */
function scripted(handler: (system: string, user: string, callIndex: number) => string | object | Error): { provider: LLMProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const provider: LLMProvider = {
    name: 'engine-scripted',
    async chat(messages: Message[], tools?: unknown) {
      const system = text(messages[0]);
      const user = text(messages[1]);
      calls.push({ system, user, convo: messages.map((message) => text(message)).join('\n'), tools });
      const out = handler(system, user, calls.length);
      if (out instanceof Error) throw out;
      return {
        message: { role: 'assistant' as const, content: typeof out === 'string' ? out : JSON.stringify(out) },
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        finish_reason: 'stop',
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, calls };
}

const OUTLINE_SYSTEM_MARKER = 'OUTLINE stage';
const FILL_SYSTEM_MARKER = 'FILL stage';
const EDIT_SYSTEM_MARKER = 'EDIT stage';

/** JSON content that satisfies a layout's fill schema. */
function fillFor(user: string): Record<string, unknown> {
  const layout = /layout: (\S+)/.exec(user)?.[1] ?? 'bullets';
  if (layout === 'title') return { title: 'Judul Deck', subtitle: 'Ringkasan singkat' };
  if (layout === 'closing') return { title: 'Terima Kasih', cta: 'Mulai sekarang' };
  return { title: 'Judul Slide', points: ['poin satu', 'poin dua'] };
}

/** A provider that generates a valid deck: the outline honors the requested slide_count. */
function goodDeckProvider(): { provider: LLMProvider; calls: RecordedCall[] } {
  return scripted((system, user) => {
    if (system.includes(OUTLINE_SYSTEM_MARKER)) {
      const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 3);
      return Array.from({ length: count }, (_, index) => ({
        title: `Slide ${index + 1}`,
        layoutId: index === 0 ? 'title' : index === count - 1 && count > 2 ? 'closing' : 'bullets',
        keyMessage: `poin utama slide ${index + 1}`,
      }));
    }
    if (system.includes(FILL_SYSTEM_MARKER)) return fillFor(user);
    return {};
  });
}

function makeRunner(root: string, provider: LLMProvider): { runner: TaskRunner; store: TaskStore } {
  const store = new TaskStore(temp('daedalus-engine-store-'));
  const runner = new TaskRunner({ workspaceRoot: root, store, bus: new EventBus(), provider, approvalPolicy: 'auto' });
  return { runner, store };
}

function pptxFiles(root: string): string[] {
  const dir = join(root, 'deck');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pptx')) : [];
}

/** Minimal zip reader (same approach as the export tests): part name → text. */
function unzipText(file: string): Map<string, string> {
  const buf = readFileSync(file);
  const out = new Map<string, string>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function eventsOf(store: TaskStore, taskId: string, type: string): Event[] {
  return store.replay(taskId).filter((event) => event.type === type);
}

async function waitForQuestion(store: TaskStore, taskId: string): Promise<{ id: string; options: Array<{ label: string }> }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const requested = eventsOf(store, taskId, 'QUESTION_REQUESTED');
    const payload = requested[0]?.payload as { question?: { id: string; options: Array<{ label: string }> } } | undefined;
    if (payload?.question) return payload.question;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('engine never asked its checkpoint question');
}

describe('SlideEngine generation', () => {
  test('smart flow: outline → fill → validate → export, done only with the .pptx on disk', async () => {
    const root = temp('daedalus-engine-smart-');
    const { provider, calls } = goodDeckProvider();
    const { runner, store } = makeRunner(root, provider);

    const { state, outcome } = await runner.run({
      goal: 'buatkan deck tentang keamanan siber',
      taskId: 'engine-smart',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 3 },
    });

    expect(state.status).toBe('done');
    expect(outcome).toBe('success');
    expect(pptxFiles(root)).toHaveLength(1);
    const deck = await readDeck(root);
    expect(deck?.slides).toHaveLength(3);
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
    // Stages ran in code order: one outline call, then a fill per slide.
    expect(calls[0]?.system).toContain(OUTLINE_SYSTEM_MARKER);
    expect(calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(3);
    // Validation is the deck check, emitted by the engine itself.
    expect(eventsOf(store, 'engine-smart', 'VALIDATION_PASSED')).toHaveLength(1);
    expect(eventsOf(store, 'engine-smart', 'QUESTION_REQUESTED')).toHaveLength(0);
    // Provider usage flows through the standard event fields.
    const finished = eventsOf(store, 'engine-smart', 'MODEL_REQUEST_FINISHED');
    expect(finished.length).toBeGreaterThan(0);
    expect((finished[0]?.payload as { usage?: { total_tokens?: number } }).usage?.total_tokens).toBe(18);
    // The export is a real, editable PPTX: one slide part per slide,
    // filled text present as native text runs.
    const parts = unzipText(join(root, 'deck', pptxFiles(root)[0]!));
    const slideNames = [...parts.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slideNames).toHaveLength(3);
    const allSlides = slideNames.map((name) => parts.get(name) ?? '').join('\n');
    expect(allSlides).toContain('Judul Slide');
    expect(allSlides).toContain('poin satu');
  });

  test('standard flow: the checkpoint pauses on a persisted skeleton and the answer steers the same deck', async () => {
    const root = temp('daedalus-engine-standard-');
    const { provider, calls } = goodDeckProvider();
    const { runner, store } = makeRunner(root, provider);

    const pending = runner.run({
      goal: 'buatkan deck tentang keamanan siber',
      taskId: 'engine-standard',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 3 },
    });

    const question = await waitForQuestion(store, 'engine-standard');
    expect(question.options.map((option) => option.label)).toContain('Midnight Scholar');
    // While the question is pending, the skeleton deck is already on disk
    // and nothing has been filled or exported yet.
    const skeleton = await readDeck(root);
    expect(skeleton?.slides).toHaveLength(3);
    expect(skeleton?.slides.every((slide) => slide.status === 'skeleton')).toBe(true);
    expect(pptxFiles(root)).toHaveLength(0);

    expect(runner.questions.answer(question.id, 'midnight-scholar')).toBe(true);
    const { state } = await pending;

    expect(state.status).toBe('done');
    const deck = await readDeck(root);
    expect(deck?.theme.templateId).toBe('midnight-scholar');
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
    expect(pptxFiles(root)).toHaveLength(1);
    expect(eventsOf(store, 'engine-standard', 'QUESTION_ANSWERED')).toHaveLength(1);
    expect(calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(3);
  });

  test('composer parameters reach the outline stage (count and language)', async () => {
    const root = temp('daedalus-engine-composer-');
    const { provider, calls } = goodDeckProvider();
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'buatkan deck tentang fotosintesis',
      taskId: 'engine-composer',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 2, language: 'Bahasa Indonesia' },
    });

    expect(state.status).toBe('done');
    const outlineCall = calls.find((call) => call.system.includes(OUTLINE_SYSTEM_MARKER));
    expect(outlineCall?.user).toContain('exactly 2');
    expect(outlineCall?.user).toContain('Bahasa Indonesia');
  });

  test('a fill that never validates leaves an honest partial: failed state, skeleton kept, no export — and a later run resumes it', async () => {
    const root = temp('daedalus-engine-partial-');
    let fills = 0;
    const flaky = scripted((system) => {
      if (system.includes(OUTLINE_SYSTEM_MARKER)) {
        return [0, 1, 2].map((index) => ({ title: `Slide ${index + 1}`, layoutId: 'bullets', keyMessage: 'poin' }));
      }
      if (system.includes(FILL_SYSTEM_MARKER)) {
        fills += 1;
        // The middle slide's fill is persistently unusable JSON.
        if (fills >= 2 && fills <= 4) return 'ini bukan JSON sama sekali';
        return { title: 'Terisi', points: ['satu', 'dua'] };
      }
      return {};
    });
    const { runner } = makeRunner(root, flaky.provider);

    const first = await runner.run({
      goal: 'buatkan deck tentang parsial',
      taskId: 'engine-partial',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 3 },
    });

    expect(first.state.status).toBe('failed');
    expect(first.state.last_error).toBe('slide_partial');
    expect(first.outcome).toBe('partial');
    expect(pptxFiles(root)).toHaveLength(0);
    const partial = await readDeck(root);
    expect(partial?.slides.filter((slide) => slide.status === 'filled')).toHaveLength(2);
    expect(partial?.slides.filter((slide) => slide.status === 'skeleton')).toHaveLength(1);

    // Resume: a fresh task in the same workspace fills only the skeleton.
    const good = goodDeckProvider();
    const resumed = await makeRunner(root, good.provider).runner.run({
      goal: 'lanjutkan deck yang belum selesai',
      taskId: 'engine-partial-resume',
      domain: 'slide',
      slide: { generation: 'smart' },
    });

    expect(resumed.state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
    expect(good.calls.filter((call) => call.system.includes(OUTLINE_SYSTEM_MARKER))).toHaveLength(0);
    expect(good.calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(1);
    const deck = await readDeck(root);
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
  });

  test('invalid model output is retried with the verbatim issues before failing honestly', async () => {
    const root = temp('daedalus-engine-retry-');
    const { provider, calls } = scripted((system) => {
      if (system.includes(OUTLINE_SYSTEM_MARKER)) {
        return [{ title: 'Satu', layoutId: 'bukan-layout', keyMessage: 'pembuka' }];
      }
      return {};
    });
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'buatkan deck',
      taskId: 'engine-retry',
      domain: 'slide',
      slide: { generation: 'smart' },
    });

    expect(state.status).toBe('failed');
    const outlineCalls = calls.filter((call) => call.system.includes(OUTLINE_SYSTEM_MARKER));
    expect(outlineCalls).toHaveLength(3);
    // The retry prompt carries the validator's words, not a paraphrase.
    expect(outlineCalls[1]?.convo).toContain('unknown layoutId');
    expect(await readDeck(root)).toBeNull();
  });
});

describe('SlideEngine edit ops', () => {
  async function seedDeck(root: string): Promise<void> {
    const deck = newDeck('Deck Edit');
    deck.slides = [
      { id: 's-1', layout: 'bullets', content: { title: 'Pertama', points: ['a'] }, status: 'filled' },
      { id: 's-2', layout: 'bullets', content: { title: 'Kedua', points: ['b'] }, status: 'filled' },
    ];
    await writeDeck(root, deck);
  }

  test('one structured call updates only the targeted slide; the rest stay identical; no export unless asked', async () => {
    const root = temp('daedalus-engine-edit-');
    await seedDeck(root);
    const { provider, calls } = scripted((system) => {
      if (system.includes(EDIT_SYSTEM_MARKER)) {
        return { ops: [{ op: 'update_slide', slide_id: 's-1', content: { title: 'Diganti' } }], summary: 'judul slide 1 diganti' };
      }
      return {};
    });
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'ganti judul slide pertama menjadi lebih singkat',
      taskId: 'engine-edit',
      domain: 'slide',
    });

    expect(state.status).toBe('done');
    const deck = await readDeck(root);
    expect(deck?.slides[0]?.content.title).toBe('Diganti');
    expect(deck?.slides[0]?.content.points).toEqual(['a']);
    expect(deck?.slides[1]).toEqual({ id: 's-2', layout: 'bullets', content: { title: 'Kedua', points: ['b'] }, status: 'filled' });
    expect(pptxFiles(root)).toHaveLength(0);
    expect(calls.filter((call) => call.system.includes(EDIT_SYSTEM_MARKER))).toHaveLength(1);
  });

  test('edit + export request applies the ops, validates, and writes the .pptx', async () => {
    const root = temp('daedalus-engine-edit-export-');
    await seedDeck(root);
    const { provider } = scripted((system) => {
      if (system.includes(EDIT_SYSTEM_MARKER)) {
        return { ops: [{ op: 'set_theme', templateId: 'midnight-scholar' }], summary: 'tema diganti' };
      }
      return {};
    });
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'ganti tema deck lalu export ke pptx',
      taskId: 'engine-edit-export',
      domain: 'slide',
    });

    expect(state.status).toBe('done');
    expect((await readDeck(root))?.theme.templateId).toBe('midnight-scholar');
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('invalid ops are rejected with the issues, retried, and the deck file stays byte-identical', async () => {
    const root = temp('daedalus-engine-edit-invalid-');
    await seedDeck(root);
    const before = readFileSync(join(root, 'deck', 'deck.json'), 'utf8');
    const { provider, calls } = scripted((system) => {
      if (system.includes(EDIT_SYSTEM_MARKER)) {
        return { ops: [{ op: 'update_slide', slide_id: 'tidak-ada', content: { title: 'X' } }], summary: 'coba' };
      }
      return {};
    });
    const { runner } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'ubah slide yang tidak ada',
      taskId: 'engine-edit-invalid',
      domain: 'slide',
    });

    expect(state.status).toBe('failed');
    expect(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')).toBe(before);
    const editCalls = calls.filter((call) => call.system.includes(EDIT_SYSTEM_MARKER));
    expect(editCalls).toHaveLength(3);
    expect(editCalls[1]?.convo).toContain('does not exist');
  });
});

describe('routing: slide tasks never touch the coding machinery', () => {
  test('a slide-domain run offers the provider no tools and emits no tool-call events', async () => {
    const root = temp('daedalus-engine-routing-');
    const { provider, calls } = goodDeckProvider();
    const { runner, store } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'buatkan deck tentang routing',
      taskId: 'routing-slide',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 2 },
    });

    expect(state.status).toBe('done');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.tools).toBeUndefined();
    expect(eventsOf(store, 'routing-slide', 'TOOL_CALL_STARTED')).toHaveLength(0);
    expect(eventsOf(store, 'routing-slide', 'TOOL_CALL_FINISHED')).toHaveLength(0);
    expect(eventsOf(store, 'routing-slide', 'TASK_COMPLETED')).toHaveLength(1);
  });

  test('a coding run still constructs the loop: tools offered, tool calls executed', async () => {
    const root = temp('daedalus-engine-routing-coding-');
    const seenTools: string[][] = [];
    let step = 0;
    const provider: LLMProvider = {
      name: 'coding-scripted',
      async chat(_messages: Message[], tools?: Array<{ function?: { name?: string } }>) {
        seenTools.push((tools ?? []).map((tool) => tool.function?.name ?? ''));
        step += 1;
        if (step === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'halo.txt', content: 'halo\n' }) } }],
            },
          };
        }
        return { message: { role: 'assistant' as const, content: 'done: halo.txt exists' } };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const store = new TaskStore(temp('daedalus-routing-coding-store-'));
    const runner = new TaskRunner({
      workspaceRoot: root,
      store,
      bus: new EventBus(),
      provider,
      approvalPolicy: 'auto',
      validator: {
        async validate() {
          return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
        },
      },
    });

    const { state } = await runner.run({ goal: 'tulis file halo.txt\ndone: halo.txt exists', taskId: 'routing-coding' });

    expect(state.status).toBe('done');
    expect(seenTools[0]).toContain('write_file');
    expect(eventsOf(store, 'routing-coding', 'TOOL_CALL_STARTED').length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'halo.txt'))).toBe(true);
  });
});

describe('regenerateSlideStage (editor variant seam)', () => {
  test('regenerates one slide in place and leaves the others untouched', async () => {
    const root = temp('daedalus-engine-regen-');
    const deck = newDeck('Deck Varian');
    deck.slides = [
      { id: 's-1', layout: 'bullets', content: { title: 'Lama', points: ['a'] }, status: 'filled' },
      { id: 's-2', layout: 'bullets', content: { title: 'Tetap', points: ['b'] }, status: 'filled' },
    ];
    await writeDeck(root, deck);
    const { provider } = scripted((system) => {
      if (system.includes(FILL_SYSTEM_MARKER)) return { title: 'Varian Baru', points: ['segar'] };
      return {};
    });

    const result = await regenerateSlideStage(provider, root, 's-1');

    expect(result.slide.content.title).toBe('Varian Baru');
    const after = await readDeck(root);
    expect(after?.slides[0]?.content.title).toBe('Varian Baru');
    expect(after?.slides[1]).toEqual(deck.slides[1]);
  });

  test('an unknown slide id fails honestly and writes nothing', async () => {
    const root = temp('daedalus-engine-regen-missing-');
    const deck = newDeck('Deck Varian');
    deck.slides = [{ id: 's-1', layout: 'bullets', content: { title: 'Lama', points: ['a'] }, status: 'filled' }];
    await writeDeck(root, deck);
    const before = readFileSync(join(root, 'deck', 'deck.json'), 'utf8');
    const { provider } = goodDeckProvider();

    await expect(regenerateSlideStage(provider, root, 'tidak-ada')).rejects.toThrow(/not found/);
    expect(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')).toBe(before);
  });
});
