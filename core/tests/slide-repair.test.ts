import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
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

/** Minimal zip reader (same approach as slide-engine.test.ts): part name → text. */
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

function shapeOffsets(slideXml: string): Array<{ x: number; y: number }> {
  return [...slideXml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}

describe('positioned export (canvas drag placements)', () => {
  test('a dragged block exports at its slide fractions; unplaced blocks keep layout geometry', async () => {
    const root = temp('daedalus-repair-placed-');
    const deck = newDeck('Seret');
    deck.slides.push({
      id: 's-grid', layout: 'icon-grid',
      content: {
        title: 'Fitur',
        items: [
          { icon: 'zap', title: 'Cepat', desc: 'a' },
          { icon: 'shield', title: 'Aman', desc: 'b' },
          { icon: 'heart', title: 'Disukai', desc: 'c' },
        ],
      },
      // item-1 dragged to center-ish: x=0.34 of 13.333in, y=0.40 of 7.5in.
      positions: { 'item-1': { x: 0.34, y: 0.4, w: 0.32, h: 0.3 } },
    });
    await writeDeck(root, deck);
    const result = await exportDeckToPptx(deck, root);
    const parts = unzipText(join(root, result.relativePath));
    const xml = parts.get('ppt/slides/slide1.xml') ?? '';
    expect(xml).not.toBe('');
    const offs = shapeOffsets(xml);
    // 0.34 * 12192000 EMU = 4145280 (the placed card's shape offset).
    expect(offs.some((o) => Math.abs(o.x - 4145280) < 3000 && Math.abs(o.y - 2743200) < 3000)).toBe(true);
    // item-0 stays at the layout default: x = 0.6in = 548640 EMU.
    expect(offs.some((o) => Math.abs(o.x - 548640) < 100)).toBe(true);
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
