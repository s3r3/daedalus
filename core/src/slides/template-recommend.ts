/**
 * Rekomendasi template cerdas (Dae Captain 9.4): the assistant has an
 * opinion, not a passive catalog. A deterministic pick from the outline's
 * own signals — text volume, image/data ratio, presentation register from
 * keywords — with a one-line reason. No LLM, no downloads; the templates
 * are the bundled designs in slides/builtin-templates.ts.
 */

export type TemplateRecommendation = {
  /** Id of a bundled design template (slides/builtin-templates.ts). */
  templateId: string;
  /** One-line, human-readable reason shown next to the badge. */
  reason: string;
};

export type RecommendSlideInput = {
  layout: string;
  content: Record<string, unknown>;
};

const IMAGE_LAYOUTS = new Set([
  'image-side',
  'hero-image-caption',
  'mosaic',
  'split-visual-quote',
  'logo-wall',
]);

const DATA_LAYOUTS = new Set([
  'chart-bar',
  'chart-line',
  'chart-donut',
  'table',
  'stats',
  'big-stat',
  'kpi-band',
  'ranking-list',
  'pricing-tiers',
  'stat-duel',
]);

const FORMAL_RE = /sidang|skripsi|tesis|disertasi|seminar|proposal|akademik|penelitian|kajian|ilmiah/i;
const TECH_RE = /teknologi|software|aplikasi|digital|startup|\bAI\b|robot|komputasi/i;
const CREATIVE_RE = /workshop|santai|komunitas|kreatif|festival|ulang\s?tahun|kelas|pelatihan|ekskul/i;

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectText(v, out);
  }
}

function hasImageContent(content: Record<string, unknown>): boolean {
  let found = false;
  const walk = (value: unknown): void => {
    if (found) return;
    if (typeof value === 'string') {
      if (/\.(png|jpe?g|webp|gif|svg)$/i.test(value.trim())) found = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'image' && typeof v === 'string' && v.trim()) {
          found = true;
          return;
        }
        walk(v);
      }
    }
  };
  walk(content);
  return found;
}

export function recommendTemplate(input: {
  title?: string;
  slides: RecommendSlideInput[];
}): TemplateRecommendation {
  const slides = input.slides ?? [];
  if (slides.length === 0) {
    return { templateId: 'standar', reason: 'Belum ada outline — mulai dari template netral.' };
  }
  const texts: string[] = [];
  if (input.title) texts.push(input.title);
  for (const slide of slides) collectText(slide.content, texts);
  const text = texts.join(' ');
  const avgChars = text.length / slides.length;
  const imageRatio = slides.filter((s) => IMAGE_LAYOUTS.has(s.layout) || hasImageContent(s.content)).length / slides.length;
  const dataRatio = slides.filter((s) => DATA_LAYOUTS.has(s.layout)).length / slides.length;

  if (FORMAL_RE.test(text)) {
    return {
      templateId: 'cendekia',
      reason: 'Cocok untuk sidang skripsi — formal dan bersih.',
    };
  }
  if (imageRatio >= 0.3) {
    return {
      templateId: 'galeri',
      reason: 'Banyak slide bergambar — Galeri Mono memberi ruang lega untuk visual.',
    };
  }
  if (TECH_RE.test(text)) {
    return {
      templateId: 'arena',
      reason: 'Topik teknologi/produk — Arena Neon berani dan cepat.',
    };
  }
  if (dataRatio >= 0.4 || avgChars > 500) {
    return {
      templateId: 'editorial',
      reason: 'Padat teks dan data — Editorial Klasik menjaga keterbacaan.',
    };
  }
  if (CREATIVE_RE.test(text)) {
    return {
      templateId: 'verve',
      reason: 'Nada santai dan kreatif — Verve Pop lebih hidup.',
    };
  }
  return {
    templateId: 'standar',
    reason: 'Netral dan aman untuk topik apa pun.',
  };
}
