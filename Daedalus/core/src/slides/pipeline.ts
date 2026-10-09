import type { LLMProvider, Message } from '../providers/llm/types.ts';
import { MAX_SLIDES, type DeckIssue, type DeckSpec, type Slide } from './deck.ts';
import { getLayout, LAYOUTS, summarizeLayoutSchema, validateSlideContent, type LayoutDef } from './layouts.ts';
import { newDeck, newSlideId, readDeck, validateDeck, writeDeck } from './store.ts';
import { getSlideTemplate, SLIDE_TEMPLATES } from './templates.ts';
import { applyPptxTemplateTheme, getPptxTemplate, type PptxTemplate } from './pptx-template.ts';
import {
  templatePageTextSlots,
  validateTemplateSlideSlots,
  type PptxTemplatePage,
  type PptxTemplatePageKind,
  type PptxTextSlot,
} from './pptx-pages.ts';
import { exportDeckToPptx } from './export-pptx.ts';

/**
 * Slide-domain generation pipeline: the Slide backend does NOT inherit
 * the agentic-coding loop for generation (Farid's mandate: "desain saja
 * bukan backend"). Sequencing lives here, in code — brief → outline (one
 * structured model call, count locked) → per-slide fill (one model call
 * per slide, schema-bound) → validateDeck → export. The model only ever
 * fills JSON slots; it never chooses the next step, touches the
 * filesystem, or decides the deck is done. The agent loop remains for
 * interactive editing and chat follow-ups around this pipeline.
 *
 * Failure doctrine: a stage retries invalid model output with the
 * verbatim issues appended (Presenton pattern), at most
 * MAX_STAGE_ATTEMPTS times, and then reports the unit failed — content
 * is never fabricated. Every filled slide is persisted immediately, so
 * a partial deck is resumable: skeleton slides are exactly what a later
 * fill pass picks up, and a partial deck is never exported.
 */

export const MAX_STAGE_ATTEMPTS = 3;

export class SlidePipelineError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'SlidePipelineError';
    this.issues = issues;
  }
}

export type DeckBrief = {
  topic: string;
  slideCount?: number;
  language?: string;
  templateId?: string;
  /**
   * Imported PPT template (Template dari PPT panel) to generate with:
   * when it has parsed pages, the deck is poured into those designs and
   * only the words are generated; skin-only templates fall back to the
   * v1 skin path (catalog layouts + extracted palette/fonts).
   */
  customTemplateId?: string;
  /** Objective / audience, when the composer or user supplied one. */
  purpose?: string;
};

export type NormalizedBrief = Required<Pick<DeckBrief, 'topic' | 'slideCount'>> & Omit<DeckBrief, 'topic' | 'slideCount'>;

export type OutlineItem = {
  title: string;
  layoutId: string;
  keyMessage: string;
};

export type SlideFillFailure = {
  slideId: string;
  layout: string;
  title: string;
  issues: string[];
};

export type ExportInfo = {
  path: string;
  bytes: number;
  slides: number;
};

export type OutlineStageResult = {
  deck: DeckSpec;
  outline: OutlineItem[];
  createdDeck: boolean;
};

export type FillStageResult = {
  deck: DeckSpec;
  filledNow: string[];
  failures: SlideFillFailure[];
  deckIssues: DeckIssue[];
  exported?: ExportInfo;
  exportError?: string;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** Tolerant JSON extraction: fenced block, whole-text parse, then outermost span. */
function extractJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((i) => i >= 0).sort((a, b) => a - b);
  if (starts.length > 0) {
    const start = starts[0]!;
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next shape */ }
  }
  return undefined;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/**
 * One structured stage call: the model answers, the answer is parsed
 * and validated locally, and invalid output is retried with the issues
 * (and the offending output) appended verbatim — the stage, not the
 * model, owns correctness. Throws SlidePipelineError after the last
 * attempt; never invents a fallback value.
 */
export async function structuredCall<T>(
  provider: LLMProvider,
  system: string,
  user: string,
  validate: (value: unknown) => Verdict<T>,
  signal?: AbortSignal,
): Promise<T> {
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let issues: string[] = ['model produced no parseable JSON'];
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await provider.chat(messages, undefined, signal ? { signal } : undefined);
    } catch (error) {
      // A provider-level failure (empty response, transient 5xx) is
      // retried inside the stage like invalid output — the stage owns
      // resilience; the caller sees only the final verdict. An aborted
      // request is never retried.
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      issues = [`the model request failed: ${message}`];
      if (attempt < MAX_STAGE_ATTEMPTS) {
        messages.push({
          role: 'user',
          content: `The previous request failed (${message}). Return the corrected JSON only — no prose, no explanation, no markdown fences.`,
        });
        continue;
      }
      throw new SlidePipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
    }
    const raw = messageText(response.message.content);
    const verdict = validate(extractJsonValue(raw));
    if (verdict.ok) return verdict.value;
    issues = verdict.issues;
    if (attempt < MAX_STAGE_ATTEMPTS) {
      messages.push({ role: 'assistant', content: raw.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: `That output is invalid:\n${verdict.issues.map((i) => `- ${i}`).join('\n')}\n\nReturn corrected JSON only — no prose, no explanation, no markdown fences.`,
      });
    }
  }
  throw new SlidePipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
}

export function normalizeBrief(brief: DeckBrief): NormalizedBrief {
  const topic = typeof brief.topic === 'string' ? brief.topic.trim() : '';
  if (!topic) throw new SlidePipelineError('topic must be a non-empty string');
  if (brief.templateId !== undefined && !getSlideTemplate(brief.templateId)) {
    throw new SlidePipelineError(`unknown templateId "${brief.templateId}" — warna & font bawaan: ${SLIDE_TEMPLATES.map((t) => t.id).join(', ')}`);
  }
  if (brief.templateId && brief.customTemplateId) {
    throw new SlidePipelineError('pilih satu: Warna & Font bawaan atau template dari PPT — keduanya tidak bisa dipakai bersamaan');
  }
  const count = typeof brief.slideCount === 'number' && Number.isFinite(brief.slideCount) ? Math.floor(brief.slideCount) : 8;
  return {
    topic,
    slideCount: Math.max(1, Math.min(MAX_SLIDES, count)),
    ...(typeof brief.language === 'string' && brief.language.trim() ? { language: brief.language.trim() } : {}),
    ...(brief.templateId ? { templateId: brief.templateId } : {}),
    ...(typeof brief.customTemplateId === 'string' && brief.customTemplateId.trim() ? { customTemplateId: brief.customTemplateId.trim() } : {}),
    ...(typeof brief.purpose === 'string' && brief.purpose.trim() ? { purpose: brief.purpose.trim() } : {}),
  };
}

/* ---------------------------------------------------------- outline */

const OUTLINE_SYSTEM = [
  'You are the OUTLINE stage of a slide-generation pipeline. Answer with ONLY a JSON array — no prose, no markdown fences.',
  'Each array item is an object: {"title": string, "layoutId": string, "keyMessage": string}.',
  'Rules:',
  '- The array length is locked to the requested slide_count: exactly that many items, no more, no fewer.',
  '- layoutId must be one of the catalog ids in the request; choose by content fit and vary layouts across the deck. Prefer visual/data layouts (diagram-flow, diagram-cycle, diagram-hierarchy, chevron-process, diagram-pyramid, timeline, roadmap, comparison, versus, matrix-quadrant, chart-bar, chart-line, chart-donut, stats, big-stat, icon-grid, profile-cards, mosaic, table, kpi-band, funnel, gantt-bars, org-chart, pros-cons, pricing-tiers, steps-cards, logo-wall, year-markers, stat-duel, waterfall-steps, ranking-list, hero-image-caption) whenever the content suits them; do not make every slide bullets.',
  '- With slide_count >= 3, the first item uses layoutId "title" and the last uses "closing" (with slide_count 1-2, start with "title").',
  '- Every title and keyMessage is about the requested topic only. Never invent statistics, quotes, dates, names, or facts: a keyMessage states what the slide must establish about the topic, it does not assert fabricated evidence.',
  '- No filler: every slide advances the topic — no generic padding slides. Use image-side only when the topic plainly calls for a photograph the user can supply.',
].join('\n');

function outlineUser(brief: NormalizedBrief): string {
  const lines = [`topic: ${brief.topic}`, `slide_count: ${brief.slideCount}`];
  if (brief.purpose) lines.push(`purpose/audience: ${brief.purpose}`);
  if (brief.language) lines.push(`language: write every title and keyMessage in ${brief.language}`);
  lines.push('layout catalog (id (category): label):');
  // 'template-page' is not a choosable design — it belongs to imported
  // PPT templates and is created only by the template pipeline.
  for (const layout of LAYOUTS) {
    if (layout.id === 'template-page') continue;
    lines.push(`- ${layout.id} (${layout.category}): ${layout.label}`);
  }
  lines.push(`Return exactly ${brief.slideCount} outline items as a JSON array.`);
  return lines.join('\n');
}

const LAYOUT_ID_SET = new Set(LAYOUTS.map((l) => l.id));

function validateOutline(value: unknown, count: number): Verdict<OutlineItem[]> {
  const issues: string[] = [];
  let rawItems: unknown[] | undefined;
  if (Array.isArray(value)) rawItems = value;
  else if (isObj(value)) {
    for (const key of ['slides', 'outline', 'items']) {
      if (Array.isArray(value[key])) { rawItems = value[key] as unknown[]; break; }
    }
  }
  if (!rawItems) return { ok: false, issues: ['output must be a JSON array of outline items (or an object with a "slides" array)'] };
  if (rawItems.length !== count) issues.push(`expected exactly ${count} outline items, got ${rawItems.length}`);
  const items: OutlineItem[] = [];
  rawItems.forEach((raw, i) => {
    if (!isObj(raw)) { issues.push(`item ${i + 1} must be an object {title, layoutId, keyMessage}`); return; }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const layoutId = typeof raw.layoutId === 'string' ? raw.layoutId : typeof raw.layout === 'string' ? raw.layout : '';
    const keyMessage = typeof raw.keyMessage === 'string' ? raw.keyMessage.trim() : '';
    if (!title) issues.push(`item ${i + 1}: title must be a non-empty string`);
    if (layoutId === 'template-page') issues.push(`item ${i + 1}: layoutId "template-page" belongs to imported PPT templates — pick a catalog layout id instead`);
    else if (!LAYOUT_ID_SET.has(layoutId)) issues.push(`item ${i + 1}: unknown layoutId "${layoutId}" — use one of: ${[...LAYOUT_ID_SET].filter((id) => id !== 'template-page').join(', ')}`);
    if (!keyMessage) issues.push(`item ${i + 1}: keyMessage must be a non-empty string stating what the slide establishes`);
    if (title && layoutId !== 'template-page' && LAYOUT_ID_SET.has(layoutId) && keyMessage) items.push({ title, layoutId, keyMessage });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: items };
}

function skeletonContent(layout: LayoutDef, title: string): Record<string, unknown> {
  const content = clone(layout.defaults);
  if ('title' in layout.schema.properties) content.title = title;
  return content;
}

/* ------------------------------------------- template mode (PPT pages)
 * When an imported PPT template with parsed pages is selected, the deck
 * is poured into the template's own designs: the outline proposes page
 * roles, code maps them onto the template's pages, and each slide's fill
 * writes ONLY the words of that page's text slots (capped per slot).
 * Fonts, colors, geometry, and image slots come from the template; the
 * model never sees — and cannot change — the design. */

export type TemplateOutlineItem = {
  title: string;
  keyMessage: string;
  role: PptxTemplatePageKind;
};

const TEMPLATE_ROLES: readonly PptxTemplatePageKind[] = ['cover', 'toc', 'section', 'content', 'closing'];

const TEMPLATE_OUTLINE_SYSTEM = [
  'You are the OUTLINE stage of a slide-generation pipeline working in TEMPLATE MODE: the deck is poured into an imported PowerPoint template whose page designs (backgrounds, text boxes, fonts, colors) are fixed — you only decide the words.',
  'Answer with ONLY a JSON array — no prose, no markdown fences. Each item: {"title": string, "keyMessage": string, "role": "cover"|"toc"|"section"|"content"|"closing"}.',
  'Rules:',
  '- The array length is locked to the requested slide_count: exactly that many items.',
  '- The first item has role "cover". Use "toc" only when slide_count >= 4 and an agenda page genuinely helps. Use "section" for part dividers in longer decks. The last item has role "closing" when the template offers a closing design and slide_count >= 3. Everything else is "content".',
  '- Every title and keyMessage is about the requested topic only. Never invent statistics, quotes, dates, names, or facts.',
  '- No filler: every slide advances the topic.',
].join('\n');

function templateOutlineUser(brief: NormalizedBrief, template: PptxTemplate, pages: PptxTemplatePage[]): string {
  const lines = [`topic: ${brief.topic}`, `slide_count: ${brief.slideCount}`];
  if (brief.purpose) lines.push(`purpose/audience: ${brief.purpose}`);
  if (brief.language) lines.push(`language: write every title and keyMessage in ${brief.language}`);
  lines.push(`template: "${template.name}" — page designs available (role: how many, with the design's own sample wording):`);
  for (const role of TEMPLATE_ROLES) {
    const ofRole = pages.filter((page) => page.kind === role);
    if (ofRole.length === 0) continue;
    const sample = templatePageTextSlots(ofRole[0]!)[0]?.sampleText.replace(/\s+/g, ' ').slice(0, 60) ?? '';
    lines.push(`- ${role}: ${ofRole.length} design${ofRole.length === 1 ? '' : 's'}${sample ? ` (e.g. "${sample}")` : ''}`);
  }
  lines.push(`Return exactly ${brief.slideCount} outline items as a JSON array.`);
  return lines.join('\n');
}

function validateTemplateOutline(value: unknown, count: number): Verdict<TemplateOutlineItem[]> {
  const issues: string[] = [];
  let rawItems: unknown[] | undefined;
  if (Array.isArray(value)) rawItems = value;
  else if (isObj(value)) {
    for (const key of ['slides', 'outline', 'items']) {
      if (Array.isArray(value[key])) { rawItems = value[key] as unknown[]; break; }
    }
  }
  if (!rawItems) return { ok: false, issues: ['output must be a JSON array of outline items (or an object with a "slides" array)'] };
  if (rawItems.length !== count) issues.push(`expected exactly ${count} outline items, got ${rawItems.length}`);
  const items: TemplateOutlineItem[] = [];
  rawItems.forEach((raw, i) => {
    if (!isObj(raw)) { issues.push(`item ${i + 1} must be an object {title, keyMessage, role}`); return; }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const keyMessage = typeof raw.keyMessage === 'string' ? raw.keyMessage.trim() : '';
    const role = typeof raw.role === 'string' ? raw.role : '';
    if (!title) issues.push(`item ${i + 1}: title must be a non-empty string`);
    if (!(TEMPLATE_ROLES as readonly string[]).includes(role)) issues.push(`item ${i + 1}: role must be one of ${TEMPLATE_ROLES.join(', ')}`);
    if (!keyMessage) issues.push(`item ${i + 1}: keyMessage must be a non-empty string stating what the slide establishes`);
    if (title && keyMessage && (TEMPLATE_ROLES as readonly string[]).includes(role)) {
      items.push({ title, keyMessage, role: role as PptxTemplatePageKind });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: items };
}

/**
 * Map outline roles onto template pages, deterministically:
 * - the first item takes the template's first cover page (the first page
 *   overall when no cover was classified);
 * - the last item takes the closing page when the template has one and
 *   the deck has at least 3 slides;
 * - toc/section roles take pages of their kind (cycling when several);
 * - content items cycle through the distinct content designs, always
 *   picking the least-used variant, so a design repeats beyond twice
 *   only once every variant has been used that often;
 * - a role whose kind the template lacks falls back to the content pool,
 *   then to any page. The result always has one page index per item.
 */
export function assignTemplatePages(items: Array<{ role: PptxTemplatePageKind }>, pages: PptxTemplatePage[]): number[] {
  const indexesOf = (kind: PptxTemplatePageKind): number[] => pages.map((page, i) => (page.kind === kind ? i : -1)).filter((i) => i >= 0);
  const covers = indexesOf('cover');
  const closings = indexesOf('closing');
  const tocs = indexesOf('toc');
  const sections = indexesOf('section');
  let contentPool = indexesOf('content');
  if (contentPool.length === 0) {
    contentPool = pages.map((_, i) => i).filter((i) => !covers.includes(i));
    if (contentPool.length === 0) contentPool = pages.map((_, i) => i);
  }
  const useCount = new Array<number>(pages.length).fill(0);
  const pickLeastUsed = (pool: number[]): number => {
    let best = pool[0]!;
    for (const candidate of pool) if (useCount[candidate]! < useCount[best]!) best = candidate;
    useCount[best] = (useCount[best] ?? 0) + 1;
    return best;
  };
  return items.map((item, index) => {
    const isFirst = index === 0;
    const isLast = index === items.length - 1;
    if (isFirst) {
      const pageIndex = covers[0] ?? 0;
      useCount[pageIndex] = (useCount[pageIndex] ?? 0) + 1;
      return pageIndex;
    }
    if (isLast && closings.length > 0 && items.length >= 3) return pickLeastUsed(closings);
    if (item.role === 'toc' && tocs.length > 0) return pickLeastUsed(tocs);
    if (item.role === 'section' && sections.length > 0) return pickLeastUsed(sections);
    return pickLeastUsed(contentPool);
  });
}

/**
 * The skeleton content of a template slide: every text slot starts as the
 * template's own sample wording, the largest text slot (the design's
 * title position) takes the outline title, image slots start empty
 * (rendered as the template's original picture until the user clicks
 * one). Hand-edit detection compares against exactly this shape.
 */
export function templateSkeletonContent(page: PptxTemplatePage, outlineTitle: string): { title: string; slots: Record<string, string> } {
  const slots: Record<string, string> = {};
  let titleSlot: PptxTextSlot | undefined;
  for (const slot of page.slots) {
    if (slot.kind === 'image') {
      slots[slot.key] = '';
      continue;
    }
    slots[slot.key] = slot.sampleText;
    if (!titleSlot || slot.fontSizePt > titleSlot.fontSizePt) titleSlot = slot;
  }
  if (titleSlot) slots[titleSlot.key] = outlineTitle;
  return { title: outlineTitle, slots };
}

function isUntouchedTemplateSkeleton(slide: Slide, page: PptxTemplatePage): boolean {
  const title = typeof slide.content.title === 'string' ? slide.content.title : '';
  return JSON.stringify(slide.content) === JSON.stringify(templateSkeletonContent(page, title));
}

const TEMPLATE_FILL_SYSTEM = [
  'You are the FILL stage of a slide-generation pipeline working in TEMPLATE MODE. The slide design (background, boxes, fonts, colors) comes from an imported PowerPoint template and is FIXED — you write only the words that go into its text boxes.',
  'Answer with ONLY a JSON object mapping slot keys to replacement text — no prose, no markdown fences: {"s0": "...", "s1": "..."}.',
  'Rules:',
  '- Return exactly the listed text slots, each a string no longer than its stated character capacity (the text must fit the box it lives in).',
  '- Write real presentation content about the topic that establishes the slide key message; keep the slide title\'s meaning in the largest slot.',
  '- Image slots are not yours: never return them (they keep the template picture until the user replaces it).',
  '- Never invent statistics, quotes, dates, names, or facts.',
].join('\n');

function templateFillUser(deck: DeckSpec, slide: Slide, page: PptxTemplatePage, language?: string): string {
  const lines = [
    `presentation topic: ${deck.title}`,
    `slide title: ${slideTitle(slide)}`,
  ];
  if (slide.keyMessage) lines.push(`key message this slide must establish: ${slide.keyMessage}`);
  if (language) lines.push(`language: write all slot text in ${language}`);
  lines.push('Text slots of this template page (key — capacity — the design\'s own sample wording to replace):');
  for (const slot of templatePageTextSlots(page)) {
    const sample = slot.sampleText.replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`- ${slot.key}: max ${slot.maxChars} chars${sample ? ` — sample: "${sample}"` : ''}`);
  }
  const imageCount = page.slots.length - templatePageTextSlots(page).length;
  if (imageCount > 0) lines.push(`(plus ${imageCount} image slot${imageCount === 1 ? '' : 's'} — leave those out of your answer)`);
  lines.push('Return the JSON object of slot texts now.');
  return lines.join('\n');
}

function validateTemplateFill(page: PptxTemplatePage): (value: unknown) => Verdict<Record<string, string>> {
  return (value) => {
    let map: unknown = value;
    if (isObj(map) && isObj(map.slots)) map = map.slots;
    if (!isObj(map)) return { ok: false, issues: ['output must be a JSON object mapping slot keys to text, e.g. {"s0": "..."}'] };
    const textSlots = templatePageTextSlots(page);
    const known = new Set(textSlots.map((slot) => slot.key));
    const issues: string[] = [];
    for (const key of Object.keys(map)) {
      if (!known.has(key)) issues.push(`"${key}" is not a text slot of this page (text slots: ${[...known].join(', ') || 'none'}) — image slots and unknown keys must be left out`);
    }
    const filled: Record<string, string> = {};
    for (const slot of textSlots) {
      const raw = map[slot.key];
      if (raw === undefined) {
        issues.push(`${slot.key}: missing — every text slot needs replacement text (max ${slot.maxChars} chars)`);
        continue;
      }
      if (typeof raw !== 'string') {
        issues.push(`${slot.key}: must be a string`);
        continue;
      }
      filled[slot.key] = raw;
    }
    issues.push(...validateTemplateSlideSlots(page, filled));
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: filled };
  };
}

export async function generateDeckOutlineStage(
  provider: LLMProvider,
  root: string,
  briefInput: DeckBrief,
  options: { signal?: AbortSignal } = {},
): Promise<OutlineStageResult> {
  const brief = normalizeBrief(briefInput);
  const existing = await readDeck(root);
  if (existing && existing.slides.length > 0) {
    throw new SlidePipelineError(
      `a deck already exists in this workspace (${existing.slides.length} slides: "${existing.title}") — generate_deck_outline starts a new deck. Continue the existing deck with generate_deck_slides, edit it with the deck tools, or remove deck/deck.json to start over.`,
    );
  }
  // Template selection: an explicit brief id wins; otherwise a template
  // the user already applied to this (still empty) deck via the panel
  // carries into generation. A bundled Warna & Font pick replaces both.
  const customTemplateId = brief.customTemplateId ?? (brief.templateId ? undefined : existing?.theme.customTemplateId);
  let pptTemplate: PptxTemplate | undefined;
  let templatePages: PptxTemplatePage[] | undefined;
  if (customTemplateId) {
    pptTemplate = await getPptxTemplate(root, customTemplateId);
    if (!pptTemplate) {
      throw new SlidePipelineError(`template PPT "${customTemplateId}" tidak ditemukan di workspace ini — impor dari panel "Template dari PPT" atau pilih Warna & Font bawaan`);
    }
    if (pptTemplate.pages && pptTemplate.pages.length > 0) templatePages = pptTemplate.pages;
  }

  if (templatePages && pptTemplate) {
    // TEMPLATE MODE: outline by page role, code maps roles onto the
    // template's pages, skeletons carry the template's own sample words.
    const items = await structuredCall(
      provider,
      TEMPLATE_OUTLINE_SYSTEM,
      templateOutlineUser(brief, pptTemplate, templatePages),
      (value) => validateTemplateOutline(value, brief.slideCount),
      options.signal,
    );
    const pageIndexes = assignTemplatePages(items, templatePages);
    const deck = existing ?? newDeck(brief.topic);
    const { theme } = await applyPptxTemplateTheme(root, pptTemplate.id);
    deck.theme = theme;
    deck.slides = items.map((item, index) => {
      const pageIndex = pageIndexes[index]!;
      return {
        id: newSlideId(),
        layout: 'template-page',
        content: templateSkeletonContent(templatePages[pageIndex]!, item.title),
        status: 'skeleton' as const,
        keyMessage: item.keyMessage,
        templateRef: { templateId: pptTemplate.id, page: pageIndex },
      };
    });
    await writeDeck(root, deck);
    return {
      deck,
      outline: items.map((item) => ({ title: item.title, layoutId: 'template-page', keyMessage: item.keyMessage })),
      createdDeck: !existing,
    };
  }

  const outline = await structuredCall(provider, OUTLINE_SYSTEM, outlineUser(brief), (value) => validateOutline(value, brief.slideCount), options.signal);
  const deck = existing ?? newDeck(brief.topic);
  if (brief.templateId) {
    const template = getSlideTemplate(brief.templateId)!;
    deck.theme = { ...template.theme, templateId: template.id };
  } else if (pptTemplate) {
    // Skin-only imported template (no parsed pages): v1 behavior — the
    // extracted palette/fonts/background dress the catalog layouts.
    const { theme } = await applyPptxTemplateTheme(root, pptTemplate.id);
    deck.theme = theme;
  }
  deck.slides = outline.map((item) => {
    const layout = getLayout(item.layoutId)!;
    return {
      id: newSlideId(),
      layout: item.layoutId,
      content: skeletonContent(layout, item.title),
      status: 'skeleton' as const,
      keyMessage: item.keyMessage,
    };
  });
  await writeDeck(root, deck);
  return { deck, outline, createdDeck: !existing };
}

/* ------------------------------------------------------------- fill */

function slideTitle(slide: Slide): string {
  const raw = slide.content.title ?? slide.content.text;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : slide.id;
}

function fillSystem(layout: LayoutDef): string {
  return [
    'You are the FILL stage of a slide-generation pipeline, writing ONE slide. Answer with ONLY a JSON object — the slide content — no prose, no markdown fences.',
    `Layout: ${layout.id} (${layout.label}). Content schema (* = required): ${summarizeLayoutSchema(layout)}`,
    'Rules:',
    '- Fill every required field with real content about the topic; keep the given slide title in the title field when the layout has one.',
    '- Stay inside the schema bounds (array min/max items) and keep each text item brief — a slide is read at a glance.',
    '- Never invent statistics, quotes, dates, names, or facts; write only what the topic supports, phrased as presentation content.',
  ].join('\n');
}

function fillUser(deck: DeckSpec, slide: Slide, language?: string): string {
  const lines = [
    `presentation topic: ${deck.title}`,
    `slide title: ${slideTitle(slide)}`,
    `layout: ${slide.layout}`,
  ];
  if (slide.keyMessage) lines.push(`key message this slide must establish: ${slide.keyMessage}`);
  if (language) lines.push(`language: write all content in ${language}`);
  lines.push('Return the content JSON object for this one slide.');
  return lines.join('\n');
}

function validateFill(layout: LayoutDef): (value: unknown) => Verdict<Record<string, unknown>> {
  return (value) => {
    if (!isObj(value)) return { ok: false, issues: ['output must be a JSON object with the slide content fields'] };
    const errors = validateSlideContent(layout, value).filter((i) => i.severity === 'error');
    if (errors.length > 0) return { ok: false, issues: errors.map((i) => `${i.field ? `${i.field}: ` : ''}${i.message}`) };
    return { ok: true, value };
  };
}

/**
 * A skeleton only counts as untouched (still fillable) while its content
 * is still exactly the layout defaults plus the outline title — a slide
 * the user or agent already edited by hand is never overwritten by a
 * resume pass.
 */
function isUntouchedSkeleton(slide: Slide): boolean {
  const layout = getLayout(slide.layout);
  if (!layout) return false;
  return JSON.stringify(slide.content) === JSON.stringify(skeletonContent(layout, slideTitle(slide)));
}

export async function fillDeckSlidesStage(
  provider: LLMProvider,
  root: string,
  options: { language?: string; templateId?: string; signal?: AbortSignal; stagedGenerate?: boolean } = {},
): Promise<FillStageResult> {
  const deck = await readDeck(root);
  if (!deck) {
    throw new SlidePipelineError('no deck yet: run generate_deck_outline (or create_deck) first (deck/deck.json does not exist)');
  }
  if (options.templateId) {
    const template = getSlideTemplate(options.templateId);
    if (!template) throw new SlidePipelineError(`unknown templateId "${options.templateId}" — warna & font bawaan: ${SLIDE_TEMPLATES.map((t) => t.id).join(', ')}`);
    deck.theme = { ...template.theme, templateId: template.id };
    await writeDeck(root, deck);
  }

  // Template-page resolution (imported PPT designs), memoized per run:
  // a template slide's design comes from its templateRef, never from
  // the layout catalog.
  const pageCache = new Map<string, PptxTemplatePage | undefined>();
  const resolvePage = async (slide: Slide): Promise<PptxTemplatePage | undefined> => {
    if (!slide.templateRef) return undefined;
    const key = `${slide.templateRef.templateId}:${slide.templateRef.page}`;
    if (!pageCache.has(key)) {
      const template = await getPptxTemplate(root, slide.templateRef.templateId).catch(() => undefined);
      pageCache.set(key, template?.pages?.[slide.templateRef.page]);
    }
    return pageCache.get(key);
  };

  if (options.stagedGenerate) {
    // Staged generate (the Outline panel's Buat button): a skeleton the
    // user already edited in the panel is theirs. Hand-written content
    // that satisfies its (possibly changed) layout is adopted as-is —
    // marked filled, never overwritten by the model; only untouched
    // skeletons and schema-failing slides go through the fill below.
    let adopted = false;
    for (const slide of deck.slides) {
      if (slide.status !== 'skeleton') continue;
      if (slide.templateRef) {
        const page = await resolvePage(slide);
        if (page && !isUntouchedTemplateSkeleton(slide, page) && isObj(slide.content.slots) && validateTemplateSlideSlots(page, slide.content.slots).length === 0) {
          slide.status = 'filled';
          adopted = true;
        }
        continue;
      }
      if (isUntouchedSkeleton(slide)) continue;
      const layout = getLayout(slide.layout);
      if (!layout) continue;
      if (validateSlideContent(layout, slide.content).every((issue) => issue.severity !== 'error')) {
        slide.status = 'filled';
        adopted = true;
      }
    }
    if (adopted) await writeDeck(root, deck);
  }

  const filledNow: string[] = [];
  const attemptIssues = new Map<string, string[]>();
  const errorIds = new Set(
    validateDeck(deck, { root }).filter((i) => i.severity === 'error' && i.slideId).map((i) => i.slideId as string),
  );
  // Resume semantics: fill exactly the slides that still need it —
  // untouched skeletons plus any slide currently failing validation.
  const untouchedById = new Map<string, boolean>();
  for (const slide of deck.slides) {
    if (slide.status !== 'skeleton') continue;
    if (slide.templateRef) {
      const page = await resolvePage(slide);
      untouchedById.set(slide.id, page ? isUntouchedTemplateSkeleton(slide, page) : false);
    } else {
      untouchedById.set(slide.id, isUntouchedSkeleton(slide));
    }
  }
  const targets = deck.slides.filter(
    (slide) => (slide.status === 'skeleton' && untouchedById.get(slide.id) === true) || errorIds.has(slide.id),
  );
  for (const slide of targets) {
    if (slide.templateRef) {
      const page = await resolvePage(slide);
      if (!page) {
        attemptIssues.set(slide.id, [`template page ${slide.templateRef.page} of "${slide.templateRef.templateId}" not found — re-import the template from the "Template dari PPT" panel or remove this slide`]);
        continue;
      }
      try {
        const filled = await structuredCall(provider, TEMPLATE_FILL_SYSTEM, templateFillUser(deck, slide, page, options.language), validateTemplateFill(page), options.signal);
        const currentSlots = isObj(slide.content.slots) ? (slide.content.slots as Record<string, unknown>) : {};
        const slots: Record<string, unknown> = { ...currentSlots };
        // Image slots are never filled by the model: keep the user's
        // picked asset, or '' (the template's own picture).
        for (const slot of page.slots) if (slot.kind === 'image' && !(slot.key in slots)) slots[slot.key] = '';
        Object.assign(slots, filled);
        slide.content = { ...(typeof slide.content.title === 'string' ? { title: slide.content.title } : {}), slots };
        slide.status = 'filled';
        filledNow.push(slide.id);
        await writeDeck(root, deck);
      } catch (error) {
        attemptIssues.set(slide.id, error instanceof SlidePipelineError ? error.issues : [error instanceof Error ? error.message : String(error)]);
      }
      continue;
    }
    const layout = getLayout(slide.layout);
    if (!layout) {
      attemptIssues.set(slide.id, [`unknown layout "${slide.layout}" — change the slide layout before filling`]);
      continue;
    }
    try {
      const content = await structuredCall(provider, fillSystem(layout), fillUser(deck, slide, options.language), validateFill(layout), options.signal);
      slide.content = content;
      slide.status = 'filled';
      filledNow.push(slide.id);
      // Persist after every slide: a crash or a later failure leaves a
      // resumable deck, never an all-or-nothing generation.
      await writeDeck(root, deck);
    } catch (error) {
      attemptIssues.set(slide.id, error instanceof SlidePipelineError ? error.issues : [error instanceof Error ? error.message : String(error)]);
    }
  }

  const deckIssues = validateDeck(deck, { root });
  const failureMap = new Map<string, string[]>();
  const addIssue = (id: string, message: string): void => {
    const arr = failureMap.get(id) ?? [];
    if (!arr.includes(message)) arr.push(message);
    failureMap.set(id, arr);
  };
  for (const [id, issues] of attemptIssues) for (const message of issues) addIssue(id, message);
  for (const issue of deckIssues) if (issue.severity === 'error' && issue.slideId) addIssue(issue.slideId, issue.message);
  for (const slide of deck.slides) if (slide.status === 'skeleton') addIssue(slide.id, 'slide was not filled (still skeleton content)');
  const failures: SlideFillFailure[] = deck.slides
    .filter((slide) => failureMap.has(slide.id))
    .map((slide) => ({ slideId: slide.id, layout: slide.layout, title: slideTitle(slide), issues: failureMap.get(slide.id)! }));

  // Export only a deck that is completely filled and valid — a partial
  // deck is reported honestly, never exported, never "done".
  let exported: ExportInfo | undefined;
  let exportError: string | undefined;
  const hasErrors = deckIssues.some((i) => i.severity === 'error');
  if (failures.length === 0 && !hasErrors && deck.slides.length > 0) {
    try {
      const result = await exportDeckToPptx(deck, root);
      exported = { path: result.relativePath, bytes: result.bytes, slides: result.slideCount };
    } catch (error) {
      exportError = error instanceof Error ? error.message : String(error);
    }
  }
  return { deck, filledNow, failures, deckIssues, ...(exported ? { exported } : {}), ...(exportError ? { exportError } : {}) };
}

/* ------------------------------------------------------ regenerate */

export type RegenerateSlideResult = {
  deck: DeckSpec;
  slide: Slide;
  deckIssues: DeckIssue[];
};

/**
 * Regenerate ONE slide with fresh content (the editor's per-slide
 * variant): a single fill call for exactly that slide id, instructed to
 * take a different approach, validated against the layout schema before
 * anything is written. Every other slide and the theme are untouched.
 * The deck on disk changes only when the new content is valid.
 */
export async function regenerateSlideStage(
  provider: LLMProvider,
  root: string,
  slideId: string,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<RegenerateSlideResult> {
  const deck = await readDeck(root);
  if (!deck) {
    throw new SlidePipelineError('no deck yet: nothing to regenerate (deck/deck.json does not exist)');
  }
  const slide = deck.slides.find((entry) => entry.id === slideId);
  if (!slide) {
    throw new SlidePipelineError(`slide "${slideId}" not found in this deck (${deck.slides.length} slides) — refresh the deck and pick an existing slide`);
  }
  if (slide.templateRef) {
    // Template slide: regenerate the WORDS only, into the same page —
    // the design (and any user-picked slot images) stay untouched.
    const template = await getPptxTemplate(root, slide.templateRef.templateId).catch(() => undefined);
    const page = template?.pages?.[slide.templateRef.page];
    if (!page) {
      throw new SlidePipelineError(`template page ${slide.templateRef.page} of "${slide.templateRef.templateId}" not found — re-import the template from the "Template dari PPT" panel before regenerating`);
    }
    const user = `${templateFillUser(deck, slide, page, options.language)}\nThis is a REGENERATION: produce a fresh, different take on the wording — do not repeat the current slot texts.`;
    const filled = await structuredCall(provider, TEMPLATE_FILL_SYSTEM, user, validateTemplateFill(page), options.signal);
    const currentSlots = isObj(slide.content.slots) ? (slide.content.slots as Record<string, unknown>) : {};
    const slots: Record<string, unknown> = { ...currentSlots };
    for (const slot of page.slots) if (slot.kind === 'image' && !(slot.key in slots)) slots[slot.key] = '';
    Object.assign(slots, filled);
    slide.content = { ...(typeof slide.content.title === 'string' ? { title: slide.content.title } : {}), slots };
    slide.status = 'filled';
    await writeDeck(root, deck);
    return { deck, slide, deckIssues: validateDeck(deck, { root }) };
  }
  const layout = getLayout(slide.layout);
  if (!layout) {
    throw new SlidePipelineError(`slide "${slideId}" uses unknown layout "${slide.layout}" — change its layout before regenerating`);
  }
  const user = `${fillUser(deck, slide, options.language)}\nThis is a REGENERATION: produce a fresh, different take on this slide (different angle, wording, and structure) — do not repeat the current content.`;
  const content = await structuredCall(provider, fillSystem(layout), user, validateFill(layout), options.signal);
  slide.content = content;
  slide.status = 'filled';
  await writeDeck(root, deck);
  return { deck, slide, deckIssues: validateDeck(deck, { root }) };
}

/* --------------------------------------------------------- combined */

export async function generateDeckFullStage(
  provider: LLMProvider,
  root: string,
  briefInput: DeckBrief,
  options: { signal?: AbortSignal } = {},
): Promise<{ outline: OutlineItem[]; fill: FillStageResult }> {
  const brief = normalizeBrief(briefInput);
  const { outline } = await generateDeckOutlineStage(provider, root, brief, options);
  const fill = await fillDeckSlidesStage(provider, root, {
    ...(brief.language ? { language: brief.language } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { outline, fill };
}
