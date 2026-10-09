import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import PptxGenJSModule from 'pptxgenjs';

// pptxgenjs 4.0.1 ships types whose default export is not constructable
// under NodeNext without esModuleInterop, so we bind the class through a
// minimal local interface describing exactly the API surface used here
// (addSlide/addText/addShape/addImage/addChart/addTable/addNotes/write,
// verified against node_modules/pptxgenjs/types/index.d.ts v4.0.1).
type PptxTextOptions = Record<string, unknown>;
type PptxTableCell = { text?: string; options?: Record<string, unknown> };
type PptxTableRow = PptxTableCell[];
interface PptxSlide {
  background: { color?: string; path?: string };
  color: string;
  addText: (text: string | Array<{ text: string; options?: Record<string, unknown> }>, options?: PptxTextOptions) => unknown;
  addShape: (shapeName: string, options?: Record<string, unknown>) => unknown;
  addImage: (options: Record<string, unknown>) => unknown;
  addChart: (type: string, data: unknown[], options?: Record<string, unknown>) => unknown;
  addTable: (rows: PptxTableRow[], options?: Record<string, unknown>) => unknown;
  addNotes: (notes: string) => unknown;
}
interface PptxInstance {
  defineLayout: (layout: { name: string; width: number; height: number }) => void;
  layout: string;
  title: string;
  theme: { headFontFace?: string; bodyFontFace?: string };
  addSlide: () => PptxSlide;
  write: (props?: { outputType?: string }) => Promise<string | ArrayBuffer | Uint8Array>;
}
type PptxCtor = new () => PptxInstance;
const PptxGenJS = ((PptxGenJSModule as unknown as { default?: unknown }).default ?? PptxGenJSModule) as unknown as PptxCtor;
import { deckPaths, slugifyTitle, type DeckSpec, type Slide } from './deck.ts';
import { pptxTemplatesDir, readPptxTemplateSync } from './pptx-template.ts';

const W = 13.333;
const H = 7.5;
const SERIES_COLORS = ['68FFD6', '00A4FF', 'FF985A', 'FF60FF', '00FFB2', 'F5EF34'];

type Ctx = {
  bg: string; fg: string; sub: string; surface: string; accent: string; dark: boolean; colors: string[];
};

function hex(v: string | undefined, fallback: string): string {
  const raw = (v ?? fallback).replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback.replace(/^#/, '').toUpperCase();
}
function str(v: unknown): string { return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v); }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function rec(v: unknown): Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
function strings(v: unknown): string[] { return arr(v).map((x) => str(x)).filter((x) => x.length > 0); }
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
}

function text(slide: PptxSlide, txt: string, o: PptxTextOptions, ctx: Ctx): void {
  slide.addText(txt, { fontFace: 'Arial', color: ctx.fg, ...o });
}

function bullets(slide: PptxSlide, points: string[], o: PptxTextOptions, ctx: Ctx): void {
  if (points.length === 0) return;
  slide.addText(
    points.map((p, i) => ({ text: p, options: { bullet: true, breakLine: i < points.length - 1, fontSize: 16, color: ctx.fg } })),
    { fontFace: 'Arial', color: ctx.fg, valign: 'top', ...o },
  );
}

export function addTitleBar(slide: PptxSlide, title: string, ctx?: Ctx): void {
  const c: Ctx = ctx ?? { bg: '201F26', fg: 'ECEBF0', sub: 'BFBCC8', surface: '2D2C36', accent: '6B50FF', dark: true, colors: SERIES_COLORS };
  slide.addShape('rect', { x: 0.55, y: 0.42, w: 0.09, h: 0.62, fill: { color: c.accent }, line: { type: 'none' } });
  text(slide, title, { x: 0.8, y: 0.35, w: 11.9, h: 0.75, fontSize: 28, bold: true, valign: 'middle' }, c);
}

function boxText(slide: PptxSlide, txt: string, o: PptxTextOptions, ctx: Ctx, fill?: string): void {
  slide.addText(txt, {
    fontFace: 'Arial', color: ctx.fg, shape: 'roundRect', fill: { color: fill ?? ctx.surface }, line: { color: ctx.accent, width: 1 },
    align: 'center', valign: 'middle', ...o,
  });
}

function panel(slide: PptxSlide, heading: string, points: string[], r: Rect, ctx: Ctx): void {
  slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
  text(slide, heading, { x: r.x + 0.35, y: r.y + 0.2, w: r.w - 0.7, h: 0.5, fontSize: 20, bold: true, color: ctx.accent }, ctx);
  bullets(slide, points, { x: r.x + 0.35, y: r.y + 0.8, w: r.w - 0.7, h: Math.max(0.4, r.h - 1.05) }, ctx);
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * The rect a named block is drawn into (inches): the slide's drag
 * placement for that block (slide fractions × 13.333x7.5) when one is
 * stored, else the layout's default rect. The Web canvas resolves the
 * same fractions, so a dragged card lands in the same place in the
 * exported file as on screen.
 */
function rectFor(slideSpec: Slide, key: string, d: Rect): Rect {
  const p = slideSpec.positions?.[key];
  if (!p) return d;
  return { x: p.x * W, y: p.y * H, w: p.w !== undefined ? p.w * W : d.w, h: p.h !== undefined ? p.h * H : d.h };
}

function hasPos(slideSpec: Slide, key: string): boolean {
  return slideSpec.positions?.[key] !== undefined;
}

/** The slide title: a dragged title becomes a placed text box; an unplaced one keeps the title bar. */
function titleBlock(slide: PptxSlide, slideSpec: Slide, title: string, ctx: Ctx): void {
  if (hasPos(slideSpec, 'title')) {
    const r = rectFor(slideSpec, 'title', { x: 0.8, y: 0.35, w: 11.9, h: 0.75 });
    text(slide, title, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 28, bold: true, valign: 'middle' }, ctx);
    return;
  }
  addTitleBar(slide, title, ctx);
}

/**
 * Embeds a deck asset (deck/assets/<name>) into rect r when the file truly
 * exists on disk; otherwise draws the same labelled placeholder box the Web
 * canvas shows, so an export never pretends an image is there when it is
 * not. Used by every image-bearing layout (image-side/mosaic inline the
 * same lookup for their legacy rects).
 */
function placeImage(slide: PptxSlide, root: string, name: string, alt: string, r: Rect, ctx: Ctx, fontSize = 13): void {
  const imgPath = name ? join(deckPaths(root).assetsDir, basename(name)) : '';
  if (imgPath && existsSync(imgPath)) {
    slide.addImage({ path: imgPath, x: r.x, y: r.y, w: r.w, h: r.h, altText: alt || name });
  } else {
    boxText(slide, name ? `Image: ${name}` : 'Image', { x: r.x, y: r.y, w: r.w, h: r.h, fontSize, color: ctx.sub }, ctx);
  }
}

/** A check/cross list as prefixed lines (pptxgenjs bullets have no per-line glyph override). */
function glyphLines(slide: PptxSlide, points: string[], glyph: string, o: PptxTextOptions, ctx: Ctx, fontSize = 14): void {
  if (points.length === 0) return;
  slide.addText(
    points.map((p, i) => ({ text: `${glyph} ${p}`, options: { breakLine: i < points.length - 1, fontSize, color: ctx.fg } })),
    { fontFace: 'Arial', color: ctx.fg, valign: 'top', ...o },
  );
}

/**
 * A template-page slide exports its template design: the page's
 * background (stored image or color, falling back to the deck theme),
 * native editable text boxes at the slot rects with the slot's own size/
 * font/color, and each image slot's chosen deck asset — or the
 * template's original picture, or a labelled placeholder when neither
 * exists (never a silent pretence). When the template or page cannot be
 * resolved, the slide degrades honestly to the theme background plus its
 * slot texts as plain lines.
 */
function renderTemplateSlide(slide: PptxSlide, slideSpec: Slide, deck: DeckSpec, root: string, ctx: Ctx): void {
  const ref = slideSpec.templateRef!;
  const template = readPptxTemplateSync(root, ref.templateId);
  const page = template?.pages?.[ref.page];
  const slots = rec(slideSpec.content.slots);
  const themeBackground = (): void => {
    const bgImagePath = deck.theme.backgroundImage ? join(deckPaths(root).assetsDir, basename(deck.theme.backgroundImage)) : '';
    slide.background = bgImagePath && existsSync(bgImagePath) ? { path: bgImagePath } : { color: ctx.bg };
  };
  if (!page) {
    themeBackground();
    const title = str(slideSpec.content.title);
    const lines = [...new Set([title, ...Object.values(slots).filter((v): v is string => typeof v === 'string' && v.length > 0)])].filter((line) => line.length > 0);
    lines.forEach((line, i) => {
      text(slide, line, { x: 0.8, y: 0.8 + i * 0.95, w: 11.7, h: 0.85, fontSize: i === 0 ? 30 : 16, bold: i === 0, valign: 'middle' }, ctx);
    });
    return;
  }
  const pageBgImage = page.background?.imageFile ? join(pptxTemplatesDir(root), page.background.imageFile) : '';
  if (pageBgImage && existsSync(pageBgImage)) slide.background = { path: pageBgImage };
  else if (page.background?.color) slide.background = { color: hex(page.background.color, ctx.bg) };
  else themeBackground();

  for (const slot of page.slots) {
    const r: Rect = { x: slot.rect.x * W, y: slot.rect.y * H, w: slot.rect.w * W, h: slot.rect.h * H };
    if (slot.kind === 'text') {
      const value = typeof slots[slot.key] === 'string' ? (slots[slot.key] as string) : '';
      if (!value) continue;
      const fontFace = slot.fontFamily ?? (slot.fontSizePt >= 24 ? deck.theme.headingFont : deck.theme.bodyFont);
      text(slide, value, {
        x: r.x, y: r.y, w: r.w, h: r.h,
        fontSize: slot.fontSizePt,
        ...(fontFace ? { fontFace } : {}),
        ...(slot.color ? { color: hex(slot.color, ctx.fg) } : {}),
        bold: slot.bold,
        align: slot.align ?? 'left',
        valign: 'top', wrap: true, margin: 0, lineSpacingMultiple: 1.15,
      }, ctx);
      continue;
    }
    const chosen = typeof slots[slot.key] === 'string' ? (slots[slot.key] as string) : '';
    if (chosen) {
      // The user's picked deck asset; placeImage draws the labelled
      // placeholder when the file is gone — never a false image.
      placeImage(slide, root, chosen, chosen, r, ctx);
    } else if (slot.imageFile) {
      const originalPath = join(pptxTemplatesDir(root), slot.imageFile);
      if (existsSync(originalPath)) {
        slide.addImage({ path: originalPath, x: r.x, y: r.y, w: r.w, h: r.h, altText: slot.imageFile });
      } else {
        boxText(slide, 'Image', { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 13, color: ctx.sub }, ctx);
      }
    } else {
      boxText(slide, 'Image', { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 13, color: ctx.sub }, ctx);
    }
  }
}

function renderSlide(pptx: PptxInstance, slideSpec: Slide, deck: DeckSpec, root: string, ctx: Ctx): void {
  const slide = pptx.addSlide();
  if (slideSpec.templateRef) {
    slide.color = ctx.fg;
    renderTemplateSlide(slide, slideSpec, deck, root, ctx);
    if (slideSpec.notes) slide.addNotes(slideSpec.notes);
    return;
  }
  // An imported template's background image (deck/assets/, copied in when
  // the template was applied) paints behind everything, exactly like the
  // canvas; the theme background color stays the honest fallback when the
  // file is gone.
  const bgImagePath = deck.theme.backgroundImage ? join(deckPaths(root).assetsDir, basename(deck.theme.backgroundImage)) : '';
  slide.background = bgImagePath && existsSync(bgImagePath) ? { path: bgImagePath } : { color: ctx.bg };
  slide.color = ctx.fg;
  const c = slideSpec.content;
  const title = str(c.title);

  switch (slideSpec.layout) {
    case 'title': {
      const tr = rectFor(slideSpec, 'title', { x: 0.8, y: 2.2, w: 11.7, h: 1.6 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 44, bold: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.subtitle)) {
        const sr = rectFor(slideSpec, 'subtitle', { x: 1.3, y: 3.95, w: 10.7, h: 0.9 });
        text(slide, str(c.subtitle), { x: sr.x, y: sr.y, w: sr.w, h: sr.h, fontSize: 22, align: 'center', color: ctx.sub }, ctx);
      }
      if (!hasPos(slideSpec, 'title')) slide.addShape('rect', { x: 5.9, y: 5.05, w: 1.5, h: 0.08, fill: { color: ctx.accent }, line: { type: 'none' } });
      break;
    }
    case 'section': {
      const numLabel = c.number !== undefined && c.number !== '' ? str(c.number) : '';
      if (numLabel) {
        const nr = rectFor(slideSpec, 'number', { x: 0.7, y: 1.6, w: 2.2, h: 1.6 });
        text(slide, numLabel, { x: nr.x, y: nr.y, w: nr.w, h: nr.h, fontSize: 72, bold: true, color: ctx.accent }, ctx);
      }
      const titleX = numLabel && !hasPos(slideSpec, 'number') ? 3.0 : 0.8;
      const tr = rectFor(slideSpec, 'title', { x: titleX, y: 2.55, w: 9.5, h: 1.4 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 40, bold: true, valign: 'middle' }, ctx);
      break;
    }
    case 'bullets': {
      titleBlock(slide, slideSpec, title, ctx);
      const r = rectFor(slideSpec, 'points', { x: 0.85, y: 1.45, w: 11.6, h: 5.4 });
      bullets(slide, strings(c.points), { x: r.x, y: r.y, w: r.w, h: r.h }, ctx);
      break;
    }
    case 'two-column': {
      titleBlock(slide, slideSpec, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      panel(slide, str(left.heading), strings(left.points), rectFor(slideSpec, 'left', { x: 0.6, y: 1.55, w: 5.85, h: 4.9 }), ctx);
      panel(slide, str(right.heading), strings(right.points), rectFor(slideSpec, 'right', { x: 6.85, y: 1.55, w: 5.85, h: 4.9 }), ctx);
      break;
    }
    case 'image-side': {
      titleBlock(slide, slideSpec, title, ctx);
      const side = c.side === 'left' ? 'left' : 'right';
      const imgX = side === 'left' ? 0.6 : 7.1;
      const txtX = side === 'left' ? 7.1 : 0.6;
      const ir = rectFor(slideSpec, 'image', { x: imgX, y: 1.55, w: 5.6, h: 4.9 });
      const imageName = str(c.image);
      const imgPath = imageName ? join(deckPaths(root).assetsDir, basename(imageName)) : '';
      if (imgPath && existsSync(imgPath)) {
        slide.addImage({ path: imgPath, x: ir.x, y: ir.y, w: ir.w, h: ir.h, altText: str(c.alt) || imageName });
      } else {
        boxText(slide, imageName ? `Image: ${imageName}` : 'Image', { x: ir.x, y: ir.y, w: ir.w, h: ir.h, fontSize: 16, color: ctx.sub }, ctx);
      }
      const pr = rectFor(slideSpec, 'points', { x: txtX, y: 1.7, w: 5.6, h: 4.7 });
      bullets(slide, strings(c.points), { x: pr.x, y: pr.y, w: pr.w, h: pr.h }, ctx);
      break;
    }
    case 'diagram-flow': {
      titleBlock(slide, slideSpec, title, ctx);
      const steps = arr(c.steps).map(rec);
      const n = Math.max(1, steps.length);
      const gap = 0.28; const totalW = 12.1; const bw = (totalW - gap * (n - 1)) / n;
      steps.forEach((st, i) => {
        const x = 0.6 + i * (bw + gap);
        const key = `step-${i}`;
        if (hasPos(slideSpec, key)) {
          const r = rectFor(slideSpec, key, { x, y: 2.35, w: bw, h: 2.4 });
          boxText(slide, str(st.title), { x: r.x, y: r.y, w: r.w, h: r.h * 0.48, fontSize: 15, bold: true }, ctx);
          if (str(st.desc)) text(slide, str(st.desc), { x: r.x, y: r.y + r.h * 0.52, w: r.w, h: r.h * 0.44, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
          return;
        }
        boxText(slide, str(st.title), { x, y: 2.35, w: bw, h: 1.15, fontSize: 15, bold: true }, ctx);
        if (str(st.desc)) text(slide, str(st.desc), { x, y: 3.65, w: bw, h: 1.1, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
        if (i < steps.length - 1 && !hasPos(slideSpec, `step-${i + 1}`)) slide.addShape('chevron', { x: x + bw + 0.02, y: 2.78, w: 0.24, h: 0.3, fill: { color: ctx.accent }, line: { type: 'none' } });
      });
      break;
    }
    case 'diagram-cycle': {
      titleBlock(slide, slideSpec, title, ctx);
      const nodes = strings(c.nodes).slice(0, 4);
      const pos: Array<[number, number]> = [[5.15, 1.55], [8.6, 3.35], [5.15, 5.15], [1.7, 3.35]];
      nodes.forEach((node, i) => {
        const [x, y] = pos[i]!;
        const r = rectFor(slideSpec, `node-${i}`, { x, y, w: 3.0, h: 1.0 });
        boxText(slide, node, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 16, bold: true }, ctx);
      });
      slide.addShape('ellipse', { x: 5.85, y: 3.35, w: 1.6, h: 1.0, fill: { color: ctx.accent }, line: { type: 'none' } });
      break;
    }
    case 'diagram-hierarchy': {
      titleBlock(slide, slideSpec, title, ctx);
      const rr = rectFor(slideSpec, 'root', { x: 4.9, y: 1.4, w: 3.5, h: 0.95 });
      boxText(slide, str(c.root), { x: rr.x, y: rr.y, w: rr.w, h: rr.h, fontSize: 18, bold: true }, ctx, ctx.accent);
      const groups = arr(c.groups).map(rec);
      const n = Math.max(1, groups.length);
      const bw = Math.min(3.6, (12.1 - 0.3 * (n - 1)) / n);
      const total = bw * n + 0.3 * (n - 1);
      const startX = (W - total) / 2;
      groups.forEach((g, i) => {
        const x = startX + i * (bw + 0.3);
        const key = `group-${i}`;
        const r = rectFor(slideSpec, key, { x, y: 3.2, w: bw, h: 3.4 });
        if (!hasPos(slideSpec, key) && !hasPos(slideSpec, 'root')) {
          slide.addShape('line', { x: x + bw / 2, y: 2.35, w: 0, h: 0.85, line: { color: ctx.accent, width: 2 } });
        }
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(g.label), { x: r.x + 0.25, y: r.y + 0.2, w: r.w - 0.5, h: 0.5, fontSize: 16, bold: true, align: 'center', color: ctx.accent }, ctx);
        bullets(slide, strings(g.items), { x: r.x + 0.25, y: r.y + 0.75, w: r.w - 0.5, h: Math.max(0.4, r.h - 0.95) }, ctx);
      });
      break;
    }
    case 'timeline': {
      titleBlock(slide, slideSpec, title, ctx);
      const events = arr(c.events).map(rec);
      const anyPlaced = events.some((_, i) => hasPos(slideSpec, `event-${i}`));
      if (!anyPlaced) slide.addShape('line', { x: 0.7, y: 3.85, w: 11.9, h: 0, line: { color: ctx.accent, width: 3 } });
      const n = Math.max(1, events.length);
      events.forEach((ev, i) => {
        const x = 0.8 + (i * 11.7) / n;
        const bw = 11.7 / n - 0.2;
        const above = i % 2 === 0;
        const key = `event-${i}`;
        const ty = above ? 1.65 : 4.25;
        if (hasPos(slideSpec, key)) {
          const r = rectFor(slideSpec, key, { x, y: ty, w: bw, h: 1.65 });
          slide.addShape('ellipse', { x: r.x, y: r.y, w: 0.18, h: 0.18, fill: { color: ctx.accent }, line: { type: 'none' } });
          text(slide, `${str(ev.when)} — ${str(ev.title)}`, { x: r.x, y: r.y + 0.26, w: r.w, h: 0.6, fontSize: 13, bold: true, color: ctx.accent }, ctx);
          if (str(ev.desc)) text(slide, str(ev.desc), { x: r.x, y: r.y + 0.86, w: r.w, h: Math.max(0.3, r.h - 0.86), fontSize: 11, color: ctx.sub }, ctx);
          return;
        }
        slide.addShape('ellipse', { x: x + bw / 2 - 0.11, y: 3.74, w: 0.22, h: 0.22, fill: { color: ctx.accent }, line: { type: 'none' } });
        text(slide, `${str(ev.when)} — ${str(ev.title)}`, { x, y: ty, w: bw, h: 0.75, fontSize: 13, bold: true, align: 'center', color: ctx.accent }, ctx);
        if (str(ev.desc)) text(slide, str(ev.desc), { x, y: ty + 0.75, w: bw, h: 0.9, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'comparison': {
      titleBlock(slide, slideSpec, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      panel(slide, str(left.title), strings(left.points), rectFor(slideSpec, 'left', { x: 0.6, y: 1.55, w: 5.85, h: 4.9 }), ctx);
      panel(slide, str(right.title), strings(right.points), rectFor(slideSpec, 'right', { x: 6.85, y: 1.55, w: 5.85, h: 4.9 }), ctx);
      if (str(c.verdict)) {
        const r = rectFor(slideSpec, 'verdict', { x: 0.6, y: 6.55, w: 12.1, h: 0.6 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.accent }, line: { type: 'none' } });
        text(slide, str(c.verdict), { x: r.x + 0.25, y: r.y + 0.08, w: r.w - 0.5, h: Math.max(0.2, r.h - 0.15), fontSize: 14, bold: true, align: 'center', color: '201F26' }, ctx);
      }
      break;
    }
    case 'chart-bar': {
      titleBlock(slide, slideSpec, title, ctx);
      const data = arr(c.data).map(rec);
      const r = rectFor(slideSpec, 'chart', { x: 0.7, y: 1.45, w: 11.9, h: 5.4 });
      slide.addChart('bar', [{ name: str(c.unit) || title, labels: data.map((d) => str(d.label)), values: data.map((d) => num(d.value)) }], {
        x: r.x, y: r.y, w: r.w, h: r.h, barDir: 'col', chartColors: ctx.colors, showLegend: false, showTitle: false,
        catAxisLabelColor: ctx.fg, valAxisLabelColor: ctx.sub, catAxisLineColor: ctx.sub, valAxisLineColor: ctx.sub,
      });
      break;
    }
    case 'chart-line': {
      titleBlock(slide, slideSpec, title, ctx);
      const series = arr(c.series).map(rec);
      const maxLen = Math.max(0, ...series.map((s) => arr(s.points).length));
      const labels = Array.from({ length: maxLen }, (_, i) => `${i + 1}`);
      const r = rectFor(slideSpec, 'chart', { x: 0.7, y: 1.45, w: 11.9, h: 5.4 });
      slide.addChart('line', series.map((s) => ({ name: str(s.name), labels, values: arr(s.points).map(num) })), {
        x: r.x, y: r.y, w: r.w, h: r.h, chartColors: ctx.colors, showLegend: true, legendPos: 'b', showTitle: false,
        catAxisLabelColor: ctx.fg, valAxisLabelColor: ctx.sub, catAxisLineColor: ctx.sub, valAxisLineColor: ctx.sub, lineSize: 3,
      });
      break;
    }
    case 'chart-donut': {
      titleBlock(slide, slideSpec, title, ctx);
      const slices = arr(c.slices).map(rec);
      const r = rectFor(slideSpec, 'chart', { x: 0.7, y: 1.45, w: 11.9, h: 5.4 });
      slide.addChart('doughnut', [{ name: str(c.unit) || title, labels: slices.map((s) => str(s.label)), values: slices.map((s) => num(s.value)) }], {
        x: r.x, y: r.y, w: r.w, h: r.h, chartColors: ctx.colors, showLegend: true, legendPos: 'r', showTitle: false, holeSize: 55,
      });
      break;
    }
    case 'table': {
      titleBlock(slide, slideSpec, title, ctx);
      const cols = strings(c.columns);
      const rowsRaw = arr(c.rows).map((r) => arr(r).map((x) => str(x)));
      const header: PptxTableRow = cols.map((col) => ({ text: col, options: { bold: true, color: 'FFFFFF', fill: { color: ctx.accent } } }));
      const body: PptxTableRow[] = rowsRaw.map((r) => cols.map((_, i) => ({ text: r[i] ?? '', options: { color: ctx.fg, fill: { color: ctx.surface } } })));
      const r = rectFor(slideSpec, 'table', { x: 0.7, y: 1.55, w: 11.9, h: 5.2 });
      slide.addTable([header, ...body], { x: r.x, y: r.y, w: r.w, border: { type: 'solid', color: ctx.sub, pt: 0.75 }, fontFace: 'Arial', fontSize: 14 });
      break;
    }
    case 'stats': {
      titleBlock(slide, slideSpec, title, ctx);
      const stats = arr(c.stats).map(rec);
      const n = Math.max(1, stats.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      stats.forEach((st, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `stat-${i}`, { x, y: 2.25, w: bw, h: 2.9 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(st.value), { x: r.x + 0.2, y: r.y + 0.35, w: r.w - 0.4, h: 1.0, fontSize: 36, bold: true, align: 'center', color: ctx.accent }, ctx);
        text(slide, str(st.label), { x: r.x + 0.2, y: r.y + 1.5, w: r.w - 0.4, h: 0.8, fontSize: 15, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'quote': {
      const tr = rectFor(slideSpec, 'text', { x: 1.1, y: 2.0, w: 11.1, h: 2.8 });
      text(slide, `“${str(c.text)}”`, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 32, italic: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.author)) {
        const ar = rectFor(slideSpec, 'author', { x: 1.1, y: 5.0, w: 11.1, h: 0.6 });
        text(slide, `— ${str(c.author)}`, { x: ar.x, y: ar.y, w: ar.w, h: ar.h, fontSize: 18, align: 'center', color: ctx.accent }, ctx);
      }
      break;
    }
    case 'icon-grid': {
      titleBlock(slide, slideSpec, title, ctx);
      const items = arr(c.items).map(rec);
      const cols = Math.min(3, Math.max(1, items.length));
      items.forEach((it, i) => {
        const col = i % cols; const row = Math.floor(i / cols);
        const x = 0.6 + col * 4.15; const y = 1.6 + row * 2.65;
        const r = rectFor(slideSpec, `item-${i}`, { x, y, w: 3.85, h: 2.35 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        // Icon name is rendered as text glyph placeholder (no raster icon).
        text(slide, `• ${str(it.icon)}`, { x: r.x + 0.3, y: r.y + 0.25, w: r.w - 0.6, h: 0.45, fontSize: 13, color: ctx.accent }, ctx);
        text(slide, str(it.title), { x: r.x + 0.3, y: r.y + 0.72, w: r.w - 0.6, h: 0.55, fontSize: 18, bold: true }, ctx);
        if (str(it.desc)) text(slide, str(it.desc), { x: r.x + 0.3, y: r.y + 1.3, w: r.w - 0.6, h: Math.max(0.3, r.h - 1.45), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'closing': {
      const tr = rectFor(slideSpec, 'title', { x: 0.8, y: 2.45, w: 11.7, h: 1.4 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 42, bold: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.cta)) {
        const cr = rectFor(slideSpec, 'cta', { x: 1.3, y: 4.1, w: 10.7, h: 0.8 });
        text(slide, str(c.cta), { x: cr.x, y: cr.y, w: cr.w, h: cr.h, fontSize: 20, align: 'center', color: ctx.accent }, ctx);
      }
      break;
    }
    case 'numbered-steps': {
      titleBlock(slide, slideSpec, title, ctx);
      const steps = arr(c.steps).map(rec);
      steps.forEach((st, i) => {
        const r = rectFor(slideSpec, `step-${i}`, { x: 0.7, y: 1.55 + i * 0.88, w: 11.9, h: 0.8 });
        text(slide, String(i + 1).padStart(2, '0'), { x: r.x, y: r.y, w: 1.05, h: 0.6, fontSize: 26, bold: true, color: ctx.accent }, ctx);
        text(slide, str(st.title), { x: r.x + 1.25, y: r.y + 0.02, w: r.w - 1.25, h: 0.42, fontSize: 19, bold: true }, ctx);
        if (str(st.desc)) text(slide, str(st.desc), { x: r.x + 1.25, y: r.y + 0.46, w: r.w - 1.25, h: Math.max(0.24, r.h - 0.46), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'code-focus': {
      titleBlock(slide, slideSpec, title, ctx);
      const points = strings(c.points);
      const cr = rectFor(slideSpec, 'code', { x: 0.6, y: 1.5, w: points.length > 0 ? 7.3 : 12.1, h: 5.2 });
      slide.addShape('roundRect', { x: cr.x, y: cr.y, w: cr.w, h: cr.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
      if (str(c.language)) text(slide, str(c.language), { x: cr.x + 0.3, y: cr.y + 0.16, w: cr.w - 0.6, h: 0.35, fontSize: 11, align: 'right', color: ctx.sub }, ctx);
      text(slide, str(c.code), { x: cr.x + 0.35, y: cr.y + 0.58, w: cr.w - 0.7, h: Math.max(0.5, cr.h - 0.8), fontSize: 13, fontFace: 'Consolas', valign: 'top' }, ctx);
      if (points.length > 0) {
        const pr = rectFor(slideSpec, 'points', { x: 8.2, y: 1.7, w: 4.5, h: 4.8 });
        bullets(slide, points, { x: pr.x, y: pr.y, w: pr.w, h: pr.h }, ctx);
      }
      break;
    }
    case 'chevron-process': {
      titleBlock(slide, slideSpec, title, ctx);
      const steps = arr(c.steps).map(rec);
      const n = Math.max(1, steps.length);
      const segW = 12.1 / n;
      steps.forEach((st, i) => {
        const r = rectFor(slideSpec, `step-${i}`, { x: 0.6 + i * segW, y: 2.35, w: segW, h: 2.6 });
        slide.addShape(i === 0 ? 'homePlate' : 'chevron', { x: r.x + 0.03, y: r.y, w: Math.max(0.4, r.w - 0.06), h: 1.05, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, str(st.title), { x: r.x + 0.14, y: r.y + 0.32, w: r.w - 0.28, h: 0.5, fontSize: 13, bold: true, align: 'center', color: '201F26' }, ctx);
        if (str(st.desc)) text(slide, str(st.desc), { x: r.x + 0.12, y: r.y + 1.32, w: r.w - 0.24, h: Math.max(0.3, r.h - 1.32), fontSize: 11, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'diagram-pyramid': {
      titleBlock(slide, slideSpec, title, ctx);
      const tiers = arr(c.tiers).map(rec);
      const n = Math.max(1, tiers.length);
      const tierH = 5.05 / n;
      tiers.forEach((tier, i) => {
        const dw = 12.1 * (0.4 + (i * 0.56) / Math.max(1, n - 1));
        const r = rectFor(slideSpec, `tier-${i}`, { x: (W - dw) / 2, y: 1.6 + i * tierH, w: dw, h: tierH - 0.14 });
        slide.addShape('trapezoid', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, str(tier.label), { x: r.x + 0.3, y: r.y + r.h * 0.16, w: r.w - 0.6, h: 0.42, fontSize: 16, bold: true, align: 'center', color: '201F26' }, ctx);
        if (str(tier.desc)) text(slide, str(tier.desc), { x: r.x + 0.3, y: r.y + r.h * 0.16 + 0.46, w: r.w - 0.6, h: Math.max(0.24, r.h * 0.42), fontSize: 11, align: 'center', color: '201F26' }, ctx);
      });
      break;
    }
    case 'roadmap': {
      titleBlock(slide, slideSpec, title, ctx);
      const phases = arr(c.phases).map(rec);
      const n = Math.max(1, phases.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      phases.forEach((phase, i) => {
        const x = 0.6 + i * (bw + 0.3);
        panel(slide, str(phase.label), strings(phase.items), rectFor(slideSpec, `phase-${i}`, { x, y: 1.55, w: bw, h: 5.1 }), ctx);
      });
      break;
    }
    case 'versus': {
      titleBlock(slide, slideSpec, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      panel(slide, str(left.title), strings(left.points), rectFor(slideSpec, 'left', { x: 0.6, y: 1.55, w: 5.62, h: 4.35 }), ctx);
      panel(slide, str(right.title), strings(right.points), rectFor(slideSpec, 'right', { x: 7.08, y: 1.55, w: 5.62, h: 4.35 }), ctx);
      const br = rectFor(slideSpec, 'badge', { x: W / 2 - 0.45, y: 3.28, w: 0.9, h: 0.9 });
      slide.addShape('ellipse', { x: br.x, y: br.y, w: br.w, h: br.h, fill: { color: ctx.accent }, line: { color: ctx.bg, width: 3 } });
      text(slide, 'VS', { x: br.x, y: br.y + br.h / 2 - 0.21, w: br.w, h: 0.42, fontSize: 16, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
      if (str(c.verdict)) {
        const r = rectFor(slideSpec, 'verdict', { x: 0.6, y: 6.1, w: 12.1, h: 0.62 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.accent }, line: { type: 'none' } });
        text(slide, str(c.verdict), { x: r.x + 0.25, y: r.y + 0.09, w: r.w - 0.5, h: Math.max(0.2, r.h - 0.16), fontSize: 14, bold: true, align: 'center', color: '201F26' }, ctx);
      }
      break;
    }
    case 'matrix-quadrant': {
      titleBlock(slide, slideSpec, title, ctx);
      const quadrants = arr(c.quadrants).map(rec).slice(0, 4);
      const pos: Array<[number, number]> = [[1.35, 1.55], [7.2, 1.55], [1.35, 4.12], [7.2, 4.12]];
      const anyPlaced = quadrants.some((_, i) => hasPos(slideSpec, `quadrant-${i}`));
      quadrants.forEach((q, i) => {
        const [x, y] = pos[i]!;
        panel(slide, str(q.label), strings(q.items), rectFor(slideSpec, `quadrant-${i}`, { x, y, w: 5.55, h: 2.28 }), ctx);
      });
      if (!anyPlaced) {
        slide.addShape('line', { x: 7.05, y: 1.55, w: 0, h: 4.85, line: { color: ctx.accent, width: 1.5 } });
        slide.addShape('line', { x: 1.35, y: 3.98, w: 11.4, h: 0, line: { color: ctx.accent, width: 1.5 } });
      }
      text(slide, str(c.xAxis), { x: 1.35, y: 6.58, w: 11.4, h: 0.4, fontSize: 12, align: 'center', color: ctx.sub }, ctx);
      text(slide, str(c.yAxis), { x: -0.5, y: 3.78, w: 3.2, h: 0.4, fontSize: 12, align: 'center', color: ctx.sub, rotate: 270 }, ctx);
      break;
    }
    case 'big-stat': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const vr = rectFor(slideSpec, 'value', { x: 0.7, y: 2.0, w: 7.2, h: 1.9 });
      text(slide, str(c.value), { x: vr.x, y: vr.y, w: vr.w, h: vr.h, fontSize: 88, bold: true, color: ctx.accent, valign: 'middle' }, ctx);
      const lr = rectFor(slideSpec, 'label', { x: 0.7, y: 4.05, w: 7.2, h: 1.0 });
      text(slide, str(c.label), { x: lr.x, y: lr.y, w: lr.w, h: lr.h, fontSize: 22, color: ctx.sub }, ctx);
      const points = strings(c.points);
      if (points.length > 0) {
        const pr = rectFor(slideSpec, 'points', { x: 8.3, y: 1.9, w: 4.4, h: 3.7 });
        slide.addShape('roundRect', { x: pr.x, y: pr.y, w: pr.w, h: pr.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        bullets(slide, points, { x: pr.x + 0.3, y: pr.y + 0.3, w: pr.w - 0.6, h: Math.max(0.4, pr.h - 0.6) }, ctx);
      }
      break;
    }
    case 'testimonial': {
      const tr = rectFor(slideSpec, 'text', { x: 1.1, y: 1.5, w: 11.1, h: 2.7 });
      text(slide, `“${str(c.text)}”`, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 30, italic: true, align: 'center', valign: 'middle' }, ctx);
      const pr = rectFor(slideSpec, 'person', { x: 4.55, y: 4.45, w: 4.25, h: 1.0 });
      slide.addShape('ellipse', { x: pr.x, y: pr.y + 0.08, w: 0.84, h: 0.84, fill: { color: ctx.accent }, line: { type: 'none' } });
      text(slide, initialsOf(str(c.name)), { x: pr.x, y: pr.y + 0.31, w: 0.84, h: 0.4, fontSize: 14, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
      text(slide, str(c.name), { x: pr.x + 1.05, y: pr.y + 0.14, w: pr.w - 1.05, h: 0.42, fontSize: 17, bold: true }, ctx);
      if (str(c.role)) text(slide, str(c.role), { x: pr.x + 1.05, y: pr.y + 0.58, w: pr.w - 1.05, h: 0.35, fontSize: 12, color: ctx.sub }, ctx);
      const metrics = arr(c.metrics).map(rec);
      if (metrics.length > 0) {
        const mr = rectFor(slideSpec, 'metrics', { x: (W - (metrics.length * 2.7 + (metrics.length - 1) * 0.25)) / 2, y: 5.85, w: metrics.length * 2.7 + (metrics.length - 1) * 0.25, h: 0.6 });
        const slot = mr.w / metrics.length;
        metrics.forEach((m, i) => {
          const x = mr.x + i * slot + 0.07;
          slide.addShape('roundRect', { x, y: mr.y, w: slot - 0.14, h: mr.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
          text(slide, `${str(m.value)}  ${str(m.label)}`, { x: x + 0.1, y: mr.y + 0.16, w: slot - 0.34, h: 0.32, fontSize: 12, align: 'center' }, ctx);
        });
      }
      break;
    }
    case 'profile-cards': {
      titleBlock(slide, slideSpec, title, ctx);
      const people = arr(c.people).map(rec);
      const n = Math.max(1, people.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      people.forEach((person, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `person-${i}`, { x, y: 1.6, w: bw, h: 5.0 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        slide.addShape('ellipse', { x: r.x + 0.3, y: r.y + 0.3, w: 0.85, h: 0.85, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, initialsOf(str(person.name)), { x: r.x + 0.3, y: r.y + 0.53, w: 0.85, h: 0.4, fontSize: 14, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
        text(slide, str(person.name), { x: r.x + 0.3, y: r.y + 1.42, w: r.w - 0.6, h: 0.55, fontSize: 18, bold: true }, ctx);
        text(slide, str(person.role), { x: r.x + 0.3, y: r.y + 1.98, w: r.w - 0.6, h: 0.4, fontSize: 12, bold: true, color: ctx.accent }, ctx);
        if (str(person.note)) text(slide, str(person.note), { x: r.x + 0.3, y: r.y + 2.45, w: r.w - 0.6, h: Math.max(0.35, r.h - 2.65), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'glossary': {
      titleBlock(slide, slideSpec, title, ctx);
      const terms = arr(c.terms).map(rec);
      const cols = terms.length <= 4 ? 2 : 3;
      const rows = Math.max(1, Math.ceil(terms.length / cols));
      const bw = (12.1 - 0.3 * (cols - 1)) / cols;
      const bh = (5.15 - 0.25 * (rows - 1)) / rows;
      terms.forEach((entry, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const r = rectFor(slideSpec, `term-${i}`, { x: 0.6 + col * (bw + 0.3), y: 1.55 + row * (bh + 0.25), w: bw, h: bh });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(entry.term), { x: r.x + 0.28, y: r.y + 0.2, w: r.w - 0.56, h: 0.42, fontSize: 16, bold: true, color: ctx.accent }, ctx);
        text(slide, str(entry.definition), { x: r.x + 0.28, y: r.y + 0.68, w: r.w - 0.56, h: Math.max(0.3, r.h - 0.85), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'mosaic': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const tiles = arr(c.tiles).map(rec).slice(0, 4);
      const defaults: Rect[] = [
        { x: 0.6, y: 1.55, w: 5.9, h: 5.05 },
        { x: 6.7, y: 1.55, w: 6.0, h: 2.4 },
        { x: 6.7, y: 4.2, w: 2.9, h: 2.4 },
        { x: 9.8, y: 4.2, w: 2.9, h: 2.4 },
      ];
      tiles.forEach((tile, i) => {
        const r = rectFor(slideSpec, `tile-${i}`, defaults[i]!);
        const imageName = str(tile.image);
        const imgPath = imageName ? join(deckPaths(root).assetsDir, basename(imageName)) : '';
        if (imgPath && existsSync(imgPath)) {
          slide.addImage({ path: imgPath, x: r.x, y: r.y, w: r.w, h: r.h, altText: str(tile.alt) || imageName });
        } else {
          boxText(slide, imageName ? `Image: ${imageName}` : 'Image', { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 13, color: ctx.sub }, ctx);
        }
      });
      if (str(c.caption)) {
        const r = rectFor(slideSpec, 'caption', { x: 0.6, y: 6.7, w: 12.1, h: 0.45 });
        text(slide, str(c.caption), { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 13, align: 'center', color: ctx.sub }, ctx);
      }
      break;
    }
    case 'agenda-toc': {
      titleBlock(slide, slideSpec, title, ctx);
      const items = arr(c.items).map(rec);
      items.forEach((item, i) => {
        const r = rectFor(slideSpec, `item-${i}`, { x: 0.7, y: 1.6 + i * 0.72, w: 11.9, h: 0.64 });
        text(slide, String(i + 1).padStart(2, '0'), { x: r.x, y: r.y, w: 0.95, h: 0.5, fontSize: 24, bold: true, color: ctx.accent }, ctx);
        text(slide, str(item.label), { x: r.x + 1.2, y: r.y + 0.05, w: r.w - 2.9, h: 0.45, fontSize: 18 }, ctx);
        if (str(item.page)) text(slide, str(item.page), { x: r.x + r.w - 1.2, y: r.y + 0.08, w: 1.1, h: 0.4, fontSize: 13, align: 'right', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'kpi-band': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const kpis = arr(c.kpis).map(rec);
      const n = Math.max(1, kpis.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      kpis.forEach((kpi, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `kpi-${i}`, { x, y: 2.0, w: bw, h: 3.3 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(kpi.value), { x: r.x + 0.25, y: r.y + 0.3, w: r.w - 0.5, h: 0.95, fontSize: 34, bold: true, color: ctx.accent }, ctx);
        text(slide, str(kpi.label), { x: r.x + 0.25, y: r.y + 1.35, w: r.w - 0.5, h: 1.1, fontSize: 13, color: ctx.sub }, ctx);
        if (str(kpi.delta)) {
          const down = kpi.deltaUp === false;
          text(slide, `${down ? '▼' : '▲'} ${str(kpi.delta)}`, { x: r.x + 0.25, y: r.y + r.h - 0.62, w: r.w - 0.5, h: 0.4, fontSize: 13, bold: true, color: down ? 'FF985A' : '00FFB2' }, ctx);
        }
      });
      break;
    }
    case 'funnel': {
      titleBlock(slide, slideSpec, title, ctx);
      const stages = arr(c.stages).map(rec);
      const fallback = [100, 78, 58, 40];
      stages.forEach((stage, i) => {
        const value = num(stage.value);
        const pct = value > 0 && value <= 100 ? Math.max(30, value) : fallback[Math.min(i, fallback.length - 1)]!;
        const w = 12.1 * (0.26 + pct * 0.005);
        const r = rectFor(slideSpec, `stage-${i}`, { x: 0.6, y: 1.7 + i * 1.18, w, h: 0.98 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, str(stage.label), { x: r.x + 0.3, y: r.y + 0.29, w: r.w - 1.8, h: 0.42, fontSize: 15, bold: true, color: '201F26' }, ctx);
        if (value > 0) text(slide, `${value}%`, { x: r.x + r.w - 1.4, y: r.y + 0.29, w: 1.1, h: 0.42, fontSize: 15, bold: true, align: 'right', color: '201F26' }, ctx);
        if (str(stage.desc)) text(slide, str(stage.desc), { x: r.x + r.w + 0.35, y: r.y + 0.29, w: Math.max(0.5, W - 0.6 - (r.x + r.w + 0.35)), h: 0.42, fontSize: 11, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'gantt-bars': {
      titleBlock(slide, slideSpec, title, ctx);
      if (str(c.startLabel)) text(slide, str(c.startLabel), { x: 3.35, y: 1.28, w: 3, h: 0.3, fontSize: 10, color: ctx.sub }, ctx);
      if (str(c.endLabel)) text(slide, str(c.endLabel), { x: 9.7, y: 1.28, w: 3, h: 0.3, fontSize: 10, align: 'right', color: ctx.sub }, ctx);
      const bars = arr(c.bars).map(rec);
      bars.forEach((bar, i) => {
        const r = rectFor(slideSpec, `bar-${i}`, { x: 0.6, y: 1.68 + i * 0.82, w: 12.1, h: 0.66 });
        text(slide, str(bar.label), { x: r.x, y: r.y + 0.1, w: 2.55, h: 0.4, fontSize: 13 }, ctx);
        slide.addShape('roundRect', { x: r.x + 2.75, y: r.y + 0.06, w: 9.35, h: 0.5, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 0.75 } });
        const start = Math.min(95, Math.max(0, num(bar.start)));
        const span = Math.min(100 - start, Math.max(3, num(bar.span) || 10));
        slide.addShape('roundRect', { x: r.x + 2.75 + (9.35 * start) / 100, y: r.y + 0.13, w: (9.35 * span) / 100, h: 0.36, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        if (str(bar.note)) text(slide, str(bar.note), { x: r.x + 2.75, y: r.y + 0.58, w: 9.35, h: 0.28, fontSize: 10, align: 'right', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'org-chart': {
      titleBlock(slide, slideSpec, title, ctx);
      const rootPerson = rec(c.root);
      const reports = arr(c.reports).map(rec);
      const rr = rectFor(slideSpec, 'root', { x: 4.65, y: 1.45, w: 4.0, h: 1.3 });
      slide.addShape('roundRect', { x: rr.x, y: rr.y, w: rr.w, h: rr.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1.25 } });
      slide.addShape('ellipse', { x: rr.x + 0.25, y: rr.y + 0.28, w: 0.74, h: 0.74, fill: { color: ctx.accent }, line: { type: 'none' } });
      text(slide, initialsOf(str(rootPerson.name)), { x: rr.x + 0.25, y: rr.y + 0.5, w: 0.74, h: 0.35, fontSize: 13, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
      text(slide, str(rootPerson.name), { x: rr.x + 1.2, y: rr.y + 0.24, w: rr.w - 1.45, h: 0.45, fontSize: 16, bold: true }, ctx);
      text(slide, str(rootPerson.role), { x: rr.x + 1.2, y: rr.y + 0.72, w: rr.w - 1.45, h: 0.4, fontSize: 11, color: ctx.accent }, ctx);
      const n = Math.max(1, reports.length);
      const anyPlaced = hasPos(slideSpec, 'root') || reports.some((_, i) => hasPos(slideSpec, `person-${i}`));
      if (!anyPlaced) {
        slide.addShape('line', { x: W / 2, y: 2.75, w: 0, h: 0.55, line: { color: ctx.accent, width: 1.5 } });
        if (n > 1) slide.addShape('line', { x: 0.6 + (12.1 / n) / 2, y: 3.3, w: 12.1 - 12.1 / n, h: 0, line: { color: ctx.accent, width: 1.5 } });
      }
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      reports.forEach((person, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `person-${i}`, { x, y: 3.55, w: bw, h: 3.1 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        slide.addShape('ellipse', { x: r.x + 0.28, y: r.y + 0.28, w: 0.74, h: 0.74, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, initialsOf(str(person.name)), { x: r.x + 0.28, y: r.y + 0.5, w: 0.74, h: 0.35, fontSize: 13, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
        text(slide, str(person.name), { x: r.x + 1.2, y: r.y + 0.3, w: r.w - 1.45, h: 0.45, fontSize: 15, bold: true }, ctx);
        text(slide, str(person.role), { x: r.x + 1.2, y: r.y + 0.78, w: r.w - 1.45, h: 0.4, fontSize: 11, color: ctx.accent }, ctx);
        const members = strings(person.members);
        if (members.length > 0) glyphLines(slide, members, '•', { x: r.x + 0.3, y: r.y + 1.5, w: r.w - 0.6, h: Math.max(0.4, r.h - 1.7) }, ctx, 12);
      });
      break;
    }
    case 'pros-cons': {
      titleBlock(slide, slideSpec, title, ctx);
      const pros = rec(c.pros); const cons = rec(c.cons);
      const drawPanel = (column: Record<string, unknown>, glyph: string, r: Rect): void => {
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, `${glyph} ${str(column.title)}`, { x: r.x + 0.35, y: r.y + 0.2, w: r.w - 0.7, h: 0.5, fontSize: 19, bold: true, color: ctx.accent }, ctx);
        glyphLines(slide, strings(column.points), glyph, { x: r.x + 0.35, y: r.y + 0.85, w: r.w - 0.7, h: Math.max(0.4, r.h - 1.1) }, ctx);
      };
      drawPanel(pros, '✓', rectFor(slideSpec, 'pros', { x: 0.6, y: 1.55, w: 5.85, h: 4.9 }));
      drawPanel(cons, '✗', rectFor(slideSpec, 'cons', { x: 6.85, y: 1.55, w: 5.85, h: 4.9 }));
      break;
    }
    case 'pricing-tiers': {
      titleBlock(slide, slideSpec, title, ctx);
      const tiers = arr(c.tiers).map(rec);
      const n = Math.max(1, tiers.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      tiers.forEach((tier, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const featured = tier.featured === true;
        const r = rectFor(slideSpec, `tier-${i}`, { x, y: featured ? 1.5 : 1.65, w: bw, h: featured ? 4.75 : 4.45 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: featured ? ctx.accent : ctx.surface }, line: { color: ctx.accent, width: featured ? 2 : 1 } });
        const ink = featured ? '201F26' : ctx.fg;
        let y = r.y + 0.3;
        if (featured) { text(slide, 'PALING DIPILIH', { x: r.x + 0.3, y, w: r.w - 0.6, h: 0.32, fontSize: 10, bold: true, color: ink }, ctx); y += 0.42; }
        text(slide, str(tier.name).toUpperCase(), { x: r.x + 0.3, y, w: r.w - 0.6, h: 0.35, fontSize: 12, bold: true, color: featured ? ink : ctx.sub }, ctx);
        text(slide, str(tier.price), { x: r.x + 0.3, y: y + 0.38, w: r.w - 0.6, h: 0.75, fontSize: 28, bold: true, color: ink }, ctx);
        if (str(tier.period)) text(slide, str(tier.period), { x: r.x + 0.3, y: y + 1.12, w: r.w - 0.6, h: 0.32, fontSize: 11, color: featured ? ink : ctx.sub }, ctx);
        const features = strings(tier.features).map((f) => `✓ ${f}`);
        slide.addText(features.map((f, j) => ({ text: f, options: { breakLine: j < features.length - 1, fontSize: 12, color: ink } })), { fontFace: 'Arial', x: r.x + 0.3, y: y + 1.55, w: r.w - 0.6, h: Math.max(0.4, r.h - (y - r.y) - 1.7), valign: 'top' });
      });
      if (str(c.note)) {
        const r = rectFor(slideSpec, 'note', { x: 0.6, y: 6.45, w: 12.1, h: 0.45 });
        text(slide, str(c.note), { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 12, align: 'center', color: ctx.sub }, ctx);
      }
      break;
    }
    case 'faq': {
      titleBlock(slide, slideSpec, title, ctx);
      const items = arr(c.items).map(rec);
      items.forEach((item, i) => {
        const r = rectFor(slideSpec, `item-${i}`, { x: 0.7, y: 1.6 + i * 1.04, w: 11.9, h: 0.94 });
        slide.addShape('ellipse', { x: r.x, y: r.y + 0.05, w: 0.55, h: 0.55, fill: { color: ctx.accent }, line: { type: 'none' } });
        text(slide, 'Q', { x: r.x, y: r.y + 0.17, w: 0.55, h: 0.32, fontSize: 14, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
        text(slide, str(item.q), { x: r.x + 0.85, y: r.y, w: r.w - 0.85, h: 0.42, fontSize: 16, bold: true }, ctx);
        text(slide, str(item.a), { x: r.x + 0.85, y: r.y + 0.46, w: r.w - 0.85, h: Math.max(0.3, r.h - 0.46), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'steps-cards': {
      titleBlock(slide, slideSpec, title, ctx);
      const steps = arr(c.steps).map(rec);
      const n = Math.max(1, steps.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      const anyPlaced = steps.some((_, i) => hasPos(slideSpec, `step-${i}`));
      if (!anyPlaced) slide.addShape('line', { x: 0.6 + bw / 2, y: 2.15, w: 12.1 - bw, h: 0, line: { color: ctx.accent, width: 1.5, dashType: 'dash' } });
      steps.forEach((step, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `step-${i}`, { x, y: 1.6, w: bw, h: 5.0 });
        slide.addShape('ellipse', { x: r.x + r.w / 2 - 0.42, y: r.y, w: 0.84, h: 0.84, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1.5 } });
        text(slide, String(i + 1), { x: r.x + r.w / 2 - 0.42, y: r.y + 0.22, w: 0.84, h: 0.4, fontSize: 18, bold: true, align: 'center', color: ctx.accent }, ctx);
        slide.addShape('roundRect', { x: r.x, y: r.y + 1.15, w: r.w, h: r.h - 1.15, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(step.title), { x: r.x + 0.25, y: r.y + 1.45, w: r.w - 0.5, h: 0.55, fontSize: 16, bold: true, align: 'center' }, ctx);
        if (str(step.desc)) text(slide, str(step.desc), { x: r.x + 0.25, y: r.y + 2.05, w: r.w - 0.5, h: Math.max(0.35, r.h - 2.2), fontSize: 12, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'split-visual-quote': {
      const side = c.side === 'left' ? 'left' : 'right';
      const imgX = side === 'left' ? 0.6 : 7.7;
      const txtX = side === 'left' ? 6.0 : 0.6;
      placeImage(slide, root, str(c.image), str(c.alt), rectFor(slideSpec, 'image', { x: imgX, y: 1.0, w: 5.0, h: 5.5 }), ctx, 14);
      const qr = rectFor(slideSpec, 'quote', { x: txtX, y: 1.7, w: 6.7, h: 3.4 });
      text(slide, `“${str(c.quote)}”`, { x: qr.x, y: qr.y, w: qr.w, h: qr.h, fontSize: 27, italic: true, valign: 'middle' }, ctx);
      if (str(c.author) || str(c.role)) {
        const ar = rectFor(slideSpec, 'author', { x: txtX, y: 5.35, w: 6.7, h: 0.95 });
        text(slide, str(c.author), { x: ar.x, y: ar.y, w: ar.w, h: 0.45, fontSize: 16, bold: true, color: ctx.accent }, ctx);
        if (str(c.role)) text(slide, str(c.role), { x: ar.x, y: ar.y + 0.48, w: ar.w, h: 0.35, fontSize: 12, color: ctx.sub }, ctx);
      }
      break;
    }
    case 'banner-cta': {
      const tr = rectFor(slideSpec, 'title', { x: 0.9, y: 1.9, w: 11.5, h: 1.7 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 40, bold: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.subtitle)) {
        const sr = rectFor(slideSpec, 'subtitle', { x: 1.6, y: 3.75, w: 10.1, h: 0.85 });
        text(slide, str(c.subtitle), { x: sr.x, y: sr.y, w: sr.w, h: sr.h, fontSize: 17, align: 'center', color: ctx.sub }, ctx);
      }
      const ar = rectFor(slideSpec, 'actions', { x: 3.45, y: 4.85, w: 6.45, h: 0.75 });
      slide.addShape('roundRect', { x: ar.x, y: ar.y, w: 3.1, h: ar.h, fill: { color: ctx.accent }, line: { type: 'none' } });
      text(slide, str(c.primary), { x: ar.x, y: ar.y + 0.2, w: 3.1, h: 0.4, fontSize: 15, bold: true, align: 'center', color: '201F26' }, ctx);
      if (str(c.secondary)) {
        slide.addShape('roundRect', { x: ar.x + 3.35, y: ar.y, w: 3.1, h: ar.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1.25 } });
        text(slide, str(c.secondary), { x: ar.x + 3.35, y: ar.y + 0.2, w: 3.1, h: 0.4, fontSize: 15, bold: true, align: 'center', color: ctx.accent }, ctx);
      }
      if (str(c.note)) {
        const nr = rectFor(slideSpec, 'note', { x: 1.6, y: 5.95, w: 10.1, h: 0.4 });
        text(slide, str(c.note), { x: nr.x, y: nr.y, w: nr.w, h: nr.h, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
      }
      break;
    }
    case 'logo-wall': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const logos = arr(c.logos).map(rec);
      const cols = 4;
      const bw = (12.1 - 0.3 * (cols - 1)) / cols;
      logos.forEach((logo, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const r = rectFor(slideSpec, `logo-${i}`, { x: 0.6 + col * (bw + 0.3), y: 2.0 + row * 2.35, w: bw, h: 2.05 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, initialsOf(str(logo.name)), { x: r.x + 0.25, y: r.y + 0.3, w: r.w - 0.5, h: 0.6, fontSize: 20, bold: true, align: 'center', color: ctx.accent }, ctx);
        text(slide, str(logo.name), { x: r.x + 0.25, y: r.y + 1.05, w: r.w - 0.5, h: 0.75, fontSize: 13, bold: true, align: 'center' }, ctx);
      });
      break;
    }
    case 'year-markers': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const years = arr(c.years).map(rec);
      const n = Math.max(1, years.length);
      const bw = (12.1 - 0.4 * (n - 1)) / n;
      years.forEach((entry, i) => {
        const x = 0.6 + i * (bw + 0.4);
        const r = rectFor(slideSpec, `year-${i}`, { x, y: 2.1, w: bw, h: 4.2 });
        text(slide, str(entry.year), { x: r.x, y: r.y, w: r.w, h: 1.15, fontSize: 40, bold: true, color: ctx.accent }, ctx);
        slide.addShape('line', { x: r.x, y: r.y + 1.45, w: r.w, h: 0, line: { color: ctx.accent, width: 2 } });
        text(slide, str(entry.label), { x: r.x, y: r.y + 1.7, w: r.w, h: 0.6, fontSize: 17, bold: true }, ctx);
        if (str(entry.desc)) text(slide, str(entry.desc), { x: r.x, y: r.y + 2.35, w: r.w, h: Math.max(0.35, r.h - 2.35), fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'stat-duel': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      const lr = rectFor(slideSpec, 'left', { x: 0.6, y: 2.2, w: 4.6, h: 2.6 });
      text(slide, str(left.value), { x: lr.x, y: lr.y, w: lr.w, h: 1.4, fontSize: 60, bold: true }, ctx);
      text(slide, str(left.label), { x: lr.x, y: lr.y + 1.5, w: lr.w, h: 1.0, fontSize: 14, color: ctx.sub }, ctx);
      const rgt = rectFor(slideSpec, 'right', { x: 8.15, y: 2.2, w: 4.6, h: 2.6 });
      text(slide, str(right.value), { x: rgt.x, y: rgt.y, w: rgt.w, h: 1.4, fontSize: 60, bold: true, align: 'right', color: ctx.accent }, ctx);
      text(slide, str(right.label), { x: rgt.x, y: rgt.y + 1.5, w: rgt.w, h: 1.0, fontSize: 14, align: 'right', color: ctx.sub }, ctx);
      const dr = rectFor(slideSpec, 'delta', { x: W / 2 - 1.05, y: 2.75, w: 2.1, h: 0.85 });
      slide.addShape('roundRect', { x: dr.x, y: dr.y, w: dr.w, h: dr.h, fill: { color: ctx.accent }, line: { type: 'none' } });
      text(slide, str(c.delta), { x: dr.x, y: dr.y + 0.22, w: dr.w, h: 0.42, fontSize: 17, bold: true, align: 'center', color: '201F26' }, ctx);
      if (str(c.note)) {
        const nr = rectFor(slideSpec, 'note', { x: 0.6, y: 5.6, w: 12.1, h: 0.9 });
        slide.addShape('roundRect', { x: nr.x, y: nr.y, w: nr.w, h: nr.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(c.note), { x: nr.x + 0.3, y: nr.y + 0.18, w: nr.w - 0.6, h: Math.max(0.3, nr.h - 0.3), fontSize: 12, align: 'center', color: ctx.sub }, ctx);
      }
      break;
    }
    case 'waterfall-steps': {
      titleBlock(slide, slideSpec, title, ctx);
      const steps = arr(c.steps).map(rec);
      steps.forEach((step, i) => {
        const w = Math.max(3.6, 8.2 - i * 1.15);
        const r = rectFor(slideSpec, `step-${i}`, { x: 0.6 + i * 1.35, y: 1.7 + i * 1.18, w, h: 0.98 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, String(i + 1), { x: r.x + 0.25, y: r.y + 0.24, w: 0.6, h: 0.5, fontSize: 20, bold: true, color: ctx.accent }, ctx);
        text(slide, str(step.label), { x: r.x + 0.95, y: r.y + 0.14, w: r.w - 1.2, h: 0.42, fontSize: 15, bold: true }, ctx);
        if (str(step.desc)) text(slide, str(step.desc), { x: r.x + 0.95, y: r.y + 0.56, w: r.w - 1.2, h: 0.34, fontSize: 11, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'feature-highlight': {
      const ir = rectFor(slideSpec, 'icon', { x: 0.7, y: 2.15, w: 2.0, h: 2.0 });
      slide.addShape('ellipse', { x: ir.x, y: ir.y, w: ir.w, h: ir.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1.5 } });
      text(slide, '✦', { x: ir.x, y: ir.y + ir.h / 2 - 0.32, w: ir.w, h: 0.6, fontSize: 30, bold: true, align: 'center', color: ctx.accent }, ctx);
      const tr = rectFor(slideSpec, 'title', { x: 3.3, y: 1.45, w: 9.4, h: 1.15 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 28, bold: true, valign: 'middle' }, ctx);
      let cursorY = 2.75;
      if (str(c.lead)) {
        text(slide, str(c.lead), { x: 3.3, y: cursorY, w: 9.4, h: 1.05, fontSize: 14, color: ctx.sub }, ctx);
        cursorY += 1.2;
      }
      const checks = strings(c.checks);
      if (checks.length > 0) {
        const cr = rectFor(slideSpec, 'checks', { x: 3.3, y: cursorY, w: 9.4, h: Math.max(0.6, 6.9 - cursorY) });
        glyphLines(slide, checks, '✓', { x: cr.x, y: cr.y, w: cr.w, h: cr.h }, ctx, 15);
      }
      break;
    }
    case 'callout': {
      const tone = str(c.tone);
      const toneColor = tone === 'success' ? '00FFB2' : tone === 'warning' ? 'FF985A' : ctx.accent;
      slide.addShape('roundRect', { x: 0.6, y: 1.7, w: 12.1, h: 4.6, fill: { color: ctx.surface }, line: { color: toneColor, width: 1.5 } });
      slide.addShape('rect', { x: 0.6, y: 1.7, w: 0.14, h: 4.6, fill: { color: toneColor }, line: { type: 'none' } });
      slide.addShape('ellipse', { x: 1.05, y: 2.05, w: 0.8, h: 0.8, fill: { color: toneColor }, line: { type: 'none' } });
      text(slide, '!', { x: 1.05, y: 2.24, w: 0.8, h: 0.42, fontSize: 20, bold: true, align: 'center', color: '201F26' }, ctx);
      const tr = rectFor(slideSpec, 'title', { x: 2.15, y: 1.95, w: 10.2, h: 0.95 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 24, bold: true, valign: 'middle' }, ctx);
      const br = rectFor(slideSpec, 'body', { x: 1.05, y: 3.1, w: 11.3, h: 1.7 });
      text(slide, str(c.body), { x: br.x, y: br.y, w: br.w, h: br.h, fontSize: 15 }, ctx);
      const points = strings(c.points);
      if (points.length > 0) {
        const pr = rectFor(slideSpec, 'points', { x: 1.05, y: 4.9, w: 11.3, h: 1.2 });
        glyphLines(slide, points, '✓', { x: pr.x, y: pr.y, w: pr.w, h: pr.h }, ctx, 13);
      }
      break;
    }
    case 'ranking-list': {
      titleBlock(slide, slideSpec, title, ctx);
      const entries = arr(c.entries).map(rec);
      const max = Math.max(1, ...entries.map((e) => num(e.value)));
      entries.forEach((entry, i) => {
        const r = rectFor(slideSpec, `entry-${i}`, { x: 0.7, y: 1.62 + i * 1.02, w: 11.9, h: 0.92 });
        text(slide, String(i + 1), { x: r.x, y: r.y, w: 0.7, h: 0.5, fontSize: 22, bold: true, color: ctx.accent }, ctx);
        text(slide, str(entry.label), { x: r.x + 0.95, y: r.y + 0.02, w: r.w - 2.6, h: 0.42, fontSize: 16, bold: true }, ctx);
        text(slide, str(entry.value), { x: r.x + r.w - 1.3, y: r.y + 0.02, w: 1.2, h: 0.42, fontSize: 16, bold: true, align: 'right', color: ctx.accent }, ctx);
        slide.addShape('roundRect', { x: r.x + 0.95, y: r.y + 0.55, w: 8.6, h: 0.26, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 0.5 } });
        slide.addShape('roundRect', { x: r.x + 0.95, y: r.y + 0.55, w: Math.max(0.3, (8.6 * num(entry.value)) / max), h: 0.26, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
      });
      break;
    }
    case 'hero-image-caption': {
      placeImage(slide, root, str(c.image), str(c.alt), rectFor(slideSpec, 'image', { x: 0.6, y: 0.5, w: 12.1, h: 3.9 }), ctx, 16);
      const tr = rectFor(slideSpec, 'title', { x: 0.6, y: 4.7, w: 12.1, h: 0.95 });
      text(slide, title, { x: tr.x, y: tr.y, w: tr.w, h: tr.h, fontSize: 30, bold: true, valign: 'middle' }, ctx);
      if (str(c.caption)) {
        const cr = rectFor(slideSpec, 'caption', { x: 0.6, y: 5.8, w: 12.1, h: 0.85 });
        text(slide, str(c.caption), { x: cr.x, y: cr.y, w: cr.w, h: cr.h, fontSize: 14, color: ctx.sub }, ctx);
      }
      break;
    }
    case 'quote-wall': {
      if (title || hasPos(slideSpec, 'title')) titleBlock(slide, slideSpec, title, ctx);
      const quotes = arr(c.quotes).map(rec);
      const n = Math.max(1, quotes.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      quotes.forEach((quote, i) => {
        const x = 0.6 + i * (bw + 0.3);
        const r = rectFor(slideSpec, `quote-${i}`, { x, y: 1.65, w: bw, h: 4.9 });
        slide.addShape('roundRect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, '“', { x: r.x + 0.28, y: r.y + 0.15, w: 0.7, h: 0.6, fontSize: 30, bold: true, color: ctx.accent }, ctx);
        text(slide, str(quote.text), { x: r.x + 0.28, y: r.y + 0.85, w: r.w - 0.56, h: Math.max(0.5, r.h - 2.2), fontSize: 14, italic: true }, ctx);
        slide.addShape('ellipse', { x: r.x + 0.28, y: r.y + r.h - 1.05, w: 0.68, h: 0.68, fill: { color: ctx.colors[i % ctx.colors.length] }, line: { type: 'none' } });
        text(slide, initialsOf(str(quote.name)), { x: r.x + 0.28, y: r.y + r.h - 0.85, w: 0.68, h: 0.32, fontSize: 12, bold: true, align: 'center', color: 'FFFFFF' }, ctx);
        text(slide, str(quote.name), { x: r.x + 1.12, y: r.y + r.h - 1.0, w: r.w - 1.4, h: 0.4, fontSize: 13, bold: true }, ctx);
        if (str(quote.role)) text(slide, str(quote.role), { x: r.x + 1.12, y: r.y + r.h - 0.6, w: r.w - 1.4, h: 0.32, fontSize: 11, color: ctx.sub }, ctx);
      });
      break;
    }
    default: {
      titleBlock(slide, slideSpec, title || slideSpec.layout, ctx);
      text(slide, JSON.stringify(c, null, 2).slice(0, 1200), { x: 0.85, y: 1.5, w: 11.6, h: 5.2, fontSize: 13, color: ctx.sub }, ctx);
      break;
    }
  }

  if (slideSpec.notes) slide.addNotes(slideSpec.notes);
  void deck;
}

export async function exportDeckToPptx(deck: DeckSpec, root: string): Promise<{ relativePath: string; bytes: number; slideCount: number }> {
  // An empty deck is not a presentation: never emit a placeholder-title
  // .pptx that completion checks would mistake for generated slides.
  if (!deck.slides || deck.slides.length === 0) {
    throw new Error('cannot export an empty deck: add at least one slide (add_slide) before exporting');
  }
  const paths = deckPaths(root);
  await mkdir(paths.dir, { recursive: true });

  const dark = deck.theme.dark !== false;
  const accent = hex(deck.theme.accent, '6B50FF');
  // An imported template's accent ramp (accent1..accent6) drives chart
  // series when it carries one; otherwise the built-in series follows the
  // accent exactly as before.
  const themeSeries = (deck.theme.series ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).map((c) => c.replace(/^#/, '').toUpperCase());
  const ctx: Ctx = {
    dark,
    bg: hex(deck.theme.background, dark ? '201F26' : 'F4F2FA'),
    fg: hex(deck.theme.text, dark ? 'ECEBF0' : '201F26'),
    sub: hex(deck.theme.muted, dark ? 'BFBCC8' : '4D4C57'),
    surface: hex(deck.theme.surface, dark ? '2D2C36' : 'FFFFFF'),
    accent,
    colors: themeSeries.length > 0 ? themeSeries : [accent, ...SERIES_COLORS],
  };

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DAEDALUS_WIDE', width: W, height: H });
  pptx.layout = 'DAEDALUS_WIDE';
  pptx.title = deck.title;
  pptx.theme = { headFontFace: deck.theme.headingFont ?? 'Arial', bodyFontFace: deck.theme.bodyFont ?? 'Arial' };

  for (const s of deck.slides) renderSlide(pptx, s, deck, root, ctx);

  const fileName = `${slugifyTitle(deck.title)}.pptx`;
  const outPath = join(paths.dir, fileName);
  const data = await pptx.write({ outputType: 'nodebuffer' });
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  await writeFile(outPath, buf);
  const info = await stat(outPath);
  return { relativePath: `deck/${fileName}`, bytes: info.size, slideCount: deck.slides.length };
}
