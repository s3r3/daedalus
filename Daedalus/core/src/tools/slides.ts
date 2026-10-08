import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './registry.ts';
import { deckPaths, type DeckSpec, type Slide } from '../slides/deck.ts';
import { getLayout, LAYOUTS, validateSlideContent, type PropSchema } from '../slides/layouts.ts';
import { ensureDeckDir, newDeck, newSlideId, readDeck, summarizeDeck, validateDeck, writeDeck } from '../slides/store.ts';
import { exportDeckToPptx } from '../slides/export-pptx.ts';
import type { ToolResult } from '../contracts.ts';

function ok(output: string, meta: Record<string, unknown> = {}): ToolResult {
  return { call_id: '', status: 'ok', output, truncated: false, meta };
}
function err(output: string, meta: Record<string, unknown> = {}): ToolResult {
  return { call_id: '', status: 'error', output, truncated: false, meta };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function mergeShallow(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  return { ...clone(base), ...clone(over) };
}

const LAYOUT_CATALOG = LAYOUTS.map((l) => `${l.id} (${l.category}): ${l.label}`).join('; ');

/** Compact per-layout content schema (`*` = required), rendered from the same schema objects the validator enforces, so the model sees the exact field shapes (nested objects and array item fields included) instead of guessing them. */
function summarizeProp(prop: PropSchema): string {
  if (prop.type === 'array') {
    const items = prop.items ? summarizeProp(prop.items) : 'string';
    const bounds = prop.minItems !== undefined || prop.maxItems !== undefined ? ` (${prop.minItems ?? 0}..${prop.maxItems ?? 'n'})` : '';
    return `${items}[]${bounds}`;
  }
  if (prop.type === 'object' && prop.properties) {
    const required = new Set(prop.required ?? []);
    const fields = Object.entries(prop.properties).map(([key, value]) => `${key}${required.has(key) ? '*' : ''}: ${summarizeProp(value)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return prop.enum ? prop.enum.join('|') : prop.type;
}

export function summarizeLayoutSchemas(): string {
  return LAYOUTS.map((layout) => {
    const required = new Set(layout.schema.required);
    const fields = Object.entries(layout.schema.properties).map(([key, value]) => `${key}${required.has(key) ? '*' : ''}: ${summarizeProp(value)}`);
    return `${layout.id} { ${fields.join(', ')} }`;
  }).join('\n');
}

const LAYOUT_SCHEMAS = summarizeLayoutSchemas();
const WORKFLOW = 'Workflow: create_deck once → add_slide once per outline item (visual layouts preferred: diagrams, charts, icon-grid, stats over plain bullets) → validate_deck → fix issues → export_deck.';

async function loadDeckOrError(root: string): Promise<{ deck: DeckSpec } | { error: ToolResult }> {
  let deck: DeckSpec | null;
  try {
    deck = await readDeck(root);
  } catch (e) {
    return { error: err(`deck is corrupt: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (!deck) return { error: err('no deck yet: run create_deck first (deck/deck.json does not exist)') };
  return { deck };
}

function formatIssues(deck: DeckSpec, root: string): string {
  const issues = validateDeck(deck, { root });
  if (issues.length === 0) return 'deck valid (no issues)';
  return issues.map((i) => `- [${i.severity}] ${i.code}${i.slideId ? ` slide=${i.slideId}` : ''}${i.field ? ` field=${i.field}` : ''}: ${i.message}`).join('\n');
}

export const createDeckTool: ToolDefinition = {
  name: 'create_deck',
  description: `Create a new slide deck (deck/deck.json) in this workspace. Fails if a deck already exists. ${WORKFLOW}`,
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { title?: unknown };
    if (typeof a.title !== 'string' || a.title.trim().length === 0) return err('title must be a non-empty string');
    const root = context.workspaceRoot;
    const paths = deckPaths(root);
    if (existsSync(paths.file)) return err('deck already exists (deck/deck.json). Use read_deck to inspect it, or delete it manually before creating a new one.');
    try {
      await ensureDeckDir(root);
      const deck = newDeck(a.title.trim());
      await writeDeck(root, deck);
      return ok(`created deck at deck/deck.json\n${summarizeDeck(deck)}`, { deck_id: deck.id, path: 'deck/deck.json' });
    } catch (e) { return err(String(e)); }
  },
};

export const readDeckTool: ToolDefinition = {
  name: 'read_deck',
  description: 'Read the current deck summary (title, slide list with layouts and titles, and validation issues). Does not dump full JSON.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  mutating: false,
  async execute(_args, context) {
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const issues = formatIssues(loaded.deck, context.workspaceRoot);
    return ok(`${summarizeDeck(loaded.deck)}\n\nIssues:\n${issues}`, { slides: loaded.deck.slides.length });
  },
};

export const addSlideTool: ToolDefinition = {
  name: 'add_slide',
  description: `Add one slide to the deck. Layout catalog: ${LAYOUT_CATALOG}. content is merged (shallow) over the layout defaults; invalid content is rejected with validation issues. ${WORKFLOW}\nContent schemas (* = required; arrays of objects need every item's required fields, e.g. diagram-flow steps are { title*, desc } objects, not plain strings):\n${LAYOUT_SCHEMAS}`,
  inputSchema: {
    type: 'object', required: ['layout'],
    properties: {
      layout: { type: 'string', enum: LAYOUTS.map((l) => l.id) },
      content: { type: 'object' },
      index: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  mutating: true,
  async execute(args, context) {
    const a = args as { layout?: unknown; content?: unknown; index?: unknown };
    if (typeof a.layout !== 'string') return err('layout must be a string');
    const layout = getLayout(a.layout);
    if (!layout) return err(`unknown layout "${a.layout}". Known layouts: ${LAYOUTS.map((l) => l.id).join(', ')}`);
    if (a.content !== undefined && !isObj(a.content)) return err('content must be an object');
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    const content = mergeShallow(clone(layout.defaults), isObj(a.content) ? a.content : {});
    const issues = validateSlideContent(layout, content).filter((i) => i.severity === 'error');
    if (issues.length > 0) return err(`invalid content for layout ${layout.id}:\n${issues.map((i) => `- [${i.severity}] ${i.code}${i.field ? ` field=${i.field}` : ''}: ${i.message}`).join('\n')}`);
    const slide: Slide = { id: newSlideId(), layout: layout.id, content };
    let idx = deck.slides.length;
    if (typeof a.index === 'number' && Number.isFinite(a.index)) idx = Math.max(0, Math.min(deck.slides.length, Math.floor(a.index)));
    deck.slides.splice(idx, 0, slide);
    await writeDeck(context.workspaceRoot, deck);
    return ok(`added slide at position ${idx + 1} (${slide.id}) [${layout.id}]\n${summarizeDeck(deck)}`, { slide_id: slide.id, index: idx });
  },
};

export const updateSlideTool: ToolDefinition = {
  name: 'update_slide',
  description: `Update one slide by id: shallow-merges content into the slide and validates the merged result. Shallow means a nested field you send replaces the whole nested value, so always send complete nested objects/arrays.\nContent schemas (* = required):\n${LAYOUT_SCHEMAS}`,
  inputSchema: { type: 'object', required: ['slideId', 'content'], properties: { slideId: { type: 'string' }, content: { type: 'object' } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { slideId?: unknown; content?: unknown };
    if (typeof a.slideId !== 'string') return err('slideId must be a string');
    if (!isObj(a.content)) return err('content must be an object');
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    const slide = deck.slides.find((s) => s.id === a.slideId);
    if (!slide) return err(`slide not found: ${a.slideId}`);
    const layout = getLayout(slide.layout);
    const merged = mergeShallow(slide.content, a.content);
    if (layout) {
      const issues = validateSlideContent(layout, merged).filter((i) => i.severity === 'error');
      if (issues.length > 0) return err(`invalid merged content for slide ${slide.id} [${slide.layout}]:\n${issues.map((i) => `- [${i.severity}] ${i.code}${i.field ? ` field=${i.field}` : ''}: ${i.message}`).join('\n')}`);
    }
    slide.content = merged;
    await writeDeck(context.workspaceRoot, deck);
    return ok(`updated slide ${slide.id} [${slide.layout}]\n${summarizeDeck(deck)}`, { slide_id: slide.id });
  },
};

export const moveSlideTool: ToolDefinition = {
  name: 'move_slide',
  description: 'Move a slide by id to a new zero-based index (clamped to the deck range).',
  inputSchema: { type: 'object', required: ['slideId', 'toIndex'], properties: { slideId: { type: 'string' }, toIndex: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { slideId?: unknown; toIndex?: unknown };
    if (typeof a.slideId !== 'string') return err('slideId must be a string');
    if (typeof a.toIndex !== 'number' || !Number.isFinite(a.toIndex)) return err('toIndex must be an integer');
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    const from = deck.slides.findIndex((s) => s.id === a.slideId);
    if (from < 0) return err(`slide not found: ${a.slideId}`);
    const to = Math.max(0, Math.min(deck.slides.length - 1, Math.floor(a.toIndex)));
    const [slide] = deck.slides.splice(from, 1);
    deck.slides.splice(to, 0, slide!);
    await writeDeck(context.workspaceRoot, deck);
    return ok(`moved slide ${a.slideId} from position ${from + 1} to ${to + 1}\n${summarizeDeck(deck)}`, { slide_id: a.slideId, from, to });
  },
};

export const deleteSlideTool: ToolDefinition = {
  name: 'delete_slide',
  description: 'Delete a slide by id from the deck.',
  inputSchema: { type: 'object', required: ['slideId'], properties: { slideId: { type: 'string' } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { slideId?: unknown };
    if (typeof a.slideId !== 'string') return err('slideId must be a string');
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    const idx = deck.slides.findIndex((s) => s.id === a.slideId);
    if (idx < 0) return err(`slide not found: ${a.slideId}`);
    const [removed] = deck.slides.splice(idx, 1);
    await writeDeck(context.workspaceRoot, deck);
    return ok(`deleted slide ${removed!.id} [${removed!.layout}] at position ${idx + 1}\n${summarizeDeck(deck)}`, { slide_id: removed!.id });
  },
};

export const setDeckThemeTool: ToolDefinition = {
  name: 'set_deck_theme',
  description: 'Set deck theme: accent as #rrggbb and/or dark boolean. Deck title is not changed here.',
  inputSchema: { type: 'object', properties: { accent: { type: 'string' }, dark: { type: 'boolean' } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { accent?: unknown; dark?: unknown };
    if (a.accent !== undefined && (typeof a.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.accent))) return err('accent must be a #rrggbb hex color');
    if (a.dark !== undefined && typeof a.dark !== 'boolean') return err('dark must be a boolean');
    if (a.accent === undefined && a.dark === undefined) return err('provide accent and/or dark');
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    if (typeof a.accent === 'string') deck.theme.accent = a.accent;
    if (typeof a.dark === 'boolean') deck.theme.dark = a.dark;
    await writeDeck(context.workspaceRoot, deck);
    return ok(`theme updated: accent=${deck.theme.accent ?? '(default)'} dark=${deck.theme.dark ?? true}\n${summarizeDeck(deck)}`, { theme: deck.theme });
  },
};

export const validateDeckTool: ToolDefinition = {
  name: 'validate_deck',
  description: 'Validate the deck against layout schemas and asset existence. Reports issues; the call itself succeeds even when issues exist (it only errors when there is no deck or it is corrupt).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  mutating: false,
  async execute(_args, context) {
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const issues = validateDeck(loaded.deck, { root: context.workspaceRoot });
    const output = issues.length === 0 ? 'deck valid' : issues.map((i) => `- [${i.severity}] ${i.code}${i.slideId ? ` slide=${i.slideId}` : ''}${i.field ? ` field=${i.field}` : ''}: ${i.message}`).join('\n');
    const errors = issues.filter((i) => i.severity === 'error').length;
    return ok(output, { issues: issues.length, errors, warnings: issues.length - errors });
  },
};

export const exportDeckTool: ToolDefinition = {
  name: 'export_deck',
  description: `Export the deck to PPTX (native editable text/charts) at deck/<slug>.pptx. Validates first and refuses on validation errors. ${WORKFLOW}`,
  inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['pptx'] } }, additionalProperties: false },
  mutating: true,
  async execute(args, context) {
    const a = args as { format?: unknown };
    const format = a.format === undefined ? 'pptx' : a.format;
    if (format !== 'pptx') return err(`unsupported format: ${String(format)} (only pptx)`);
    const loaded = await loadDeckOrError(context.workspaceRoot);
    if ('error' in loaded) return loaded.error;
    const deck = loaded.deck;
    const issues = validateDeck(deck, { root: context.workspaceRoot });
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return err(`export refused: deck has ${errors.length} validation error(s):\n${issues.map((i) => `- [${i.severity}] ${i.code}: ${i.message}`).join('\n')}`);
    }
    try {
      const result = await exportDeckToPptx(deck, context.workspaceRoot);
      // Confine output to deck/ (exportDeckToPptx builds it from deckPaths + slug).
      const expectedDir = deckPaths(context.workspaceRoot).dir;
      if (!result.relativePath.startsWith('deck/') || join(context.workspaceRoot, result.relativePath).startsWith(expectedDir) === false) return err('export path escaped deck/');
      const kb = (result.bytes / 1024).toFixed(1);
      // Touch basename import to keep path handling explicit & confined.
      void basename(result.relativePath);
      return ok(`exported ${result.relativePath} — ${result.slideCount} slide${result.slideCount === 1 ? '' : 's'}, ${kb} KB`, { path: result.relativePath, bytes: result.bytes, slides: result.slideCount });
    } catch (e) { return err(`export failed: ${e instanceof Error ? e.message : String(e)}`); }
  },
};

export const SLIDE_TOOLS: ToolDefinition[] = [
  createDeckTool, readDeckTool, addSlideTool, updateSlideTool, moveSlideTool, deleteSlideTool, setDeckThemeTool, validateDeckTool, exportDeckTool,
];

// Referenced types for barrel consumers.
export type { ToolExecutionContext };
