import { join } from 'node:path';

export type DeckTheme = {
  accent?: string;
  dark?: boolean;
  /** Template tokens (slides/templates.ts). All optional; renderers fall back to the built-in palette. Hex colors as #rrggbb. */
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  headingFont?: string;
  bodyFont?: string;
  /** Id of the bundled template these tokens came from (set_deck_theme/create_deck templateId). */
  templateId?: string;
  /**
   * Id of the imported PPT template these tokens were extracted from
   * (slides/pptx-template.ts, stored under .daedalus/slide-templates/).
   * Mutually exclusive with templateId in practice: applying one kind
   * replaces the whole theme, so the last applied pick wins.
   */
  customTemplateId?: string;
  /**
   * Deck-asset basename (deck/assets/) painted behind the slide content:
   * the background image extracted from an imported PPT template, copied
   * into the deck's assets when the template was applied. Renderers fall
   * back to the background color whenever it is absent or unreadable.
   */
  backgroundImage?: string;
  /**
   * Chart series palette (accent1..accent6 of an imported template).
   * Renderers fall back to the accent + built-in series when absent.
   */
  series?: string[];
};

/**
 * User-chosen canvas placement for one named block of a slide (the Web
 * editor's drag): fractions of the slide box (0..1), so the same values
 * drive the HTML canvas and the PPTX exporter (13.333x7.5in). `w`/`h`
 * are optional — renderers fall back to the layout's natural size.
 * Blocks are keyed by the names `layoutBlockKeys` (slides/layouts.ts)
 * returns for the layout: 'title', 'points', 'step-0', 'item-2', ...
 * A slide without `positions` renders exactly as the layout dictates.
 */
export type BlockPosition = {
  x: number;
  y: number;
  w?: number;
  h?: number;
};

/**
 * Reference to one parsed page of an imported PPT template
 * (slides/pptx-pages.ts): this slide is poured into that page's design.
 * Present exactly when the slide's layout is 'template-page' (enforced
 * by validateDeck). The slide's words live in content.slots, keyed by
 * the page's slot keys: strings for both kinds — text copy for text
 * slots, a deck asset name (or '' for the template's own image) for
 * image slots.
 */
export type SlideTemplateRef = {
  templateId: string;
  /** 0-based index into the template's pages[]. */
  page: number;
};

export type Slide = {
  id: string;
  layout: string;
  content: Record<string, unknown>;
  notes?: string;
  /** Drag placements from the canvas editor, keyed by block name. */
  positions?: Record<string, BlockPosition>;
  /**
   * Generation-pipeline state (slides/pipeline.ts): 'skeleton' is an
   * outline placeholder whose content is still the layout defaults plus
   * the outline title, awaiting the fill stage. Absent (ordinary slides,
   * hand-edited decks) or 'filled' means real content. The fill stage
   * resumes exactly the skeleton slides, which is what makes a partial
   * generation recoverable across tool calls and tasks.
   */
  status?: 'skeleton' | 'filled';
  /** Outline key message captured when the skeleton was created; guides the fill stage. */
  keyMessage?: string;
  /** Imported-PPT-template page this slide is poured into (layout 'template-page'). */
  templateRef?: SlideTemplateRef;
};

export type DeckSpec = {
  version: 1;
  id: string;
  title: string;
  theme: DeckTheme;
  slides: Slide[];
};

export type DeckIssue = {
  slideId?: string;
  layout?: string;
  field?: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

export const DECK_DIRNAME = 'deck';
export const DECK_FILENAME = 'deck.json';
export const DECK_ASSETS_DIRNAME = 'assets';
export const MAX_SLIDES = 40;
export const LONG_TEXT_CHARS = 140;

export function deckPaths(root: string): { dir: string; file: string; assetsDir: string } {
  const dir = join(root, DECK_DIRNAME);
  return {
    dir,
    file: join(dir, DECK_FILENAME),
    assetsDir: join(dir, DECK_ASSETS_DIRNAME),
  };
}

/** Relative (workspace) paths, for messages/tools. */
export function deckRelativePaths(): { dir: string; file: string; assetsDir: string } {
  return {
    dir: DECK_DIRNAME,
    file: `${DECK_DIRNAME}/${DECK_FILENAME}`,
    assetsDir: `${DECK_DIRNAME}/${DECK_ASSETS_DIRNAME}`,
  };
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'deck';
}
