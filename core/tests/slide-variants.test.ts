import { describe, expect, test } from 'vitest';
import { layoutBlockKeys } from '../src/slides/layouts.ts';
import { slideVariants } from '../src/slides/variants.ts';

function assertSane(layoutId: string, content: Record<string, unknown>): void {
  const variants = slideVariants(layoutId, content);
  expect(variants).toHaveLength(3);
  expect(variants[0]!.id).toBe('klasik');
  expect(variants[1]!.id).toBe('terpusat');
  const known = new Set(layoutBlockKeys(layoutId, content));
  for (const v of variants) {
    expect(v.label.length).toBeGreaterThan(0);
    expect(v.description.length).toBeGreaterThan(0);
    for (const [key, p] of Object.entries(v.positions)) {
      expect(known.has(key), `variant ${v.id} names a real block`).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeLessThanOrEqual(1);
      if (p.w !== undefined) {
        expect(p.w).toBeGreaterThan(0);
        expect(p.x + p.w).toBeLessThanOrEqual(1);
      }
      if (p.h !== undefined) {
        expect(p.h).toBeGreaterThan(0);
        expect(p.y + p.h).toBeLessThanOrEqual(1);
      }
    }
  }
}

describe('slideVariants', () => {
  test('bullets slide gets 3 valid variants, third is wide (single body block)', () => {
    const variants = slideVariants('bullets', { title: 'T', points: ['a'] });
    expect(variants.map((v) => v.id)).toEqual(['klasik', 'terpusat', 'melebar']);
    expect(variants[0]!.positions).toEqual({});
    assertSane('bullets', { title: 'T', points: ['a'] });
  });

  test('two-column slide gets the side-by-side variant', () => {
    const content = {
      title: 'T',
      left: { heading: 'Kiri', points: ['a'] },
      right: { heading: 'Kanan', points: ['b'] },
    };
    const variants = slideVariants('two-column', content);
    expect(variants.map((v) => v.id)).toEqual(['klasik', 'terpusat', 'bersisian']);
    const side = variants[2]!.positions;
    expect(side.left!.x).toBeLessThan(side.right!.x);
    assertSane('two-column', content);
  });

  test('single-body slide gets the wide variant instead of side-by-side', () => {
    const variants = slideVariants('title', { title: 'T', subtitle: 'S' });
    expect(variants.map((v) => v.id)).toEqual(['klasik', 'terpusat', 'melebar']);
    assertSane('title', { title: 'T', subtitle: 'S' });
  });

  test('multi-block layout (icon-grid) stays in bounds', () => {
    assertSane('icon-grid', {
      title: 'T',
      items: [
        { icon: 'a', title: '1' },
        { icon: 'b', title: '2' },
        { icon: 'c', title: '3' },
      ],
    });
  });

  test('template-page slides have no variants (design owned by the template)', () => {
    expect(slideVariants('template-page', { slots: {} })).toEqual([]);
  });
});
