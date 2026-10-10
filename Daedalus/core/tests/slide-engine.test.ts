import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  TaskRunner,
  TaskStore,
  loadSettings,
  newDeck,
  pptxTemplatesDir,
  readDeck,
  savePptxTemplate,
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

/** Poll until the engine has persisted a fully-skeleton deck of `count` slides (the staged outline). */
async function waitForSkeleton(root: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const deck = await readDeck(root).catch(() => null);
    if (deck && deck.slides.length === count && deck.slides.every((slide) => slide.status === 'skeleton')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('engine never staged a skeleton deck');
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
  ]);
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

  test('generation with a pre-v3 (sourceless) imported template completes but its summary warns the export is approximate', async () => {
    const root = temp('daedalus-engine-sourceless-');

    // A minimal two-page template (cover + content words), imported the
    // modern way, then stripped back to its pre-v3 stored shape: no
    // source .pptx beside the JSON, no v3 fields inside it. Generation
    // still pours words into the parsed pages; only clone fidelity is
    // unavailable — and that must be said, not silent.
    const zip = new JSZip();
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${rel}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${rel}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${rel}/slide" Target="slides/slide2.xml"/></Relationships>`);
    zip.file('ppt/theme/theme1.xml', `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Mesin"><a:themeElements><a:clrScheme name="M"><a:dk1><a:srgbClr val="101418"/></a:dk1><a:lt1><a:srgbClr val="F7F3E8"/></a:lt1><a:accent1><a:srgbClr val="2E7D5C"/></a:accent1><a:hlink><a:srgbClr val="0563C1"/></a:hlink></a:clrScheme><a:fontScheme name="M"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
    zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
    zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/theme" Target="../theme/theme1.xml"/></Relationships>`);
    const shape = (id: number, size: number, x: number, y: number, w: number, h: number, sampleText: string): string =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T${id}"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="${size}"><a:solidFill><a:srgbClr val="0B3D2E"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>${sampleText}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const slide = (body: string): string =>
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rel}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide1.xml', slide(shape(2, 4400, 1219200, 2286000, 9753600, 1828800, 'Judul Contoh Lama') + shape(3, 1800, 2438400, 4114800, 7315200, 914400, 'Subjudul contoh lama')));
    zip.file('ppt/slides/slide2.xml', slide(shape(2, 2800, 853440, 457200, 6400800, 914400, 'Judul Isi Lama') + shape(3, 1400, 853440, 1645920, 6400800, 3200400, 'Poin contoh lama')));
    const templateBytes = await zip.generateAsync({ type: 'nodebuffer' });

    const template = await savePptxTemplate(root, { fileName: 'Mesin Uji.pptx', bytes: templateBytes });
    expect(template.hasSource).toBe(true);
    const dir = pptxTemplatesDir(root);
    const jsonPath = join(dir, `${template.id}.json`);
    const stored = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
    delete stored.sourceFileName;
    delete stored.sourceAddresses;
    writeFileSync(jsonPath, JSON.stringify(stored, null, 2));
    rmSync(join(dir, `${template.id}.source.pptx`), { force: true });

    const { provider } = scripted((system, user) => {
      if (system.includes(OUTLINE_SYSTEM_MARKER)) {
        return ['cover', 'content', 'content'].map((role, i) => ({ title: `Judul ${i + 1}`, keyMessage: `pesan ${i + 1}`, role }));
      }
      if (system.includes(FILL_SYSTEM_MARKER)) {
        const out: Record<string, string> = {};
        for (const m of user.matchAll(/^- (s\d+):/gm)) out[m[1]!] = 'Balasan AI';
        return out;
      }
      return {};
    });
    const { runner } = makeRunner(root, provider);
    const result = await runner.run({
      goal: 'buatkan deck tentang fotosintesis',
      taskId: 'engine-sourceless',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 3, customTemplateId: template.id },
    });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    // The generation task report carries the honesty warning: words were
    // poured, but the export could not clone the template's design.
    const reportText = result.report.evidence.join('\n');
    expect(reportText).toContain('diimpor sebelum ekspor fidelitas penuh');
    expect(reportText).toContain('impor ulang');
    expect(pptxFiles(root)).toHaveLength(1);
    const deck = await readDeck(root);
    expect(deck?.slides.every((s) => s.templateRef?.templateId === template.id)).toBe(true);
  });

  test('standard flow stages the outline in the panel; Buat fills the persisted skeleton and completes the task', async () => {
    const root = temp('daedalus-engine-standard-');
    const { provider, calls } = goodDeckProvider();
    const { runner, store } = makeRunner(root, provider);

    const pending = runner.run({
      goal: 'buatkan deck tentang keamanan siber',
      taskId: 'engine-standard',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 3 },
    });

    // Staged: skeleton persisted, nothing filled or exported, no chat
    // question card, and the task has NOT settled — it waits for Buat.
    await waitForSkeleton(root, 3);
    expect(await isSettled(pending)).toBe(false);
    expect(calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(0);
    expect(pptxFiles(root)).toHaveLength(0);
    expect(eventsOf(store, 'engine-standard', 'QUESTION_REQUESTED')).toHaveLength(0);
    expect(eventsOf(store, 'engine-standard', 'TASK_COMPLETED')).toHaveLength(0);
    // The Web's deck surfaces refresh only on FILE_CHANGED: the staged
    // skeleton write must be announced, or the Outline panel keeps its
    // pre-deck ENOENT state and Buat can never render (field hang).
    const stagedChanges = eventsOf(store, 'engine-standard', 'FILE_CHANGED');
    expect(stagedChanges).toHaveLength(1);
    const stagedPayload = stagedChanges[0]?.payload as { path?: string; operation?: string };
    expect(stagedPayload.path).toBe('deck/deck.json');
    expect(stagedPayload.operation).toBe('created');

    const released = await runner.releaseStagedDeck(root, { templateId: 'midnight-scholar' });
    expect(released?.taskId).toBe('engine-standard');
    expect(released?.outcome).toBe('success');
    expect(released?.summary).toContain('done:');

    const { state } = await pending;
    expect(state.status).toBe('done');
    const deck = await readDeck(root);
    expect(deck?.theme.templateId).toBe('midnight-scholar');
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
    expect(pptxFiles(root)).toHaveLength(1);
    expect(calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(3);
    // The fill write is announced too (modified), so the canvas and
    // outline repaint from skeleton to filled without a manual refresh.
    const changes = eventsOf(store, 'engine-standard', 'FILE_CHANGED');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect((changes.at(-1)?.payload as { operation?: string }).operation).toBe('modified');
  });

  test('staged generate fills the deck as edited in the panel meanwhile (order, titles, hand-written slide kept)', async () => {
    const root = temp('daedalus-engine-staged-edits-');
    const { provider, calls } = goodDeckProvider();
    const { runner } = makeRunner(root, provider);

    const pending = runner.run({
      goal: 'buatkan deck tentang panel surya',
      taskId: 'engine-staged-edits',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 3 },
    });
    await waitForSkeleton(root, 3);

    // Panel edits while staged: move the closing slide to the front,
    // retitle the title slide, hand-write the bullets slide outright.
    const staged = (await readDeck(root))!;
    const [titleSlide, bulletsSlide, closingSlide] = staged.slides;
    await writeDeck(root, {
      ...staged,
      slides: [
        closingSlide!,
        { ...bulletsSlide!, content: { title: 'Versi Panel', points: ['poin tulisanku sendiri'] } },
        { ...titleSlide!, content: { ...titleSlide!.content, title: 'Judul Dari Panel' } },
      ],
    });

    const released = await runner.releaseStagedDeck(root, {});
    expect(released?.outcome).toBe('success');
    const { state } = await pending;
    expect(state.status).toBe('done');

    const deck = (await readDeck(root))!;
    // Order is the panel's order, and every slide is filled.
    expect(deck.slides.map((slide) => slide.id)).toEqual([closingSlide!.id, bulletsSlide!.id, titleSlide!.id]);
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true);
    // The hand-written slide is the user's: kept verbatim, never sent to the model.
    const handwritten = deck.slides.find((slide) => slide.id === bulletsSlide!.id);
    expect(handwritten?.content).toEqual({ title: 'Versi Panel', points: ['poin tulisanku sendiri'] });
    const fillCalls = calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER));
    expect(fillCalls).toHaveLength(2);
    // The retitled slide was generated under its panel title.
    expect(fillCalls.some((call) => call.user.includes('slide title: Judul Dari Panel'))).toBe(true);
    expect(pptxFiles(root)).toHaveLength(1);
  });

  test('a staged outline abandoned by a new prompt settles honestly; the staged deck stays the one that counts', async () => {
    const root = temp('daedalus-engine-staged-supersede-');
    const { provider, calls } = goodDeckProvider();
    const { runner } = makeRunner(root, provider);

    const stagedRun = runner.run({
      goal: 'buatkan deck tentang topik lama',
      taskId: 'engine-staged-old',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 2 },
    });
    await waitForSkeleton(root, 2);

    expect(runner.abandonStagedDeck(root)).toBe(true);
    const abandoned = await stagedRun;
    expect(abandoned.state.status).toBe('failed');
    expect(abandoned.state.last_error).toBe('staged_superseded');
    expect(abandoned.outcome).toBe('failed');
    expect(calls.filter((call) => call.system.includes(FILL_SYSTEM_MARKER))).toHaveLength(0);
    expect(pptxFiles(root)).toHaveLength(0);

    // The newest prompt owns the workspace now: it resumes the staged
    // skeleton — the outline that counts — and finishes the deck.
    const fresh = await runner.run({
      goal: 'lanjutkan dengan topik terbaru',
      taskId: 'engine-staged-new',
      domain: 'slide',
      slide: { generation: 'standard' },
    });
    expect(fresh.state.status).toBe('done');
    expect(pptxFiles(root)).toHaveLength(1);
    const deck = await readDeck(root);
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
  });

  test('Buat again after a partial staged fill resumes the leftover skeletons with no live run', async () => {
    const root = temp('daedalus-engine-staged-retry-');
    let fills = 0;
    const flaky = scripted((system) => {
      if (system.includes(OUTLINE_SYSTEM_MARKER)) {
        return [0, 1].map((index) => ({ title: `Slide ${index + 1}`, layoutId: 'bullets', keyMessage: 'poin' }));
      }
      if (system.includes(FILL_SYSTEM_MARKER)) {
        fills += 1;
        if (fills <= 3) return 'bukan JSON';
        return { title: 'Terisi', points: ['satu'] };
      }
      return {};
    });
    const { runner } = makeRunner(root, flaky.provider);

    const pending = runner.run({
      goal: 'buatkan deck tentang coba lagi',
      taskId: 'engine-staged-retry',
      domain: 'slide',
      slide: { generation: 'standard', slideCount: 2 },
    });
    await waitForSkeleton(root, 2);

    const released = await runner.releaseStagedDeck(root, {});
    expect(released?.outcome).toBe('partial');
    const first = await pending;
    expect(first.state.status).toBe('failed');
    expect(first.state.last_error).toBe('slide_partial');
    expect(pptxFiles(root)).toHaveLength(0);

    // The run is over; pressing Buat again fills just the leftover
    // skeleton directly (the deck-endpoint fallback seam).
    const good = goodDeckProvider();
    const fill = await makeRunner(root, good.provider).runner.fillStagedDeck(root, {});
    expect(fill?.exported).toBeTruthy();
    expect(fill?.failures).toHaveLength(0);
    expect(pptxFiles(root)).toHaveLength(1);
    const deck = await readDeck(root);
    expect(deck?.slides.every((slide) => slide.status === 'filled')).toBe(true);
    // Nothing left at skeleton status: a further Buat is an honest null.
    expect(await makeRunner(root, good.provider).runner.fillStagedDeck(root, {})).toBeNull();
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
    const { runner, store } = makeRunner(root, provider);

    const { state } = await runner.run({
      goal: 'ganti judul slide pertama menjadi lebih singkat',
      taskId: 'engine-edit',
      domain: 'slide',
    });

    expect(state.status).toBe('done');
    // Edit writes are announced as FILE_CHANGED too, so the Web canvas
    // repaints the edited deck without a manual refresh.
    const editChanges = eventsOf(store, 'engine-edit', 'FILE_CHANGED');
    expect(editChanges).toHaveLength(1);
    expect((editChanges[0]?.payload as { operation?: string }).operation).toBe('modified');
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

describe('TaskRunner.regenerateSlide model resolution (editor variant)', () => {
  async function seededRoot(): Promise<string> {
    const root = temp('daedalus-engine-regen-model-');
    const deck = newDeck('Deck Varian');
    deck.slides = [{ id: 's-1', layout: 'bullets', content: { title: 'Lama', points: ['a'] }, status: 'filled' }];
    await writeDeck(root, deck);
    return root;
  }

  test('no model in the whole chain fails BEFORE any request with the remedy named', async () => {
    const root = await seededRoot();
    const store = new TaskStore(temp('daedalus-engine-regen-model-store-'));
    // No injected provider, no registry, no settings model: the editor
    // sent nothing and nothing is configured (the laptop "Missing
    // model" incident). The failure must name the fix, not the upstream.
    const runner = new TaskRunner({
      workspaceRoot: root, store, bus: new EventBus(),
      settings: loadSettings({ LLM_MODEL: '', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: '' }),
    });
    await expect(runner.regenerateSlide(root, 's-1')).rejects.toThrow(/no model resolved for slide regeneration/);
  });

  test('a configured settings model resolves: failure moves downstream, never the no-model error', async () => {
    const root = await seededRoot();
    const store = new TaskStore(temp('daedalus-engine-regen-model-store-'));
    const runner = new TaskRunner({
      workspaceRoot: root, store, bus: new EventBus(),
      settings: loadSettings({ LLM_MODEL: 'model-uji', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'uji' }),
    });
    const error = await runner.regenerateSlide(root, 's-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('no model resolved');
    expect((error as Error).message).toContain('model output stayed invalid');
  });
});
