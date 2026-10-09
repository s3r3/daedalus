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
  background: { color: string };
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

function renderSlide(pptx: PptxInstance, slideSpec: Slide, deck: DeckSpec, root: string, ctx: Ctx): void {
  const slide = pptx.addSlide();
  slide.background = { color: ctx.bg };
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
  const ctx: Ctx = {
    dark,
    bg: hex(deck.theme.background, dark ? '201F26' : 'F4F2FA'),
    fg: hex(deck.theme.text, dark ? 'ECEBF0' : '201F26'),
    sub: hex(deck.theme.muted, dark ? 'BFBCC8' : '4D4C57'),
    surface: hex(deck.theme.surface, dark ? '2D2C36' : 'FFFFFF'),
    accent,
    colors: [accent, ...SERIES_COLORS],
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
