import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  fillDeckSlidesStage,
  newDeck,
  newSlideId,
  readDeck,
  writeDeck,
  FILL_STAGE_TIMEOUT_MS,
  MAX_FILL_CONCURRENCY,
  MAX_STAGE_ATTEMPTS,
  type FillProgressEvent,
  type LLMProvider,
  type Message,
  type Slide,
} from '../src/index.ts';
import { structuredCall } from '../src/slides/pipeline.ts';

/**
 * Parallel per-slide fill (spec daedalus-slide-fill-speed-spec-20261009):
 * ~75s per-attempt timeout, per-slide progress events, bounded parallel
 * fill (max 3) with SERIALIZED deck writes. These tests prove the
 * mechanism with short timeouts/delays — the production constant stays
 * pinned at 75s by its own assertion.
 */

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-slidefill-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function skeletonSlide(title: string): Slide {
  return {
    id: newSlideId(),
    layout: 'bullets',
    // Exactly the layout defaults + outline title: an untouched skeleton.
    content: { title, points: ['First point'] },
    status: 'skeleton',
    keyMessage: `key message for ${title}`,
  };
}

async function seedDeck(root: string, titles: string[]): Promise<void> {
  const deck = newDeck('Deck uji paralel');
  deck.slides = titles.map((t) => skeletonSlide(t));
  await writeDeck(root, deck);
}

/** Fills each slide with content naming that slide; tracks concurrency. */
function trackingProvider(delayMs: number): { provider: LLMProvider; stats: { maxActive: number; calls: number } } {
  const stats = { maxActive: 0, calls: 0 };
  let active = 0;
  const provider = {
    name: 'fake-fill',
    async chat(messages: Message[]) {
      stats.calls += 1;
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        await sleep(delayMs);
        const user = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        const title = /slide title: ([^\n]+)/.exec(user)?.[1]?.trim() ?? 'tanpa judul';
        return {
          message: { role: 'assistant' as const, content: JSON.stringify({ title, points: [`Konten ${title}`] }) },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      } finally {
        active -= 1;
      }
    },
    async *stream() {
      yield { type: 'done' as const };
    },
  } as unknown as LLMProvider;
  return { provider, stats };
}

/** Never answers; rejects as soon as its signal aborts (like a real HTTP call). */
function hangingProvider(): LLMProvider {
  return {
    name: 'fake-hang',
    chat(_messages: Message[], _tools?: unknown, options?: { signal?: AbortSignal }): Promise<never> {
      return new Promise<never>((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    async *stream() {
      yield { type: 'done' as const };
    },
  } as unknown as LLMProvider;
}

describe('slide stage constants (spec pins)', () => {
  test('per-attempt timeout is ~75s, concurrency bounded at 3, attempts capped at 3', () => {
    expect(FILL_STAGE_TIMEOUT_MS).toBe(75_000);
    expect(MAX_FILL_CONCURRENCY).toBe(3);
    expect(MAX_STAGE_ATTEMPTS).toBe(3);
  });
});

describe('structuredCall per-attempt timeout', () => {
  test('a hung attempt fails at timeoutMs and is retried up to MAX_STAGE_ATTEMPTS', async () => {
    let calls = 0;
    const attempts: number[] = [];
    const provider: LLMProvider = {
      name: 'fake-hang-count',
      chat(_messages: Message[], _tools?: unknown, options?: { signal?: AbortSignal }): Promise<never> {
        calls += 1;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      async *stream() {
        yield { type: 'done' as const };
      },
    } as unknown as LLMProvider;
    const start = Date.now();
    await expect(
      structuredCall(provider, 'sys', 'user', (v) => ({ ok: true, value: v }), undefined, {
        timeoutMs: 200,
        onAttempt: (a) => attempts.push(a),
      }),
    ).rejects.toThrow(/attempt timed out after 200 ms/);
    const elapsed = Date.now() - start;
    expect(calls).toBe(3);
    expect(attempts).toEqual([1, 2, 3]);
    // 3 × 200ms plus overhead — nowhere near the old 3 × 180s silence.
    expect(elapsed).toBeLessThan(10_000);
  });

  test('the caller abort still escapes the retry loop immediately', async () => {
    const controller = new AbortController();
    const pending = structuredCall(hangingProvider(), 'sys', 'user', (v) => ({ ok: true, value: v }), controller.signal, { timeoutMs: 60_000 });
    await sleep(30);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('fillDeckSlidesStage parallel fill', () => {
  test('per-attempt timeout fires through the real fill path (short override)', async () => {
    const root = tmpRoot();
    await seedDeck(root, ['Slide Timeout']);
    const start = Date.now();
    const fill = await fillDeckSlidesStage(hangingProvider(), root, { timeoutMs: 250 });
    const elapsed = Date.now() - start;
    expect(fill.failures).toHaveLength(1);
    expect(fill.failures[0]!.issues.join(' ')).toMatch(/attempt timed out after 250 ms/);
    expect(elapsed).toBeLessThan(15_000);
    // The slide stays an honest skeleton failure, never fabricated.
    const deck = (await readDeck(root))!;
    expect(deck.slides[0]!.status).toBe('skeleton');
  });

  test('emits per-slide progress events (started/retry/done) with index/total', async () => {
    const root = tmpRoot();
    const titles = ['Slide Satu', 'Slide Dua', 'Slide Tiga'];
    await seedDeck(root, titles);
    const { provider } = trackingProvider(20);
    const events: FillProgressEvent[] = [];
    const fill = await fillDeckSlidesStage(provider, root, { onProgress: (e) => events.push(e) });
    expect(fill.failures).toHaveLength(0);
    const started = events.filter((e) => e.type === 'slide-started');
    const done = events.filter((e) => e.type === 'slide-done');
    expect(started).toHaveLength(3);
    expect(done).toHaveLength(3);
    expect(events.filter((e) => e.type === 'slide-failed')).toHaveLength(0);
    // Every event names its slide and its position in this fill pass.
    const byId = new Map(events.map((e) => [e.slideId, e]));
    expect(byId.size).toBe(3);
    for (const event of started) {
      expect(event.total).toBe(3);
      expect(event.index).toBeGreaterThanOrEqual(0);
      expect(event.index).toBeLessThan(3);
      expect(titles).toContain(event.title);
    }
    expect(new Set(started.map((e) => e.index))).toEqual(new Set([0, 1, 2]));
  });

  test('a retried slide emits slide-retry with the attempt number', async () => {
    const root = tmpRoot();
    await seedDeck(root, ['Slide Retry']);
    let calls = 0;
    const flaky: LLMProvider = {
      name: 'fake-flaky',
      async chat(messages: Message[]) {
        calls += 1;
        // First attempt returns garbage (invalid JSON) → retry; then valid.
        if (calls === 1) return { message: { role: 'assistant' as const, content: 'bukan json' } };
        const user = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        const title = /slide title: ([^\n]+)/.exec(user)?.[1]?.trim() ?? 'x';
        return { message: { role: 'assistant' as const, content: JSON.stringify({ title, points: ['ok'] }) } };
      },
      async *stream() {
        yield { type: 'done' as const };
      },
    } as unknown as LLMProvider;
    const events: FillProgressEvent[] = [];
    const fill = await fillDeckSlidesStage(flaky, root, { onProgress: (e) => events.push(e) });
    expect(fill.failures).toHaveLength(0);
    const retries = events.filter((e) => e.type === 'slide-retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 2, maxAttempts: 3, index: 0, total: 1 });
  });

  test('at most 3 slides fill concurrently; deck.json stays consistent', async () => {
    const root = tmpRoot();
    const titles = ['Slide 1', 'Slide 2', 'Slide 3', 'Slide 4', 'Slide 5', 'Slide 6'];
    await seedDeck(root, titles);
    const { provider, stats } = trackingProvider(80);
    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.failures).toHaveLength(0);
    // Bounded parallelism actually happened: 6 slides × 80ms hit 3 lanes.
    expect(stats.maxActive).toBeLessThanOrEqual(3);
    expect(stats.maxActive).toBe(3);
    expect(stats.calls).toBe(6);
    // Serialized writes: the file on disk is valid JSON and every slide
    // carries exactly its own fill — no cross-slide contamination from
    // interleaved writes.
    const onDisk = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ status: string; content: { title: string; points: string[] } }> };
    expect(onDisk.slides).toHaveLength(6);
    const seenTitles = new Set<string>();
    for (const slide of onDisk.slides) {
      expect(slide.status).toBe('filled');
      expect(slide.content.points).toEqual([`Konten ${slide.content.title}`]);
      seenTitles.add(slide.content.title);
    }
    expect(seenTitles).toEqual(new Set(titles));
    // In-memory deck agrees with disk.
    const mem = (await readDeck(root))!;
    expect(mem.slides.every((s) => s.status === 'filled')).toBe(true);
  });
});
