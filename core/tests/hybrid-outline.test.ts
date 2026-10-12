import { describe, expect, test } from 'vitest';
import { buildHybridSlideDraft, buildHybridSlideOutline, validateHybridSlideOutline } from '../src/slides/hybrid-generator.ts';
import { LAYOUTS } from '../src/slides/layouts.ts';

/**
 * Topic-aware outline planner: structure must come from the user's
 * topic — never from the old generator's hard-coded biology filler,
 * which asserted the same "science of life" text for every subject.
 */

const LAYOUT_IDS = new Set(LAYOUTS.map((l) => l.id));
// Filler signatures of the previous generator: generic sequence seeds
// and invented domain claims stapled onto unrelated topics.
const OLD_FILLER = [
  'bidang ilmu yang mempelajari kehidupan',
  'organisme',
  'sistem biologis',
  'Pengenalan umum',
  'Struktur dan fungsi',
  'Interaksi antar sistem',
];

describe('buildHybridSlideOutline', () => {
  test('a computer-history deck is about computer history — coherent arc, no biology filler', () => {
    const slides = buildHybridSlideOutline({ topic: 'Sejarah Komputer', n_slides: 8, language: 'Indonesia' });
    expect(slides).toHaveLength(8);
    expect(slides.map((s) => s.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(slides[0]?.designNotes?.layout).toBe('title');
    expect(slides[slides.length - 1]?.designNotes?.layout).toBe('closing');
    // A history topic gets the chronological layout for its process slide.
    expect(slides.some((s) => s.designNotes?.layout === 'timeline')).toBe(true);
    for (const slide of slides) {
      expect(slide.title).toContain('Komputer');
      expect(slide.content).toContain(slide.title);
      for (const filler of OLD_FILLER) expect(slide.content).not.toContain(filler);
    }
    expect(new Set(slides.map((s) => s.title)).size).toBe(slides.length);
    expect(validateHybridSlideOutline(slides, 8)).toEqual([]);
  });

  test('an Islamic-perspective deck stays on its own subject', () => {
    const slides = buildHybridSlideOutline({ topic: 'Perspektif Islam tentang Larangan Makan Babi', n_slides: 6, language: 'Indonesia' });
    expect(slides).toHaveLength(6);
    for (const slide of slides) {
      expect(slide.title).toMatch(/Islam|Babi|Larangan/);
      expect(slide.content).not.toContain('mempelajari kehidupan');
      expect(slide.content).not.toContain('organisme');
    }
    expect(validateHybridSlideOutline(slides, 6)).toEqual([]);
  });

  test('two unrelated topics produce materially different, topic-referencing outlines', () => {
    const a = buildHybridSlideOutline({ topic: 'Sejarah Komputer', n_slides: 8, language: 'Indonesia' });
    const b = buildHybridSlideOutline({ topic: 'Fotosintesis pada Tumbuhan', n_slides: 8, language: 'Indonesia' });
    expect(a.map((s) => s.title)).not.toEqual(b.map((s) => s.title));
    expect(a.every((s) => s.title.includes('Komputer'))).toBe(true);
    expect(b.every((s) => s.title.includes('Fotosintesis'))).toBe(true);
    // The chronology cue exists only in the history topic.
    expect(a.some((s) => s.designNotes?.layout === 'timeline')).toBe(true);
    expect(b.some((s) => s.designNotes?.layout === 'timeline')).toBe(false);
  });

  test('compound topics get one slide angle per named facet', () => {
    const slides = buildHybridSlideOutline({ topic: 'Kecerdasan Buatan: Etika, Regulasi, dan Dampak Ekonomi', n_slides: 8, language: 'Indonesia' });
    const titles = slides.map((s) => s.title);
    expect(titles.some((t) => t.includes('Etika'))).toBe(true);
    expect(titles.some((t) => t.includes('Regulasi'))).toBe(true);
    expect(titles.some((t) => t.includes('Dampak Ekonomi'))).toBe(true);
    expect(validateHybridSlideOutline(slides, 8)).toEqual([]);
  });

  test('requested counts are respected exactly, including edges', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 9, 12]) {
      const slides = buildHybridSlideOutline({ topic: 'Sejarah Komputer', n_slides: n, language: 'Indonesia' });
      expect(slides).toHaveLength(n);
      expect(validateHybridSlideOutline(slides, n)).toEqual([]);
      expect(slides[0]?.designNotes?.layout).toBe('title');
      if (n >= 2) expect(slides[n - 1]?.designNotes?.layout).toBe('closing');
    }
    expect(buildHybridSlideOutline({ topic: 'X', n_slides: 99 })).toHaveLength(12);
    expect(buildHybridSlideOutline({ topic: 'X', n_slides: 0 })).toHaveLength(1);
  });

  test('layouts are real catalog layouts and vary across the deck', () => {
    const slides = buildHybridSlideOutline({ topic: 'Sejarah Komputer', n_slides: 10, language: 'Indonesia' });
    for (const slide of slides) expect(LAYOUT_IDS.has(slide.designNotes?.layout ?? '')).toBe(true);
    expect(new Set(slides.map((s) => s.designNotes?.layout)).size).toBeGreaterThanOrEqual(5);
  });

  test('english requests get english scaffolding; output is deterministic', () => {
    const args = { topic: 'History of Computing', n_slides: 6, language: 'English' };
    const a = buildHybridSlideOutline(args);
    expect(a[1]?.title).toContain('Background');
    expect(a[a.length - 2]?.title).toContain('Conclusion');
    expect(buildHybridSlideOutline(args)).toEqual(a);
  });

  test('the draft bundle keeps outline, prompts, markdown and issues consistent', () => {
    const draft = buildHybridSlideDraft('Sejarah Komputer', 8);
    expect(draft.outline).toHaveLength(8);
    expect(draft.prompts).toHaveLength(8);
    expect(draft.issues).toEqual([]);
    expect(draft.markdown).toContain('Sejarah Komputer');
    expect(draft.markdown).not.toContain('mempelajari kehidupan');
  });
});
