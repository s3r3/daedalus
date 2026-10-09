import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deckPaths, LONG_TEXT_CHARS, MAX_SLIDES, type DeckIssue, type DeckSpec, type Slide } from './deck.ts';
import { getLayout, layoutBlockKeys, validateSlideContent } from './layouts.ts';

export { MAX_SLIDES };

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  try {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }
}

export function newDeckId(): string { return uniqueId('deck'); }
export function newSlideId(): string { return uniqueId('slide'); }

export function newDeck(title: string): DeckSpec {
  return { version: 1, id: newDeckId(), title, theme: {}, slides: [] };
}

export async function ensureDeckDir(root: string): Promise<{ dir: string; file: string; assetsDir: string }> {
  const paths = deckPaths(root);
  await mkdir(paths.assetsDir, { recursive: true });
  return paths;
}

export async function readDeck(root: string): Promise<DeckSpec | null> {
  const paths = deckPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`deck.json is not valid JSON (${paths.file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isDeckShape(parsed)) {
    throw new Error(`deck.json has an invalid shape (${paths.file}): expected {version:1, id:string, title:string, theme:object, slides:array}`);
  }
  return parsed;
}

function isDeckShape(v: unknown): v is DeckSpec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  if (d.version !== 1) return false;
  if (typeof d.id !== 'string' || typeof d.title !== 'string') return false;
  if (typeof d.theme !== 'object' || d.theme === null || Array.isArray(d.theme)) return false;
  if (!Array.isArray(d.slides)) return false;
  for (const s of d.slides as unknown[]) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
    const sl = s as Record<string, unknown>;
    if (typeof sl.id !== 'string' || typeof sl.layout !== 'string') return false;
    if (typeof sl.content !== 'object' || sl.content === null || Array.isArray(sl.content)) return false;
    if (sl.notes !== undefined && typeof sl.notes !== 'string') return false;
  }
  return true;
}

export async function writeDeck(root: string, deck: DeckSpec): Promise<void> {
  const paths = await ensureDeckDir(root);
  const tmp = `${paths.file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.file);
}

export type ValidateDeckOptions = {
  assetExists?: (name: string) => boolean;
  /** Workspace root, used for the default fs asset check when assetExists is not given. */
  root?: string;
};

/** Per-layout item caps: beyond these a slide stops reading as a slide (mk-present's density doctrine — overflow splits the slide, never compresses it). */
const DENSITY_CAPS: Record<string, number> = {
  bullets: 6,
  'two-column': 5,
  'icon-grid': 6,
  stats: 4,
  timeline: 6,
  'diagram-flow': 6,
  'diagram-cycle': 6,
  'diagram-hierarchy': 6,
  comparison: 5,
  versus: 5,
  'chart-bar': 8,
  'chart-line': 8,
  'chart-donut': 6,
  'numbered-steps': 6,
  'chevron-process': 6,
  'diagram-pyramid': 4,
  roadmap: 4,
  'matrix-quadrant': 4,
  'profile-cards': 4,
  glossary: 6,
  mosaic: 4,
  'big-stat': 3,
  'code-focus': 5,
  'agenda-toc': 7,
  'kpi-band': 4,
  funnel: 4,
  'gantt-bars': 6,
  'org-chart': 4,
  faq: 5,
  'steps-cards': 4,
  'logo-wall': 8,
  'year-markers': 5,
  'waterfall-steps': 4,
  'feature-highlight': 6,
  callout: 4,
  'ranking-list': 5,
  'quote-wall': 3,
};

function densityIssues(slide: Slide): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const cap = DENSITY_CAPS[slide.layout] ?? 8;
  const lists: Array<{ field: string; items: unknown[] }> = [];
  const content = slide.content ?? {};
  for (const field of ['points', 'items', 'steps', 'events', 'stats', 'cards', 'tiers', 'people', 'phases', 'terms', 'quadrants', 'tiles', 'kpis', 'stages', 'bars', 'reports', 'logos', 'years', 'entries', 'quotes', 'checks']) {
    if (Array.isArray(content[field])) lists.push({ field, items: content[field] as unknown[] });
  }
  for (const side of ['left', 'right', 'pros', 'cons'] as const) {
    const sideContent = content[side] as { points?: unknown } | undefined;
    if (sideContent && Array.isArray(sideContent.points)) lists.push({ field: `${side}.points`, items: sideContent.points as unknown[] });
  }
  if (slide.layout === 'table' && Array.isArray(content.rows) && (content.rows as unknown[]).length > 8) {
    issues.push({ slideId: slide.id, layout: slide.layout, field: 'rows', code: 'too-dense', message: `slide ${slide.id}: table has ${(content.rows as unknown[]).length} rows (max 8) — split it into two slides`, severity: 'error' });
  }
  for (const { field, items } of lists) {
    if (items.length > cap) {
      issues.push({ slideId: slide.id, layout: slide.layout, field, code: 'too-dense', message: `slide ${slide.id}: ${field} has ${items.length} items (max ${cap} for ${slide.layout}) — split the content across two slides instead of compressing it`, severity: 'error' });
    }
    for (const item of items) {
      const text = typeof item === 'string' ? item : typeof (item as { text?: unknown })?.text === 'string' ? String((item as { text: string }).text) : typeof (item as { title?: unknown })?.title === 'string' ? String((item as { title: string }).title) : '';
      if (text.length > LONG_TEXT_CHARS) {
        issues.push({ slideId: slide.id, layout: slide.layout, field, code: 'text-long', message: `slide ${slide.id}: a ${field} item is ${text.length} chars (over ${LONG_TEXT_CHARS}) — shorten it or split the slide`, severity: 'warning' });
        break;
      }
    }
  }
  const title = content.title;
  if (typeof title === 'string' && title.length > 110) {
    issues.push({ slideId: slide.id, layout: slide.layout, field: 'title', code: 'text-long', message: `slide ${slide.id}: title is ${title.length} chars (over 110) — shorten it`, severity: 'warning' });
  }
  return issues;
}

/**
 * Drag placements (slide.positions) must name real blocks of the layout
 * and stay inside the slide: fractions in [0,1], sizes in (0,1], never
 * spilling past the far edge. Garbage here would silently misplace
 * content in both renderers, so it is an error, not a warning — except
 * an unknown block key, which renderers simply ignore (warning).
 */
function positionIssues(slide: Slide): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const positions = slide.positions;
  if (positions === undefined) return issues;
  const bad = (field: string, message: string): void => {
    issues.push({ slideId: slide.id, layout: slide.layout, field, code: 'invalid-position', message: `slide ${slide.id}: ${message}`, severity: 'error' });
  };
  if (typeof positions !== 'object' || positions === null || Array.isArray(positions)) {
    bad('positions', 'positions must be an object keyed by block name');
    return issues;
  }
  const known = new Set(layoutBlockKeys(slide.layout, slide.content ?? {}));
  for (const [key, pos] of Object.entries(positions)) {
    const field = `positions.${key}`;
    if (!known.has(key)) {
      issues.push({ slideId: slide.id, layout: slide.layout, field, code: 'unknown-block', message: `slide ${slide.id}: positions names block "${key}", which layout ${slide.layout} does not have — the placement is ignored`, severity: 'warning' });
      continue;
    }
    if (typeof pos !== 'object' || pos === null || Array.isArray(pos)) {
      bad(field, `${field} must be an object {x, y, w?, h?} of slide fractions`);
      continue;
    }
    const { x, y, w, h } = pos as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    const frac = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    if (!frac(x) || !frac(y)) {
      bad(field, `${field} needs finite x and y fractions in [0, 1]`);
      continue;
    }
    if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w > 0 && w <= 1)) {
      bad(field, `${field}.w must be a fraction in (0, 1]`);
      continue;
    }
    if (h !== undefined && !(typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= 1)) {
      bad(field, `${field}.h must be a fraction in (0, 1]`);
      continue;
    }
    if ((x as number) + (typeof w === 'number' ? w : 0) > 1.001 || (y as number) + (typeof h === 'number' ? h : 0) > 1.001) {
      bad(field, `${field} spills past the slide edge (x + w and y + h must stay within 1)`);
    }
  }
  return issues;
}

export function validateDeck(deck: DeckSpec, opts: ValidateDeckOptions = {}): DeckIssue[] {
  const issues: DeckIssue[] = [];
  if (!deck || typeof deck !== 'object') {
    return [{ code: 'invalid-deck', message: 'deck must be an object', severity: 'error' }];
  }
  if (deck.version !== 1) issues.push({ code: 'invalid-version', message: `deck version must be 1, got ${String(deck.version)}`, severity: 'error' });
  if (typeof deck.title !== 'string' || deck.title.trim().length === 0) issues.push({ code: 'missing-title', field: 'title', message: 'deck title is required', severity: 'error' });
  if (!Array.isArray(deck.slides)) {
    issues.push({ code: 'invalid-slides', field: 'slides', message: 'deck slides must be an array', severity: 'error' });
    return issues;
  }
  if (deck.slides.length > MAX_SLIDES) {
    issues.push({ code: 'too-many-slides', field: 'slides', message: `deck has ${deck.slides.length} slides (max ${MAX_SLIDES})`, severity: 'warning' });
  }
  const root = opts.root;
  const assetExists = opts.assetExists ?? (root ? (name: string) => existsSync(join(deckPaths(root).assetsDir, basename(name))) : undefined);

  // Slide identity integrity: every later lookup (update/move/delete by
  // id, the editor, the exporter) assumes ids exist and are unique, so a
  // duplicated or missing id is deck corruption, not a style issue.
  const seenIds = new Set<string>();
  for (const slide of deck.slides as Slide[]) {
    if (typeof slide.id !== 'string' || slide.id.trim().length === 0) {
      issues.push({ slideId: slide.id, layout: slide.layout, code: 'missing-slide-id', message: `slide with layout "${slide.layout}" has no usable id — every slide needs a unique id`, severity: 'error' });
    } else if (seenIds.has(slide.id)) {
      issues.push({ slideId: slide.id, layout: slide.layout, code: 'duplicate-slide-id', message: `slide id "${slide.id}" appears more than once — ids must be unique or edits will hit the wrong slide`, severity: 'error' });
    } else {
      seenIds.add(slide.id);
    }
  }

  for (const slide of deck.slides as Slide[]) {
    const layout = getLayout(slide.layout);
    if (!layout) {
      issues.push({ slideId: slide.id, layout: slide.layout, code: 'unknown-layout', message: `slide ${slide.id}: unknown layout "${slide.layout}"`, severity: 'error' });
      continue;
    }
    for (const iss of validateSlideContent(layout, slide.content)) {
      issues.push({ ...iss, slideId: slide.id });
    }
    issues.push(...densityIssues(slide));
    issues.push(...positionIssues(slide));
    if (slide.layout === 'image-side' && assetExists) {
      const image = slide.content.image;
      if (typeof image === 'string' && image.length > 0 && !assetExists(image)) {
        issues.push({ slideId: slide.id, layout: slide.layout, field: 'image', code: 'missing-asset', message: `slide ${slide.id}: image asset not found in deck/assets: ${image}`, severity: 'error' });
      }
    }
  }
  return issues;
}

export function summarizeDeck(deck: DeckSpec): string {
  const lines: string[] = [];
  lines.push(`Deck: ${deck.title} (${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'})`);
  deck.slides.forEach((slide, i) => {
    const raw = slide.content.title ?? slide.content.text ?? '';
    const snippet = typeof raw === 'string' ? raw : String(raw ?? '');
    const short = snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet;
    lines.push(`${i + 1}. [${slide.layout}] "${short}" (${slide.id})`);
  });
  if (deck.slides.length === 0) lines.push('(no slides yet)');
  return lines.join('\n');
}
