import type { DeckTheme } from './deck.ts';
import { getLayout } from './layouts.ts';
import { getSlideTemplate } from './templates.ts';

/**
 * Built-in slide templates ("Template bawaan"): Daedalus-born design
 * sets the outline is poured into — the same conceptual contract as an
 * imported PPT template ("design set the words flow into"), implemented
 * on our own deck system. Each template is a distinct design LANGUAGE:
 * its own preferred layouts per slide kind, layered decorative
 * furniture drawn natively by the canvas renderer and the PPTX
 * exporter, typography treatment, and a base skin. The 5 "Warna &
 * Font" entries (slides/templates.ts) remain the skin layer: a
 * template is built on one skin, and a Warna & Font pick can still
 * re-skin a deck without touching its design (deck.theme.designId
 * survives a skin pick; see server /slides/deck/theme).
 *
 * This module is pure (no node:* transitively) so the Web canvas
 * resolves exactly the same registry as core and the exporter.
 */

export type BuiltinSlideKind = 'cover' | 'toc' | 'section' | 'content' | 'visual' | 'chart' | 'closing';

export type FurnitureColorRole = 'accent' | 'surface' | 'text' | 'muted' | 'background';

export type FurnitureAnchor =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'top-center' | 'bottom-center'
  | 'top-edge' | 'bottom-edge' | 'left-edge' | 'right-edge';

/**
 * One decorative shape painted behind the content blocks, from a spec
 * shared verbatim by the canvas renderer and the PPTX exporter (the
 * same slide-fraction geometry `positions` use). Furniture lives at the
 * slide margins/edges so it never collides with content boxes, which
 * start inside the ~3% inset every layout keeps.
 */
export type FurnitureElement = {
  shape: 'rect' | 'ellipse' | 'roundRect' | 'line';
  anchor: FurnitureAnchor;
  /** Inset from the anchor edge/corner, slide fractions; negative bleeds off-slide. */
  dx?: number;
  dy?: number;
  /** Size, slide fractions (width of slide width, height of slide height). */
  w?: number;
  h?: number;
  color: FurnitureColorRole;
  /** 0..1, default 1. The exporter blends toward the background color. */
  opacity?: number;
  /** Slide kinds this element shows on; default: all kinds. */
  kinds?: BuiltinSlideKind[];
};

export type FurnitureSpec = {
  elements: FurnitureElement[];
  /** Numbered chip on non-cover slides; null = no chip. */
  pageChip?: { anchor: 'top-right' | 'bottom-right' | 'bottom-left' | 'top-left'; style: 'circle' | 'square' } | null;
  /** How content-slide headers are treated: accent bar at the left, or a rule under the title. */
  titleTreatment: 'bar' | 'underline';
};

export type BuiltinTypography = {
  /** Multiplier on display/title font sizes (1 = catalog sizes). */
  titleScale: number;
  headingTransform?: 'none' | 'uppercase';
};

export type BuiltinTemplate = {
  id: string;
  name: string;
  /** One-line vibe shown on the panel card. */
  description: string;
  /** Warna & Font skin (slides/templates.ts id) this design is built on. */
  skinId: string;
  /** Full deck theme tokens: the skin's tokens, adjusted per design language. */
  theme: DeckTheme;
  /** Preferred layout ids per slide kind; outline picks are re-mapped through these pools. */
  design: Record<BuiltinSlideKind, string[]>;
  furniture: FurnitureSpec;
  typography: BuiltinTypography;
};

export const BUILTIN_KINDS: readonly BuiltinSlideKind[] = ['cover', 'toc', 'section', 'content', 'visual', 'chart', 'closing'];

/** Image-bearing layouts whose picture slot the AI never fills (PR #50 click-to-upload placeholders). */
export const IMAGE_LAYOUT_IDS: readonly string[] = ['image-side', 'split-visual-quote', 'hero-image-caption', 'mosaic'];

/** The slide kind a catalog layout belongs to (the kind an outline pick expresses). */
export function builtinKindOfLayout(layoutId: string): BuiltinSlideKind {
  switch (layoutId) {
    case 'title': return 'cover';
    case 'agenda-toc': return 'toc';
    case 'section': return 'section';
    case 'closing':
    case 'banner-cta': return 'closing';
    default: break;
  }
  const def = getLayout(layoutId);
  if (!def || layoutId === 'template-page') return 'content';
  if (def.category === 'data') return 'chart';
  if (def.category === 'visual') return 'visual';
  if (def.category === 'closing') return 'closing';
  if (def.category === 'opener') return 'section';
  return 'content';
}

function themeOf(skinId: string, adjust: Partial<DeckTheme> = {}): DeckTheme {
  const skin = getSlideTemplate(skinId);
  return { ...(skin ? skin.theme : {}), ...adjust };
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'standar',
    name: 'Daedalus Standar',
    description: 'Bahasa desain bawaan Daedalus: bersih dan netral, seluruh katalog layout bebas dipakai.',
    skinId: 'general',
    theme: themeOf('general'),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['bullets', 'two-column', 'numbered-steps', 'quote', 'testimonial', 'profile-cards', 'glossary', 'faq', 'feature-highlight', 'callout', 'quote-wall', 'code-focus'],
      visual: ['image-side', 'diagram-flow', 'chevron-process', 'steps-cards', 'timeline', 'roadmap', 'funnel', 'gantt-bars', 'org-chart', 'icon-grid', 'mosaic', 'hero-image-caption', 'comparison', 'versus', 'matrix-quadrant', 'diagram-cycle', 'diagram-hierarchy', 'diagram-pyramid', 'logo-wall', 'year-markers', 'waterfall-steps', 'split-visual-quote', 'pros-cons'],
      chart: ['chart-bar', 'chart-line', 'chart-donut', 'table', 'stats', 'big-stat', 'kpi-band', 'stat-duel', 'ranking-list', 'pricing-tiers'],
      closing: ['closing', 'banner-cta'],
    },
    furniture: { elements: [], pageChip: null, titleTreatment: 'bar' },
    typography: { titleScale: 1 },
  },
  {
    id: 'editorial',
    name: 'Editorial Klasik',
    description: 'Majalah cetak terang: serif besar, garis rambut, folio rapi — laporan, esai, dan kajian.',
    skinId: 'documentary',
    theme: themeOf('documentary', { headingFont: 'Georgia' }),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['feature-highlight', 'two-column', 'bullets', 'glossary', 'faq', 'quote'],
      visual: ['steps-cards', 'timeline', 'image-side', 'diagram-flow', 'chevron-process', 'year-markers'],
      chart: ['chart-bar', 'table', 'big-stat', 'stats'],
      closing: ['closing', 'banner-cta'],
    },
    furniture: {
      elements: [
        { shape: 'line', anchor: 'top-edge', dx: 0.028, dy: 0.018, w: 0.944, color: 'muted', opacity: 0.55 },
        { shape: 'line', anchor: 'bottom-edge', dx: 0.028, dy: 0.018, w: 0.944, color: 'muted', opacity: 0.55 },
        { shape: 'rect', anchor: 'bottom-edge', dy: 0, h: 0.012, color: 'accent', kinds: ['cover', 'closing'] },
        { shape: 'rect', anchor: 'bottom-left', dx: 0.028, dy: 0.032, w: 0.16, h: 0.014, color: 'accent', kinds: ['cover'] },
      ],
      pageChip: { anchor: 'bottom-right', style: 'square' },
      titleTreatment: 'underline',
    },
    typography: { titleScale: 1.05 },
  },
  {
    id: 'arena',
    name: 'Arena Neon',
    description: 'Teknologi & produk: rel samping menyala, blob sudut, chip nomor bulat — berani dan cepat.',
    skinId: 'ocean',
    theme: themeOf('ocean'),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['feature-highlight', 'bullets', 'callout', 'faq', 'two-column', 'profile-cards'],
      visual: ['icon-grid', 'steps-cards', 'chevron-process', 'funnel', 'roadmap', 'diagram-cycle', 'hero-image-caption', 'image-side', 'mosaic', 'gantt-bars'],
      chart: ['kpi-band', 'chart-line', 'stat-duel', 'ranking-list', 'chart-bar', 'chart-donut'],
      closing: ['banner-cta', 'closing'],
    },
    furniture: {
      elements: [
        { shape: 'rect', anchor: 'left-edge', w: 0.007, color: 'accent' },
        { shape: 'ellipse', anchor: 'top-right', dx: -0.05, dy: -0.14, w: 0.26, h: 0.36, color: 'accent', opacity: 0.18 },
        { shape: 'ellipse', anchor: 'bottom-left', dx: -0.07, dy: -0.1, w: 0.22, h: 0.3, color: 'surface', opacity: 0.55 },
        { shape: 'roundRect', anchor: 'top-left', dx: 0.025, dy: 0.03, w: 0.055, h: 0.016, color: 'accent', kinds: ['cover', 'closing'] },
      ],
      pageChip: { anchor: 'bottom-right', style: 'circle' },
      titleTreatment: 'bar',
    },
    typography: { titleScale: 1.1 },
  },
  {
    id: 'cendekia',
    name: 'Naskah Cendekia',
    description: 'Akademik khidmat: hijau-emas serif, ornamen garis ganda — sidang, seminar, dan kajian ilmiah.',
    skinId: 'midnight-scholar',
    theme: themeOf('midnight-scholar'),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['glossary', 'bullets', 'two-column', 'quote', 'feature-highlight', 'profile-cards'],
      visual: ['diagram-hierarchy', 'timeline', 'year-markers', 'org-chart', 'image-side', 'steps-cards'],
      chart: ['table', 'chart-bar', 'stats', 'big-stat'],
      closing: ['closing', 'banner-cta'],
    },
    furniture: {
      elements: [
        { shape: 'line', anchor: 'top-edge', dx: 0.035, dy: 0.014, w: 0.93, color: 'accent' },
        { shape: 'line', anchor: 'top-edge', dx: 0.035, dy: 0.027, w: 0.93, color: 'muted', opacity: 0.7 },
        { shape: 'line', anchor: 'bottom-edge', dx: 0.035, dy: 0.014, w: 0.93, color: 'accent' },
        { shape: 'line', anchor: 'bottom-edge', dx: 0.035, dy: 0.027, w: 0.93, color: 'muted', opacity: 0.7 },
        { shape: 'ellipse', anchor: 'bottom-center', dy: 0.042, w: 0.012, h: 0.021, color: 'accent' },
      ],
      pageChip: { anchor: 'bottom-left', style: 'square' },
      titleTreatment: 'underline',
    },
    typography: { titleScale: 1 },
  },
  {
    id: 'galeri',
    name: 'Galeri Mono',
    description: 'Pameran premium hitam-emas: bingkai tipis, ruang kosong lapang, serif dramatis.',
    skinId: 'mono-luxe',
    theme: themeOf('mono-luxe'),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['quote', 'two-column', 'profile-cards', 'feature-highlight', 'glossary', 'quote-wall'],
      visual: ['split-visual-quote', 'mosaic', 'hero-image-caption', 'image-side', 'steps-cards'],
      chart: ['big-stat', 'stat-duel', 'stats', 'table'],
      closing: ['closing', 'banner-cta'],
    },
    furniture: {
      elements: [
        { shape: 'line', anchor: 'top-edge', dx: 0.03, dy: 0.05, w: 0.94, color: 'muted', opacity: 0.8 },
        { shape: 'line', anchor: 'bottom-edge', dx: 0.03, dy: 0.05, w: 0.94, color: 'muted', opacity: 0.8 },
        { shape: 'rect', anchor: 'left-edge', dx: 0.03, dy: 0.05, w: 0.0018, h: 0.9, color: 'muted', opacity: 0.8 },
        { shape: 'rect', anchor: 'right-edge', dx: 0.03, dy: 0.05, w: 0.0018, h: 0.9, color: 'muted', opacity: 0.8 },
        { shape: 'rect', anchor: 'top-left', dx: 0.024, dy: 0.042, w: 0.012, h: 0.021, color: 'accent' },
        { shape: 'rect', anchor: 'top-right', dx: 0.024, dy: 0.042, w: 0.012, h: 0.021, color: 'accent' },
        { shape: 'rect', anchor: 'bottom-left', dx: 0.024, dy: 0.042, w: 0.012, h: 0.021, color: 'accent' },
        { shape: 'rect', anchor: 'bottom-right', dx: 0.024, dy: 0.042, w: 0.012, h: 0.021, color: 'accent' },
      ],
      pageChip: { anchor: 'bottom-right', style: 'square' },
      titleTreatment: 'underline',
    },
    typography: { titleScale: 1.15 },
  },
  {
    id: 'verve',
    name: 'Verve Pop',
    description: 'Energik & playful di atas kulit General: blob bulat, tanda plus, chip chunky — komunitas dan kelas.',
    skinId: 'general',
    theme: themeOf('general', { accent: '#f5ef34', headingFont: 'Verdana' }),
    design: {
      cover: ['title'],
      toc: ['agenda-toc'],
      section: ['section'],
      content: ['feature-highlight', 'callout', 'bullets', 'faq', 'testimonial', 'profile-cards'],
      visual: ['icon-grid', 'steps-cards', 'waterfall-steps', 'funnel', 'diagram-cycle', 'image-side', 'mosaic'],
      chart: ['chart-donut', 'kpi-band', 'ranking-list', 'chart-bar'],
      closing: ['banner-cta', 'closing'],
    },
    furniture: {
      elements: [
        { shape: 'ellipse', anchor: 'top-right', dx: -0.04, dy: -0.12, w: 0.2, h: 0.28, color: 'accent', opacity: 0.9 },
        { shape: 'ellipse', anchor: 'bottom-left', dx: -0.05, dy: -0.08, w: 0.16, h: 0.22, color: 'surface', opacity: 0.85 },
        { shape: 'rect', anchor: 'bottom-right', dx: 0.055, dy: 0.075, w: 0.011, h: 0.055, color: 'accent', kinds: ['content', 'visual', 'chart'] },
        { shape: 'rect', anchor: 'bottom-right', dx: 0.045, dy: 0.092, w: 0.031, h: 0.02, color: 'accent', kinds: ['content', 'visual', 'chart'] },
        { shape: 'roundRect', anchor: 'top-left', dx: 0.02, dy: 0.03, w: 0.035, h: 0.016, color: 'accent', kinds: ['cover', 'closing'] },
      ],
      pageChip: { anchor: 'top-right', style: 'circle' },
      titleTreatment: 'bar',
    },
    typography: { titleScale: 1.05 },
  },
];

export const DEFAULT_BUILTIN_TEMPLATE_ID = 'standar';

export function getBuiltinTemplate(id: string | undefined | null): BuiltinTemplate | undefined {
  if (!id) return undefined;
  return BUILTIN_TEMPLATES.find((template) => template.id === id);
}

export function listBuiltinTemplates(): BuiltinTemplate[] {
  return BUILTIN_TEMPLATES;
}

/** The deck theme a built-in template stamps: its tokens + provenance fields. */
export function builtinDeckTheme(template: BuiltinTemplate): DeckTheme {
  return { ...template.theme, templateId: template.skinId, designId: template.id };
}

/** The template a deck renders with, from its theme (undefined = legacy no-design deck). */
export function builtinTemplateForTheme(theme: DeckTheme | undefined): BuiltinTemplate | undefined {
  return getBuiltinTemplate(theme?.designId);
}

/**
 * The slide-fraction rect (x/y of slide width/height) a furniture
 * element paints — one geometry shared by the canvas renderer and the
 * PPTX exporter.
 */
export function furnitureRect(el: FurnitureElement): { x: number; y: number; w: number; h: number } {
  const w = el.w ?? (el.shape === 'line' ? 1 : 0.1);
  const h = el.h ?? (el.shape === 'line' ? 0.004 : 0.1);
  const dx = el.dx ?? 0;
  const dy = el.dy ?? 0;
  switch (el.anchor) {
    case 'top-left': return { x: dx, y: dy, w, h };
    case 'top-right': return { x: 1 - dx - w, y: dy, w, h };
    case 'bottom-left': return { x: dx, y: 1 - dy - h, w, h };
    case 'bottom-right': return { x: 1 - dx - w, y: 1 - dy - h, w, h };
    case 'top-center': return { x: 0.5 - w / 2 + dx, y: dy, w, h };
    case 'bottom-center': return { x: 0.5 - w / 2 + dx, y: 1 - dy - h, w, h };
    case 'top-edge': return { x: dx, y: dy, w, h };
    case 'bottom-edge': return { x: dx, y: 1 - dy - h, w, h };
    case 'left-edge': return { x: dx, y: dy, w, h };
    case 'right-edge': return { x: 1 - dx - w, y: dy, w, h };
  }
}

/** The slide-fraction rect of the numbered page chip (canvas + exporter share it). */
export function pageChipRect(chip: NonNullable<FurnitureSpec['pageChip']>): { x: number; y: number; w: number; h: number } {
  const w = 0.036;
  const h = 0.064;
  const insetX = 0.018;
  const insetY = 0.03;
  switch (chip.anchor) {
    case 'top-right': return { x: 1 - insetX - w, y: insetY, w, h };
    case 'top-left': return { x: insetX, y: insetY, w, h };
    case 'bottom-right': return { x: 1 - insetX - w, y: 1 - insetY - h, w, h };
    case 'bottom-left': return { x: insetX, y: 1 - insetY - h, w, h };
  }
}

/**
 * Re-map an outline onto a built-in template's design, deterministically
 * (the same least-used discipline as imported-template page assignment):
 * a model pick the template speaks is kept; anything else rotates
 * through the template's pool for that slide kind, least-used first —
 * and no layout ever lands three slides in a row when the pool offers
 * an alternative (deck rhythm inside one design language).
 */
export function assignBuiltinLayouts<T extends { layoutId: string }>(items: readonly T[], template: BuiltinTemplate): string[] {
  const used = new Map<string, number>();
  const chosen: string[] = [];
  const leastUsed = (pool: string[], exclude?: string): string => {
    let best: string | undefined;
    for (const id of pool) {
      if (id === exclude) continue;
      if (best === undefined || (used.get(id) ?? 0) < (used.get(best) ?? 0)) best = id;
    }
    return best ?? pool[0]!;
  };
  return items.map((item) => {
    const kind = builtinKindOfLayout(item.layoutId);
    const pool = template.design[kind].length > 0 ? template.design[kind] : template.design.content;
    let pick = pool.includes(item.layoutId) ? item.layoutId : leastUsed(pool);
    // Rhythm: a third identical slide in a row breaks to the
    // least-used alternative of the same kind.
    if (chosen.length >= 2 && chosen[chosen.length - 1] === pick && chosen[chosen.length - 2] === pick && pool.length > 1) {
      pick = leastUsed(pool, pick);
    }
    used.set(pick, (used.get(pick) ?? 0) + 1);
    chosen.push(pick);
    return pick;
  });
}

/**
 * Empty the picture slots of a freshly generated slide: the model never
 * supplies images in Slide — a generated image filename would be a
 * fabrication that fails asset validation, while '' is exactly the
 * click-to-upload placeholder the canvas renders and the exporter
 * labels honestly. User-picked assets (editor uploads) are never routed
 * through here; this runs only on model output at generation time.
 */
export function emptyImageFields(layoutId: string, content: Record<string, unknown>): Record<string, unknown> {
  if (!IMAGE_LAYOUT_IDS.includes(layoutId)) return content;
  const next: Record<string, unknown> = { ...content };
  if ('image' in next) next.image = '';
  if (layoutId === 'mosaic' && Array.isArray(next.tiles)) {
    next.tiles = (next.tiles as unknown[]).map((tile) =>
      typeof tile === 'object' && tile !== null && !Array.isArray(tile) ? { ...(tile as Record<string, unknown>), image: '' } : tile,
    );
  }
  return next;
}
