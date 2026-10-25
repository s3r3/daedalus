import { layoutBlockKeys } from './layouts.ts';
import type { BlockPosition } from './deck.ts';

/**
 * Tiga varian susunan elemen per slide (Dae Captain 9.2): deterministic
 * block-placement presets — bukan regenerate AI. Every variant is a set of
 * slide-fraction placements (the same `positions` the canvas editor's drag
 * writes); applying one is an ordinary slide update, so validateDeck and
 * the ↩️ Undo path treat it exactly like a hand drag.
 *
 * The first block key of the layout is treated as the header (title-ish),
 * the rest as the body. w/h are omitted on purpose: rectFor() keeps the
 * layout's own size for an omitted dimension, so a variant can never clip
 * a block — it only rearranges.
 */
export type SlideVariant = {
  /** Stable ids: 'klasik' | 'terpusat' | 'bersisian' | 'melebar'. */
  id: string;
  label: string;
  description: string;
  /** Slide-fraction placements keyed by block name; empty = no change. */
  positions: Record<string, BlockPosition>;
};

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function centered(header: string, body: string[]): Record<string, BlockPosition> {
  const positions: Record<string, BlockPosition> = {
    [header]: { x: 0.22, y: 0.06, w: 0.56 },
  };
  const n = body.length;
  const top = 0.28;
  const slot = 0.66 / Math.max(1, n);
  body.forEach((key, i) => {
    positions[key] = { x: 0.27, y: r3(top + i * slot), w: 0.46 };
  });
  return positions;
}

function sideBySide(header: string, body: string[]): Record<string, BlockPosition> {
  const positions: Record<string, BlockPosition> = {
    [header]: { x: 0.06, y: 0.05, w: 0.88 },
  };
  const left = body.filter((_, i) => i % 2 === 0);
  const right = body.filter((_, i) => i % 2 === 1);
  const top = 0.24;
  const col = (keys: string[], x: number): void => {
    const slot = 0.68 / Math.max(1, keys.length);
    keys.forEach((key, i) => {
      positions[key] = { x, y: r3(top + i * slot), w: 0.4 };
    });
  };
  col(left, 0.06);
  col(right, 0.54);
  return positions;
}

function wide(header: string, body: string[]): Record<string, BlockPosition> {
  const positions: Record<string, BlockPosition> = {
    [header]: { x: 0.08, y: 0.05, w: 0.84 },
  };
  if (body.length > 0) {
    positions[body[0]!] = { x: 0.06, y: 0.24, w: 0.88 };
  }
  return positions;
}

/**
 * Exactly three arrangement variants for one slide. [] when the layout
 * has no blocks to rearrange (e.g. 'template-page', whose design is owned
 * by the imported PPT template — variants never touch it).
 */
export function slideVariants(layoutId: string, content: Record<string, unknown>): SlideVariant[] {
  if (layoutId === 'template-page') return [];
  const keys = layoutBlockKeys(layoutId, content);
  if (keys.length === 0) return [];
  const [header, ...body] = keys as [string, ...string[]];
  const variants: SlideVariant[] = [
    {
      id: 'klasik',
      label: 'Klasik',
      description: 'Tata letak bawaan template — tanpa perubahan posisi.',
      positions: {},
    },
    {
      id: 'terpusat',
      label: 'Terpusat',
      description: 'Judul di tengah atas, isi dirangkum di tengah slide.',
      positions: centered(header, body),
    },
  ];
  if (body.length >= 2) {
    variants.push({
      id: 'bersisian',
      label: 'Bersisian',
      description: 'Isi dibagi dua kolom kiri–kanan di bawah judul.',
      positions: sideBySide(header, body),
    });
  } else {
    variants.push({
      id: 'melebar',
      label: 'Melebar',
      description: 'Isi direntangkan selebar slide di bawah judul.',
      positions: wide(header, body),
    });
  }
  return variants;
}
