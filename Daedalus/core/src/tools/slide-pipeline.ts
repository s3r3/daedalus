import type { ToolDefinition } from './registry.ts';
import type { ToolResult } from '../contracts.ts';
import type { LLMProvider } from '../providers/llm/types.ts';
import {
  fillDeckSlidesStage,
  generateDeckFullStage,
  generateDeckOutlineStage,
  type DeckBrief,
  type FillStageResult,
} from '../slides/pipeline.ts';
import { summarizeDeck } from '../slides/store.ts';
import { SLIDE_TEMPLATES } from '../slides/templates.ts';

/**
 * Thin agent-facing wrappers over the slide generation pipeline
 * (slides/pipeline.ts). The pipeline owns sequencing; these tools only
 * translate arguments/results. They exist ONLY in the slide registry
 * and only when the host binds the run's LLM provider — generation is a
 * Slide-backend concern, never a coding tool.
 */

function ok(output: string, meta: Record<string, unknown> = {}): ToolResult {
  return { call_id: '', status: 'ok', output, truncated: false, meta };
}
function err(output: string, meta: Record<string, unknown> = {}): ToolResult {
  return { call_id: '', status: 'error', output, truncated: false, meta };
}

const NO_PROVIDER = 'slide generation pipeline unavailable: no model provider is bound to this run';
const PIPELINE_TIMEOUT_MS = 600_000;

function briefFromArgs(args: unknown): DeckBrief | { error: string } {
  const a = (args ?? {}) as { topic?: unknown; slideCount?: unknown; language?: unknown; templateId?: unknown; purpose?: unknown };
  if (typeof a.topic !== 'string' || a.topic.trim().length === 0) return { error: 'topic must be a non-empty string' };
  const brief: DeckBrief = { topic: a.topic };
  if (a.slideCount !== undefined) {
    if (typeof a.slideCount !== 'number' || !Number.isFinite(a.slideCount)) return { error: 'slideCount must be an integer between 1 and 40' };
    brief.slideCount = Math.floor(a.slideCount);
  }
  if (a.language !== undefined) {
    if (typeof a.language !== 'string') return { error: 'language must be a string' };
    brief.language = a.language;
  }
  if (a.templateId !== undefined) {
    if (typeof a.templateId !== 'string') return { error: 'templateId must be a string' };
    brief.templateId = a.templateId;
  }
  if (a.purpose !== undefined) {
    if (typeof a.purpose !== 'string') return { error: 'purpose must be a string' };
    brief.purpose = a.purpose;
  }
  return brief;
}

function formatFillReport(result: FillStageResult): { text: string; meta: Record<string, unknown> } {
  const total = result.deck.slides.length;
  if (result.exported) {
    return {
      text: `Deck complete: ${result.exported.slides} slide(s) filled and validated, exported ${result.exported.path} (${(result.exported.bytes / 1024).toFixed(1)} KB).\n${summarizeDeck(result.deck)}`,
      meta: { exported: true, path: result.exported.path, bytes: result.exported.bytes, slides: result.exported.slides, filled: result.filledNow.length },
    };
  }
  const lines = [
    `PARTIAL deck — ${total - result.failures.length}/${total} slide(s) filled and valid. NOT exported: a partial deck is never exported. Fix the failed slides with update_slide (or re-run generate_deck_slides to resume them), then finish with export_deck.`,
  ];
  for (const failure of result.failures) {
    lines.push(`- ${failure.slideId} [${failure.layout}] "${failure.title}": ${failure.issues.join('; ')}`);
  }
  const deckLevel = result.deckIssues.filter((i) => i.severity === 'error' && !i.slideId);
  for (const issue of deckLevel) lines.push(`- deck: ${issue.message}`);
  if (result.exportError) lines.push(`export error: ${result.exportError}`);
  return { text: lines.join('\n'), meta: { exported: false, failures: result.failures, filled: result.filledNow.length } };
}

export function createSlidePipelineTools(getProvider: () => LLMProvider | undefined): ToolDefinition[] {
  const generateDeckOutlineTool: ToolDefinition = {
    name: 'generate_deck_outline',
    description:
      'STANDARD flow, step 1 (slide domain): generate the presentation outline with the built-in slide pipeline and persist it as a skeleton deck (deck/deck.json, one skeleton slide per outline item). Returns the outline and the bundled template choices for the design checkpoint: show the outline to the user, ask_user for the design direction, then call generate_deck_slides. Fails when a deck with slides already exists (continue it with generate_deck_slides instead).',
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
        slideCount: { type: 'integer', minimum: 1, maximum: 40 },
        language: { type: 'string' },
        templateId: { type: 'string' },
        purpose: { type: 'string' },
      },
      additionalProperties: false,
    },
    mutating: true,
    timeoutMs: PIPELINE_TIMEOUT_MS,
    async execute(args, context) {
      const provider = getProvider();
      if (!provider) return err(NO_PROVIDER);
      const brief = briefFromArgs(args);
      if ('error' in brief) return err(brief.error);
      try {
        const { deck, outline } = await generateDeckOutlineStage(provider, context.workspaceRoot, brief, { signal: context.signal });
        const lines = outline.map((item, i) => `${i + 1}. [${item.layoutId}] ${item.title} — ${item.keyMessage}`);
        return ok(
          [
            `Outline persisted as a skeleton deck (deck/deck.json, ${outline.length} slides awaiting fill). Show the user this outline and ask for the design direction with ask_user, then call generate_deck_slides (pass the chosen templateId).`,
            ...lines,
            `Template choices for the checkpoint: ${SLIDE_TEMPLATES.map((t) => `${t.id} — ${t.name}: ${t.description}`).join(' | ')} (or no template)`,
          ].join('\n'),
          { deck_id: deck.id, slides: outline.length, outline, templates: SLIDE_TEMPLATES.map((t) => t.id), exported: false },
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const generateDeckSlidesTool: ToolDefinition = {
    name: 'generate_deck_slides',
    description:
      'STANDARD flow, step 2 (slide domain) and resume: fill every skeleton or invalid slide of the current deck with the built-in slide pipeline (each slide persisted as it completes), validate the deck, and export the PPTX. Slides whose fill fails stay skeleton and are reported by id — re-running resumes exactly those slides. A partial deck is never exported. Pass templateId to apply the design direction the user picked at the checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        templateId: { type: 'string' },
      },
      additionalProperties: false,
    },
    mutating: true,
    timeoutMs: PIPELINE_TIMEOUT_MS,
    async execute(args, context) {
      const provider = getProvider();
      if (!provider) return err(NO_PROVIDER);
      const a = (args ?? {}) as { language?: unknown; templateId?: unknown };
      if (a.language !== undefined && typeof a.language !== 'string') return err('language must be a string');
      if (a.templateId !== undefined && typeof a.templateId !== 'string') return err('templateId must be a string');
      try {
        const result = await fillDeckSlidesStage(provider, context.workspaceRoot, {
          ...(typeof a.language === 'string' ? { language: a.language } : {}),
          ...(typeof a.templateId === 'string' ? { templateId: a.templateId } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const report = formatFillReport(result);
        return ok(report.text, report.meta);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const generateDeckTool: ToolDefinition = {
    name: 'generate_deck',
    description:
      'SMART flow (slide domain): generate a complete deck in one call — outline, per-slide fill, validation, and PPTX export all run inside the built-in slide pipeline; code owns the sequence, not the chat loop. Fails when a deck with slides already exists. A partial result persists as a skeleton deck and can be resumed with generate_deck_slides.',
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string' },
        slideCount: { type: 'integer', minimum: 1, maximum: 40 },
        language: { type: 'string' },
        templateId: { type: 'string' },
        purpose: { type: 'string' },
      },
      additionalProperties: false,
    },
    mutating: true,
    timeoutMs: PIPELINE_TIMEOUT_MS,
    async execute(args, context) {
      const provider = getProvider();
      if (!provider) return err(NO_PROVIDER);
      const brief = briefFromArgs(args);
      if ('error' in brief) return err(brief.error);
      try {
        const { outline, fill } = await generateDeckFullStage(provider, context.workspaceRoot, brief, { signal: context.signal });
        const report = formatFillReport(fill);
        return ok(`Pipeline outline: ${outline.length} slide(s).\n${report.text}`, report.meta);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [generateDeckOutlineTool, generateDeckSlidesTool, generateDeckTool];
}
