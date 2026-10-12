import type { DeckSpec, Slide } from './deck.ts';
import { builtinKindOfLayout } from './builtin-templates.ts';
import { assignTemplatePages } from './pipeline.ts';
import {
  templatePageImageSlots,
  templatePageTextSlots,
  validateTemplateSlideSlots,
  type PptxTemplatePage,
  type PptxTemplatePageKind,
} from './pptx-pages.ts';
import type { PptxTemplate } from './pptx-template.ts';

/**
 * Export-time pour: re-express an existing deck inside an imported PPT
 * template's page designs WITHOUT any model call. This is what the
 * stage's Export picker runs for "ekspor dengan template impor": each
 * slide's words (title, body lines, a chosen picture) are projected
 * onto the template pages of the matching kind, code maps slides to
 * pages with the same least-used discipline as generation, and the
 * resulting template-page deck goes through the ordinary export — the
 * v3 clone-and-rewrite path when the template kept its source file.
 *
 * Truth-in-advertising: the projection is structural, not semantic. A
 * slide's title goes into the page's largest text slot, its remaining
 * words fill the other text slots in order, lines that exceed a slot's
 * capacity are truncated and COUNTED in the result note, and fields
 * with no textual home (icons, numbers, layout chrome) do not travel.
 */

export type SlideWords = {
  title: string;
  lines: string[];
  /** Deck-asset image name the slide already references, when any. */
  image?: string;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Content fields that are layout machinery, not words for a template box. */
const NON_WORD_KEYS = new Set(['image', 'icon', 'side', 'language', 'deltaUp', 'featured', 'imageFile']);

function objectLines(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) objectLines(item, out);
    return;
  }
  const record = rec(value);
  if (Object.keys(record).length === 0) return;
  const main = str(record.title ?? record.heading ?? record.label ?? record.name ?? record.term ?? record.q ?? record.when ?? record.year ?? record.value);
  const subs = ['desc', 'definition', 'a', 'text', 'note', 'role', 'caption', 'alt']
    .map((key) => str(record[key]))
    .filter((s) => s.trim().length > 0);
  const head = main && subs.length > 0 ? `${main} — ${subs.join(' ')}` : main || subs.join(' ');
  if (head.trim()) out.push(head);
  if (Array.isArray(record.points)) for (const point of record.points as unknown[]) objectLines(point, out);
  if (Array.isArray(record.items)) for (const item of record.items as unknown[]) objectLines(item, out);
}

/**
 * The words of one slide, in reading order: its title first, then every
 * textual field the layout carries (nested column/step/tier words join
 * as one line per item), plus the deck-asset image it references.
 */
export function extractSlideWords(slide: Slide): SlideWords {
  const content = rec(slide.content);
  if (slide.templateRef) {
    const slots = rec(content.slots);
    const images: string[] = [];
    const lines: string[] = [];
    for (const value of Object.values(slots)) {
      const text = str(value);
      if (!text) continue;
      if (IMAGE_FILE.test(text)) images.push(text);
      else lines.push(text);
    }
    return {
      title: str(content.title) || lines[0] || '',
      lines: str(content.title) ? lines : lines.slice(1),
      ...(images[0] ? { image: images[0] } : {}),
    };
  }
  const title = str(content.title ?? content.text ?? content.quote);
  const lines: string[] = [];
  let image: string | undefined;
  const rawImage = str(content.image);
  if (rawImage) image = rawImage;
  if (Array.isArray(content.tiles)) {
    for (const tile of content.tiles as unknown[]) {
      const tileRec = rec(tile);
      if (!image && str(tileRec.image)) image = str(tileRec.image);
    }
  }
  for (const [key, value] of Object.entries(content)) {
    if (key === 'title' || key === 'text' || key === 'quote' || NON_WORD_KEYS.has(key)) continue;
    if (key === 'tiles') {
      for (const tile of value as unknown[]) {
        const tileRec = rec(tile);
        const caption = str(tileRec.caption ?? tileRec.alt);
        if (caption) lines.push(caption);
      }
      continue;
    }
    objectLines(value, lines);
  }
  // Big-number slides carry their payload in value+label, not title.
  if (slide.layout === 'big-stat' || slide.layout === 'stat-duel') {
    const valueLine = [str(content.value), str(content.label)].filter(Boolean).join(' — ');
    if (valueLine) lines.unshift(valueLine);
  }
  if (slide.layout === 'quote' || slide.layout === 'testimonial') {
    const quote = str(content.text ?? content.quote);
    if (quote && quote !== title) lines.unshift(quote);
    const author = str(content.author ?? content.name);
    if (author) lines.push(author);
  }
  return { title, lines: lines.filter((line, i) => line !== title || i > 0), ...(image ? { image } : {}) };
}

function fitToCap(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const cut = text.slice(0, Math.max(0, cap - 1));
  const lastSpace = cut.lastIndexOf(' ');
  return { text: `${(lastSpace > cap * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`, truncated: true };
}

export type PourDeckResult = {
  deck: DeckSpec;
  /** Text slots whose words had to be truncated to the template box capacity. */
  truncatedSlots: number;
  /** Body lines that found no slot at all (no text slot left unfilled). */
  droppedLines: number;
};

/**
 * Build the template-page twin of `deck` for `template` (not written to
 * disk): one template-page slide per deck slide, pages assigned by
 * kind with the generation discipline, words fitted per slot capacity.
 * Throws when the template carries no parsed pages.
 */
export function pourDeckIntoTemplate(deck: DeckSpec, template: PptxTemplate): PourDeckResult {
  const pages = template.pages;
  if (!pages || pages.length === 0) {
    throw new Error(`template "${template.id}" tidak punya desain halaman terbaca — impor ulang berkas .pptx-nya untuk ekspor dengan template ini`);
  }
  const roleOf = (slide: Slide, index: number): PptxTemplatePageKind => {
    if (index === 0) return 'cover';
    const kind = builtinKindOfLayout(slide.layout);
    if (kind === 'toc') return 'toc';
    if (kind === 'section') return 'section';
    if (kind === 'closing') return 'closing';
    return 'content';
  };
  const pageIndexes = assignTemplatePages(deck.slides.map((slide, i) => ({ role: roleOf(slide, i) })), pages);
  let truncatedSlots = 0;
  let droppedLines = 0;

  const slides: Slide[] = deck.slides.map((slide, index) => {
    const page: PptxTemplatePage = pages[pageIndexes[index]!]!;
    const words = extractSlideWords(slide);
    const textSlots = templatePageTextSlots(page);
    const bySize = [...textSlots].sort((a, b) => b.fontSizePt - a.fontSizePt);
    const slots: Record<string, string> = {};
    const [titleSlot, ...bodySlots] = bySize;
    if (titleSlot) {
      const fitted = fitToCap(words.title, titleSlot.maxChars);
      slots[titleSlot.key] = fitted.text;
      if (fitted.truncated) truncatedSlots += 1;
    }
    // Body words fill the remaining text slots in page order, one
    // accumulated block per slot; whatever still overflows the last
    // slot is truncated there and counted, never silently lost count.
    let remaining = [...words.lines];
    bodySlots.forEach((slot, slotIndex) => {
      if (remaining.length === 0) {
        slots[slot.key] = '';
        return;
      }
      if (slotIndex === bodySlots.length - 1) {
        const joined = remaining.join('\n');
        const fitted = fitToCap(joined, slot.maxChars);
        slots[slot.key] = fitted.text;
        if (fitted.truncated) truncatedSlots += 1;
        remaining = [];
        return;
      }
      const taken: string[] = [];
      let size = 0;
      while (remaining.length > 0) {
        const line = remaining[0]!;
        const nextSize = size === 0 ? line.length : size + 1 + line.length;
        if (nextSize > slot.maxChars && taken.length > 0) break;
        taken.push(line);
        remaining.shift();
        size = nextSize;
      }
      slots[slot.key] = taken.join('\n');
    });
    if (remaining.length > 0) droppedLines += remaining.length;
    for (const imageSlot of templatePageImageSlots(page)) {
      slots[imageSlot.key] = words.image ?? '';
    }
    const issues = validateTemplateSlideSlots(page, slots);
    if (issues.length > 0) {
      throw new Error(`menuangkan deck ke template "${template.id}" gagal di slide ${index + 1}: ${issues.join('; ')}`);
    }
    return {
      id: slide.id,
      layout: 'template-page',
      content: { title: words.title, slots },
      ...(slide.notes ? { notes: slide.notes } : {}),
      status: 'filled' as const,
      templateRef: { templateId: template.id, page: pageIndexes[index]! },
    };
  });

  return {
    deck: { ...deck, slides },
    truncatedSlots,
    droppedLines,
  };
}
