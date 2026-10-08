import type { DeckTheme } from './deck.ts';

/**
 * Bundled slide templates: a template is theme-token data (palette +
 * typography mapped to semantic roles), chosen before generation and
 * applied to the deck deterministically — the Presenton lesson that a
 * template is a layout/theme package the outline is poured into, not a
 * per-slide improvisation. Templates ship with the install; nothing is
 * fetched at task time (Farid's zero-runtime-download rule).
 */
export type SlideTemplate = {
  id: string;
  name: string;
  description: string;
  theme: DeckTheme;
};

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    id: 'general',
    name: 'General',
    description: 'Daedalus default: ungu di atas gelap, bersih dan netral untuk topik apa pun.',
    theme: { dark: true, accent: '#6b50ff', background: '#201f26', surface: '#2d2c36', text: '#ecebf0', muted: '#bfbcc8', headingFont: 'Arial', bodyFont: 'Arial' },
  },
  {
    id: 'midnight-scholar',
    name: 'Midnight Scholar',
    description: 'Hijau gelap + emas, serif klasik: khidmat dan ilmiah (agama, sejarah, akademik).',
    theme: { dark: true, accent: '#c59a46', background: '#1b382b', surface: '#24473a', text: '#f9f7f2', muted: '#cfc9b8', headingFont: 'Georgia', bodyFont: 'Arial' },
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'Terang, navy + hijau: laporan, sains, dan briefing berbasis data.',
    theme: { dark: false, accent: '#2e7d5c', background: '#f4f6f0', surface: '#ffffff', text: '#1e293b', muted: '#5b6b5e', headingFont: 'Trebuchet MS', bodyFont: 'Arial' },
  },
  {
    id: 'mono-luxe',
    name: 'Mono Luxe',
    description: 'Hitam + emas, serif dramatis: pameran, budaya, presentasi premium.',
    theme: { dark: true, accent: '#d4af37', background: '#121619', surface: '#1c2227', text: '#f3ead3', muted: '#b8ab8d', headingFont: 'Georgia', bodyFont: 'Georgia' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Biru laut + teal: teknologi, produk, dan topik masa depan.',
    theme: { dark: true, accent: '#2dd4bf', background: '#0e2a47', surface: '#16395e', text: '#e8f4ff', muted: '#a9c6de', headingFont: 'Verdana', bodyFont: 'Arial' },
  },
];

export function getSlideTemplate(id: string | undefined): SlideTemplate | undefined {
  if (!id) return undefined;
  return SLIDE_TEMPLATES.find((template) => template.id === id);
}

export function listSlideTemplates(): SlideTemplate[] {
  return SLIDE_TEMPLATES;
}
