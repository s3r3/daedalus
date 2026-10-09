import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ToolRegistry, newDeck, newSlideId, readDeck, validateDeck, writeDeck, type ToolCall, type ToolResult } from '../src/index.ts';
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
