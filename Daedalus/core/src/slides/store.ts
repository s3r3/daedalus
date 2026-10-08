import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deckPaths, MAX_SLIDES, type DeckIssue, type DeckSpec, type Slide } from './deck.ts';
import { getLayout, validateSlideContent } from './layouts.ts';

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

  for (const slide of deck.slides as Slide[]) {
    const layout = getLayout(slide.layout);
    if (!layout) {
      issues.push({ slideId: slide.id, layout: slide.layout, code: 'unknown-layout', message: `slide ${slide.id}: unknown layout "${slide.layout}"`, severity: 'error' });
      continue;
    }
    for (const iss of validateSlideContent(layout, slide.content)) {
      issues.push({ ...iss, slideId: slide.id });
    }
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
