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

function panel(slide: PptxSlide, heading: string, points: string[], x: number, ctx: Ctx): void {
  slide.addShape('roundRect', { x, y: 1.55, w: 5.85, h: 4.9, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
  text(slide, heading, { x: x + 0.35, y: 1.75, w: 5.15, h: 0.5, fontSize: 20, bold: true, color: ctx.accent }, ctx);
  bullets(slide, points, { x: x + 0.35, y: 2.35, w: 5.15, h: 3.8 }, ctx);
}

function renderSlide(pptx: PptxInstance, slideSpec: Slide, deck: DeckSpec, root: string, ctx: Ctx): void {
  const slide = pptx.addSlide();
  slide.background = { color: ctx.bg };
  slide.color = ctx.fg;
  const c = slideSpec.content;
  const title = str(c.title);

  switch (slideSpec.layout) {
    case 'title': {
      text(slide, title, { x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontSize: 44, bold: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.subtitle)) text(slide, str(c.subtitle), { x: 1.3, y: 3.95, w: 10.7, h: 0.9, fontSize: 22, align: 'center', color: ctx.sub }, ctx);
      slide.addShape('rect', { x: 5.9, y: 5.05, w: 1.5, h: 0.08, fill: { color: ctx.accent }, line: { type: 'none' } });
      break;
    }
    case 'section': {
      const numLabel = c.number !== undefined && c.number !== '' ? str(c.number) : '';
      if (numLabel) text(slide, numLabel, { x: 0.7, y: 1.6, w: 2.2, h: 1.6, fontSize: 72, bold: true, color: ctx.accent }, ctx);
      text(slide, title, { x: numLabel ? 3.0 : 0.8, y: 2.55, w: 9.5, h: 1.4, fontSize: 40, bold: true, valign: 'middle' }, ctx);
      break;
    }
    case 'bullets': {
      addTitleBar(slide, title, ctx);
      bullets(slide, strings(c.points), { x: 0.85, y: 1.45, w: 11.6, h: 5.4 }, ctx);
      break;
    }
    case 'two-column': {
      addTitleBar(slide, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      panel(slide, str(left.heading), strings(left.points), 0.6, ctx);
      panel(slide, str(right.heading), strings(right.points), 6.85, ctx);
      break;
    }
    case 'image-side': {
      addTitleBar(slide, title, ctx);
      const side = c.side === 'left' ? 'left' : 'right';
      const imgX = side === 'left' ? 0.6 : 7.1;
      const txtX = side === 'left' ? 7.1 : 0.6;
      const imageName = str(c.image);
      const imgPath = imageName ? join(deckPaths(root).assetsDir, basename(imageName)) : '';
      if (imgPath && existsSync(imgPath)) {
        slide.addImage({ path: imgPath, x: imgX, y: 1.55, w: 5.6, h: 4.9, altText: str(c.alt) || imageName });
      } else {
        boxText(slide, imageName ? `Image: ${imageName}` : 'Image', { x: imgX, y: 1.55, w: 5.6, h: 4.9, fontSize: 16, color: ctx.sub }, ctx);
      }
      bullets(slide, strings(c.points), { x: txtX, y: 1.7, w: 5.6, h: 4.7 }, ctx);
      break;
    }
    case 'diagram-flow': {
      addTitleBar(slide, title, ctx);
      const steps = arr(c.steps).map(rec);
      const n = Math.max(1, steps.length);
      const gap = 0.28; const totalW = 12.1; const bw = (totalW - gap * (n - 1)) / n;
      steps.forEach((st, i) => {
        const x = 0.6 + i * (bw + gap);
        boxText(slide, str(st.title), { x, y: 2.35, w: bw, h: 1.15, fontSize: 15, bold: true }, ctx);
        if (str(st.desc)) text(slide, str(st.desc), { x, y: 3.65, w: bw, h: 1.1, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
        if (i < steps.length - 1) slide.addShape('chevron', { x: x + bw + 0.02, y: 2.78, w: 0.24, h: 0.3, fill: { color: ctx.accent }, line: { type: 'none' } });
      });
      break;
    }
    case 'diagram-cycle': {
      addTitleBar(slide, title, ctx);
      const nodes = strings(c.nodes).slice(0, 4);
      const pos: Array<[number, number]> = [[5.15, 1.55], [8.6, 3.35], [5.15, 5.15], [1.7, 3.35]];
      nodes.forEach((node, i) => { const [x, y] = pos[i]!; boxText(slide, node, { x, y, w: 3.0, h: 1.0, fontSize: 16, bold: true }, ctx); });
      slide.addShape('ellipse', { x: 5.85, y: 3.35, w: 1.6, h: 1.0, fill: { color: ctx.accent }, line: { type: 'none' } });
      break;
    }
    case 'diagram-hierarchy': {
      addTitleBar(slide, title, ctx);
      boxText(slide, str(c.root), { x: 4.9, y: 1.4, w: 3.5, h: 0.95, fontSize: 18, bold: true }, ctx, ctx.accent);
      const groups = arr(c.groups).map(rec);
      const n = Math.max(1, groups.length);
      const bw = Math.min(3.6, (12.1 - 0.3 * (n - 1)) / n);
      const total = bw * n + 0.3 * (n - 1);
      const startX = (W - total) / 2;
      groups.forEach((g, i) => {
        const x = startX + i * (bw + 0.3);
        const cx = x + bw / 2;
        slide.addShape('line', { x: cx, y: 2.35, w: 0, h: 0.85, line: { color: ctx.accent, width: 2 } });
        slide.addShape('roundRect', { x, y: 3.2, w: bw, h: 3.4, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(g.label), { x: x + 0.25, y: 3.4, w: bw - 0.5, h: 0.5, fontSize: 16, bold: true, align: 'center', color: ctx.accent }, ctx);
        bullets(slide, strings(g.items), { x: x + 0.25, y: 3.95, w: bw - 0.5, h: 2.4 }, ctx);
      });
      break;
    }
    case 'timeline': {
      addTitleBar(slide, title, ctx);
      const events = arr(c.events).map(rec);
      slide.addShape('line', { x: 0.7, y: 3.85, w: 11.9, h: 0, line: { color: ctx.accent, width: 3 } });
      const n = Math.max(1, events.length);
      events.forEach((ev, i) => {
        const x = 0.8 + (i * 11.7) / n;
        const bw = 11.7 / n - 0.2;
        const above = i % 2 === 0;
        slide.addShape('ellipse', { x: x + bw / 2 - 0.11, y: 3.74, w: 0.22, h: 0.22, fill: { color: ctx.accent }, line: { type: 'none' } });
        const ty = above ? 1.65 : 4.25;
        text(slide, `${str(ev.when)} — ${str(ev.title)}`, { x, y: ty, w: bw, h: 0.75, fontSize: 13, bold: true, align: 'center', color: ctx.accent }, ctx);
        if (str(ev.desc)) text(slide, str(ev.desc), { x, y: ty + 0.75, w: bw, h: 0.9, fontSize: 11, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'comparison': {
      addTitleBar(slide, title, ctx);
      const left = rec(c.left); const right = rec(c.right);
      panel(slide, str(left.title), strings(left.points), 0.6, ctx);
      panel(slide, str(right.title), strings(right.points), 6.85, ctx);
      if (str(c.verdict)) {
        slide.addShape('roundRect', { x: 0.6, y: 6.55, w: 12.1, h: 0.6, fill: { color: ctx.accent }, line: { type: 'none' } });
        text(slide, str(c.verdict), { x: 0.85, y: 6.62, w: 11.6, h: 0.45, fontSize: 14, bold: true, align: 'center', color: '201F26' }, ctx);
      }
      break;
    }
    case 'chart-bar': {
      addTitleBar(slide, title, ctx);
      const data = arr(c.data).map(rec);
      slide.addChart('bar', [{ name: str(c.unit) || title, labels: data.map((d) => str(d.label)), values: data.map((d) => num(d.value)) }], {
        x: 0.7, y: 1.45, w: 11.9, h: 5.4, barDir: 'col', chartColors: ctx.colors, showLegend: false, showTitle: false,
        catAxisLabelColor: ctx.fg, valAxisLabelColor: ctx.sub, catAxisLineColor: ctx.sub, valAxisLineColor: ctx.sub,
      });
      break;
    }
    case 'chart-line': {
      addTitleBar(slide, title, ctx);
      const series = arr(c.series).map(rec);
      const maxLen = Math.max(0, ...series.map((s) => arr(s.points).length));
      const labels = Array.from({ length: maxLen }, (_, i) => `${i + 1}`);
      slide.addChart('line', series.map((s) => ({ name: str(s.name), labels, values: arr(s.points).map(num) })), {
        x: 0.7, y: 1.45, w: 11.9, h: 5.4, chartColors: ctx.colors, showLegend: true, legendPos: 'b', showTitle: false,
        catAxisLabelColor: ctx.fg, valAxisLabelColor: ctx.sub, catAxisLineColor: ctx.sub, valAxisLineColor: ctx.sub, lineSize: 3,
      });
      break;
    }
    case 'chart-donut': {
      addTitleBar(slide, title, ctx);
      const slices = arr(c.slices).map(rec);
      slide.addChart('doughnut', [{ name: str(c.unit) || title, labels: slices.map((s) => str(s.label)), values: slices.map((s) => num(s.value)) }], {
        x: 0.7, y: 1.45, w: 11.9, h: 5.4, chartColors: ctx.colors, showLegend: true, legendPos: 'r', showTitle: false, holeSize: 55,
      });
      break;
    }
    case 'table': {
      addTitleBar(slide, title, ctx);
      const cols = strings(c.columns);
      const rowsRaw = arr(c.rows).map((r) => arr(r).map((x) => str(x)));
      const header: PptxTableRow = cols.map((col) => ({ text: col, options: { bold: true, color: 'FFFFFF', fill: { color: ctx.accent } } }));
      const body: PptxTableRow[] = rowsRaw.map((r) => cols.map((_, i) => ({ text: r[i] ?? '', options: { color: ctx.fg, fill: { color: ctx.surface } } })));
      slide.addTable([header, ...body], { x: 0.7, y: 1.55, w: 11.9, border: { type: 'solid', color: ctx.sub, pt: 0.75 }, fontFace: 'Arial', fontSize: 14 });
      break;
    }
    case 'stats': {
      addTitleBar(slide, title, ctx);
      const stats = arr(c.stats).map(rec);
      const n = Math.max(1, stats.length);
      const bw = (12.1 - 0.3 * (n - 1)) / n;
      stats.forEach((st, i) => {
        const x = 0.6 + i * (bw + 0.3);
        slide.addShape('roundRect', { x, y: 2.25, w: bw, h: 2.9, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        text(slide, str(st.value), { x: x + 0.2, y: 2.6, w: bw - 0.4, h: 1.0, fontSize: 36, bold: true, align: 'center', color: ctx.accent }, ctx);
        text(slide, str(st.label), { x: x + 0.2, y: 3.75, w: bw - 0.4, h: 0.8, fontSize: 15, align: 'center', color: ctx.sub }, ctx);
      });
      break;
    }
    case 'quote': {
      text(slide, `“${str(c.text)}”`, { x: 1.1, y: 2.0, w: 11.1, h: 2.8, fontSize: 32, italic: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.author)) text(slide, `— ${str(c.author)}`, { x: 1.1, y: 5.0, w: 11.1, h: 0.6, fontSize: 18, align: 'center', color: ctx.accent }, ctx);
      break;
    }
    case 'icon-grid': {
      addTitleBar(slide, title, ctx);
      const items = arr(c.items).map(rec);
      const cols = Math.min(3, Math.max(1, items.length));
      items.forEach((it, i) => {
        const col = i % cols; const row = Math.floor(i / cols);
        const x = 0.6 + col * 4.15; const y = 1.6 + row * 2.65;
        slide.addShape('roundRect', { x, y, w: 3.85, h: 2.35, fill: { color: ctx.surface }, line: { color: ctx.accent, width: 1 } });
        // Icon name is rendered as text glyph placeholder (no raster icon).
        text(slide, `• ${str(it.icon)}`, { x: x + 0.3, y: y + 0.25, w: 3.25, h: 0.45, fontSize: 13, color: ctx.accent }, ctx);
        text(slide, str(it.title), { x: x + 0.3, y: y + 0.72, w: 3.25, h: 0.55, fontSize: 18, bold: true }, ctx);
        if (str(it.desc)) text(slide, str(it.desc), { x: x + 0.3, y: y + 1.3, w: 3.25, h: 0.85, fontSize: 12, color: ctx.sub }, ctx);
      });
      break;
    }
    case 'closing': {
      text(slide, title, { x: 0.8, y: 2.45, w: 11.7, h: 1.4, fontSize: 42, bold: true, align: 'center', valign: 'middle' }, ctx);
      if (str(c.cta)) text(slide, str(c.cta), { x: 1.3, y: 4.1, w: 10.7, h: 0.8, fontSize: 20, align: 'center', color: ctx.accent }, ctx);
      break;
    }
    default: {
      addTitleBar(slide, title || slideSpec.layout, ctx);
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
