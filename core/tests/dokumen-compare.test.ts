import { describe, expect, test } from 'vitest';
import {
  compareTexts,
  describeWordDiff,
  splitParagraphs,
  textSimilarity,
  wordDiff,
} from '../src/index.ts';

/**
 * Fase C (desain 4.2): bandingkan dua dokumen — diff deterministik per
 * paragraf dengan detail per kata. Jujur: teks identik → nol perubahan.
 */

const V1 = `KONTRAK KERJA SAMA

Pasal 1: Para pihak sepakat bekerja sama dalam bidang jasa konsultasi.

Pasal 2: Nilai kontrak sebesar Rp 100.000.000.

Pasal 3: Jangka waktu 12 bulan sejak ditandatangani.`;

const V2 = `KONTRAK KERJA SAMA

Pasal 1: Para pihak sepakat bekerja sama dalam bidang jasa konsultasi.

Pasal 2: Nilai kontrak sebesar Rp 150.000.000.

Pasal 4: Denda keterlambatan sebesar 2% per hari.`;

describe('splitParagraphs', () => {
  test('splits on blank lines and drops empties', () => {
    expect(splitParagraphs('a\n\nb\n\n\nc')).toEqual(['a', 'b', 'c']);
    expect(splitParagraphs('  \n\n ')).toEqual([]);
  });
});

describe('textSimilarity', () => {
  test('identical texts score 1, unrelated score low', () => {
    expect(textSimilarity('denda 2% per hari', 'denda 2% per hari')).toBe(1);
    expect(textSimilarity('apel merah', 'kontrak kerja sama')).toBeLessThan(0.4);
  });
});

describe('wordDiff + describeWordDiff', () => {
  test('marks changed words', () => {
    const tokens = wordDiff('denda 2% per hari', 'denda 5% per hari');
    expect(tokens.filter((t) => t.kind === 'del').map((t) => t.text)).toEqual(['2%']);
    expect(tokens.filter((t) => t.kind === 'ins').map((t) => t.text)).toEqual(['5%']);
  });

  test('describeWordDiff renders «old» → «new»', () => {
    // "Rp" sama di kedua sisi → tidak masuk hunk perubahan (minimal diff).
    expect(describeWordDiff('Nilai kontrak sebesar Rp 100.000.000.', 'Nilai kontrak sebesar Rp 150.000.000.')).toBe(
      '«100.000.000.» → «150.000.000.»',
    );
  });
});

describe('compareTexts (Fase C 4.2)', () => {
  test('identical texts produce zero changes', () => {
    const r = compareTexts(V1, V1);
    expect(r.counts).toEqual({ added: 0, removed: 0, changed: 0, same: 4 });
    expect(r.summary).toEqual([]);
    expect(r.blocks.every((b) => b.kind === 'same')).toBe(true);
  });

  test('detects changed, added, and removed paragraphs', () => {
    const r = compareTexts(V1, V2);
    expect(r.counts.changed).toBe(1); // Pasal 2: 100jt → 150jt
    expect(r.counts.added).toBe(1); // Pasal 4
    expect(r.counts.removed).toBe(1); // Pasal 3
    expect(r.counts.same).toBe(2); // judul + Pasal 1
  });

  test('changed block carries old/new text and word-level detail', () => {
    const r = compareTexts(V1, V2);
    const changed = r.blocks.find((b) => b.kind === 'changed')!;
    expect(changed.oldText).toContain('100.000.000');
    expect(changed.newText).toContain('150.000.000');
    expect(changed.detail).toContain('100.000.000');
    expect(changed.detail).toContain('150.000.000');
  });

  test('summary lines use ~ / + / - markers like the design mockup', () => {
    const r = compareTexts(V1, V2);
    expect(r.summary.some((s) => s.startsWith('~'))).toBe(true);
    expect(r.summary.some((s) => s.startsWith('+'))).toBe(true);
    expect(r.summary.some((s) => s.startsWith('-'))).toBe(true);
    const changedLine = r.summary.find((s) => s.startsWith('~'))!;
    expect(changedLine).toMatch(/→/);
  });

  test('empty vs text: everything is added; text vs empty: everything removed', () => {
    const r1 = compareTexts('', 'satu\n\ndua');
    expect(r1.counts.added).toBe(2);
    const r2 = compareTexts('satu\n\ndua', '');
    expect(r2.counts.removed).toBe(2);
  });

  test('completely rewritten text pairs nothing as changed', () => {
    const r = compareTexts('apel jeruk mangga', 'kontrak kerja sama denda');
    expect(r.counts.changed).toBe(0);
    expect(r.counts.removed + r.counts.added).toBeGreaterThan(0);
  });
});
