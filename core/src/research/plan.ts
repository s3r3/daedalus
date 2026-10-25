import type { LLMProvider } from '../providers/llm/types.ts';
import { structuredCall } from '../sheets/pipeline.ts';
import { validateResearchPlan, type ResearchLanguage, type ResearchPlan } from './types.ts';

/**
 * Two-call research planner (pola Analis: cheap classifier call, lalu
 * spec call). Model HANYA mengeluarkan spec JSON — brief yang
 * dinormalisasi + dekomposisi sub-pertanyaan + strategi sumber. Tidak
 * ada fakta, angka, atau klaim di tahap ini: klaim hanya lahir dari
 * evidence pool di stage Execute/Verify.
 */

export type ResearchComplexity = 'simple' | 'moderate' | 'complex';

export interface ResearchIntent {
  complexity: ResearchComplexity;
  language: ResearchLanguage;
  /** Topik butuh sumber primer/akademik (jurnal) vs web umum. */
  needsScholarly: boolean;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const CLASSIFY_SYSTEM = [
  'You triage a research question. Output exactly one JSON object and nothing else.',
  'Shape: {"complexity": "simple"|"moderate"|"complex", "language": "id"|"en", "needsScholarly": boolean}',
  '- complexity: simple = one focused question answerable from a few sources;',
  '  moderate = several sub-questions or a comparison needing 5-15 sources;',
  '  complex = broad topic, literature-review-like, many sub-questions, 15+ sources.',
  '- language: "id" if the question is Indonesian, "en" otherwise.',
  '- needsScholarly: true if the question is academic/scientific and needs journals',
  '  (Scopus/Sinta/DOAJ); false for general web topics (products, news, how-tos).',
].join('\n');

/**
 * Call 1 — cheap intent/language routing. Retry budget = shared
 * MAX_STAGE_ATTEMPTS di dalam structuredCall.
 */
export async function classifyResearchIntent(
  provider: LLMProvider,
  question: string,
  signal?: AbortSignal,
): Promise<ResearchIntent> {
  return structuredCall<ResearchIntent>(
    provider,
    CLASSIFY_SYSTEM,
    `Question: ${question}`,
    (value): Verdict<ResearchIntent> => {
      if (!isObj(value)) return { ok: false, issues: ['expected a JSON object'] };
      if (!['simple', 'moderate', 'complex'].includes(String(value.complexity))) {
        return { ok: false, issues: ['complexity must be "simple"|"moderate"|"complex"'] };
      }
      if (value.language !== 'id' && value.language !== 'en') {
        return { ok: false, issues: ['language must be "id" or "en"'] };
      }
      if (typeof value.needsScholarly !== 'boolean') {
        return { ok: false, issues: ['needsScholarly must be a boolean'] };
      }
      return {
        ok: true,
        value: {
          complexity: value.complexity as ResearchComplexity,
          language: value.language,
          needsScholarly: value.needsScholarly,
        },
      };
    },
    signal,
  );
}

const PLAN_SYSTEM = [
  'You are the planner of an agentic deep-research engine. You output exactly one JSON object and nothing else.',
  'Shape: {"question": string, "language": "id"|"en", "subQuestions": [{"id": "sq1", "text": string, "rationale": string}], "sourceStrategy": string, "budget": {"maxQueries": number, "maxSources": number}}',
  'Rules:',
  '- question: the user question normalized into a crisp research brief (scope, timeframe if implied).',
  '- subQuestions: decompose the brief into searchable sub-questions a web search can answer.',
  '  2-4 for simple, 4-7 for moderate, 6-10 for complex. Each text must be a standalone search-ready question.',
  '- sourceStrategy: where to look (e.g. "prioritaskan jurnal Sinta/Scopus via DOI; web umum untuk konteks").',
  '- budget: maxQueries 4-12, maxSources 8-30 — scale with complexity. NEVER exceed 12 queries / 30 sources.',
  '- Write question/subQuestions/sourceStrategy in the brief language ("id" default for Indonesian users).',
  '- NEVER include facts, numbers, citations, or claims — structure only. Claims come from fetched evidence later.',
].join('\n');

/** Call 2 — emit the ResearchPlan spec (tanpa planId/createdAt; engine yang men-stamp). */
export async function generateResearchPlan(  provider: LLMProvider,
  question: string,
  intent: ResearchIntent,
  signal?: AbortSignal,
): Promise<Omit<ResearchPlan, 'planId' | 'createdAt'>> {
  return structuredCall<Omit<ResearchPlan, 'planId' | 'createdAt'>>(
    provider,
    PLAN_SYSTEM,
    [
      `Question: ${question}`,
      `Intent: complexity=${intent.complexity}, language=${intent.language}, needsScholarly=${intent.needsScholarly}`,
    ].join('\n'),
    (value) => validateResearchPlan(value),
    signal,
  );
}
