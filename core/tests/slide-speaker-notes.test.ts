import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { newDeck, readDeck, writeDeck } from '../src/index.ts';
import { exportDeckToPptx } from '../src/slides/export-pptx.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('slide speaker notes', () => {
  test('notes survive a deck.json round-trip', async () => {
    const root = temp('daedalus-notes-rt-');
    const deck = newDeck('Deck Notes');
    deck.slides.push({
      id: 's-1',
      layout: 'bullets',
      content: { title: 'Pembuka', points: ['a', 'b'] },
      notes: 'Buka dengan salam hangat.',
    });
    await writeDeck(root, deck);
    const back = await readDeck(root);
    expect(back?.slides[0]?.notes).toBe('Buka dengan salam hangat.');
  });

  test('notes land in the exported PPTX notes slide', async () => {
    const root = temp('daedalus-notes-pptx-');
    const deck = newDeck('Deck Notes');
    deck.slides.push({
      id: 's-1',
      layout: 'bullets',
      content: { title: 'Pembuka', points: ['a', 'b'] },
      notes: 'Buka dengan salam hangat.',
    });
    await writeDeck(root, deck);
    const result = await exportDeckToPptx(deck, root);
    expect(result.slideCount).toBe(1);
    const outPath = join(root, result.relativePath);

    const listing = execFileSync('unzip', ['-l', outPath], { encoding: 'utf8' }) as string;
    const entry = listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop() ?? '')
      .find((name) => /notesSlide\d+\.xml$/.test(name));
    expect(entry, 'pptx should contain a notesSlide part').toBeTruthy();
    const xml = execFileSync('unzip', ['-p', outPath, entry!], { encoding: 'utf8' }) as string;
    expect(xml).toContain('Buka dengan salam hangat.');
  });
});
