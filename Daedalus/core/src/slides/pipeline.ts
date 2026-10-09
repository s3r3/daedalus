import type { LLMProvider, Message } from '../providers/llm/types.ts';
import { MAX_SLIDES, type DeckIssue, type DeckSpec, type Slide } from './deck.ts';
import { getLayout, LAYOUTS, summarizeLayoutSchema, validateSlideContent, type LayoutDef } from './layouts.ts';
import { newDeck, newSlideId, readDeck, validateDeck, writeDeck } from './store.ts';
import { getSlideTemplate, SLIDE_TEMPLATES } from './templates.ts';
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
    const response = await provider.chat(messages, undefined, signal ? { signal } : undefined);
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
    throw new SlidePipelineError(`unknown templateId "${brief.templateId}" — bundled templates: ${SLIDE_TEMPLATES.map((t) => t.id).join(', ')}`);
  }
  const count = typeof brief.slideCount === 'number' && Number.isFinite(brief.slideCount) ? Math.floor(brief.slideCount) : 8;
  return {
    topic,
    slideCount: Math.max(1, Math.min(MAX_SLIDES, count)),
    ...(typeof brief.language === 'string' && brief.language.trim() ? { language: brief.language.trim() } : {}),
    ...(brief.templateId ? { templateId: brief.templateId } : {}),
    ...(typeof brief.purpose === 'string' && brief.purpose.trim() ? { purpose: brief.purpose.trim() } : {}),
  };
}

/* ---------------------------------------------------------- outline */

const OUTLINE_SYSTEM = [
  'You are the OUTLINE stage of a slide-generation pipeline. Answer with ONLY a JSON array — no prose, no markdown fences.',
  'Each array item is an object: {"title": string, "layoutId": string, "keyMessage": string}.',
  'Rules:',
  '- The array length is locked to the requested slide_count: exactly that many items, no more, no fewer.',
  '- layoutId must be one of the catalog ids in the request; choose by content fit and vary layouts across the deck. Prefer visual/data layouts (diagram-flow, diagram-cycle, diagram-hierarchy, timeline, comparison, chart-bar, chart-line, chart-donut, stats, icon-grid, table) whenever the content suits them; do not make every slide bullets.',
  '- With slide_count >= 3, the first item uses layoutId "title" and the last uses "closing" (with slide_count 1-2, start with "title").',
  '- Every title and keyMessage is about the requested topic only. Never invent statistics, quotes, dates, names, or facts: a keyMessage states what the slide must establish about the topic, it does not assert fabricated evidence.',
  '- No filler: every slide advances the topic — no generic padding slides. Use image-side only when the topic plainly calls for a photograph the user can supply.',
].join('\n');

function outlineUser(brief: NormalizedBrief): string {
  const lines = [`topic: ${brief.topic}`, `slide_count: ${brief.slideCount}`];
  if (brief.purpose) lines.push(`purpose/audience: ${brief.purpose}`);
  if (brief.language) lines.push(`language: write every title and keyMessage in ${brief.language}`);
  lines.push('layout catalog (id (category): label):');
  for (const layout of LAYOUTS) lines.push(`- ${layout.id} (${layout.category}): ${layout.label}`);
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
    if (!LAYOUT_ID_SET.has(layoutId)) issues.push(`item ${i + 1}: unknown layoutId "${layoutId}" — use one of: ${[...LAYOUT_ID_SET].join(', ')}`);
    if (!keyMessage) issues.push(`item ${i + 1}: keyMessage must be a non-empty string stating what the slide establishes`);
    if (title && LAYOUT_ID_SET.has(layoutId) && keyMessage) items.push({ title, layoutId, keyMessage });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: items };
}

function skeletonContent(layout: LayoutDef, title: string): Record<string, unknown> {
  const content = clone(layout.defaults);
  if ('title' in layout.schema.properties) content.title = title;
  return content;
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
  const outline = await structuredCall(provider, OUTLINE_SYSTEM, outlineUser(brief), (value) => validateOutline(value, brief.slideCount), options.signal);
  const deck = existing ?? newDeck(brief.topic);
  if (brief.templateId) {
    const template = getSlideTemplate(brief.templateId)!;
    deck.theme = { ...template.theme, templateId: template.id };
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
  options: { language?: string; templateId?: string; signal?: AbortSignal } = {},
): Promise<FillStageResult> {
  const deck = await readDeck(root);
  if (!deck) {
    throw new SlidePipelineError('no deck yet: run generate_deck_outline (or create_deck) first (deck/deck.json does not exist)');
  }
  if (options.templateId) {
    const template = getSlideTemplate(options.templateId);
    if (!template) throw new SlidePipelineError(`unknown templateId "${options.templateId}" — bundled templates: ${SLIDE_TEMPLATES.map((t) => t.id).join(', ')}`);
    deck.theme = { ...template.theme, templateId: template.id };
    await writeDeck(root, deck);
  }

  const filledNow: string[] = [];
  const attemptIssues = new Map<string, string[]>();
  const errorIds = new Set(
    validateDeck(deck, { root }).filter((i) => i.severity === 'error' && i.slideId).map((i) => i.slideId as string),
  );
  // Resume semantics: fill exactly the slides that still need it —
  // untouched skeletons plus any slide currently failing validation.
  const targets = deck.slides.filter(
    (slide) => (slide.status === 'skeleton' && isUntouchedSkeleton(slide)) || errorIds.has(slide.id),
  );
  for (const slide of targets) {
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
