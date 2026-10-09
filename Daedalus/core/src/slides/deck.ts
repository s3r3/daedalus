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
};

export type Slide = {
  id: string;
  layout: string;
  content: Record<string, unknown>;
  notes?: string;
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
