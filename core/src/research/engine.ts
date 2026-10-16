import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../providers/llm/types.ts';
import { briefStage, planStage, runResearchPipeline, type ResearchFetchHooks, type ResearchPipelineResult, type ResearchStageId } from './pipeline.ts';
import type { ResearchPlan } from './types.ts';

/**
 * ResearchEngine — domain ke-5 Daedalus (Agentic Research).
 *
 * Doktrin Slide: TOTAL terpisah dari coding agent loop/runtime —
 * file ini (dan seluruh core/src/research/) tidak mengimport
 * agent loop, tool registry, atau runtime coding sedikitpun.
 * Semua akses LLM lewat LLMProvider yang di-inject; semua akses
 * web lewat ResearchFetchHooks yang di-inject.
 */
export interface ResearchEngineOptions {
  provider: LLMProvider;
  fetch: ResearchFetchHooks;
  /** API key Elsevier — diteruskan ke evidence stage untuk kuartil Scopus. */
  elsevierApiKey?: string;
  signal?: AbortSignal;
  onProgress?: (stage: ResearchStageId, detail: string) => void;
  /**
   * Cooperative pause (Dae Captain pill ⏸): awaited at every pipeline
   * stage boundary; suspends until the pause marker is cleared.
   */
  waitWhilePaused?: () => Promise<void>;
}

export class ResearchEngine {
  private readonly provider: LLMProvider;
  private readonly fetchHooks: ResearchFetchHooks;
  private readonly elsevierApiKey?: string;
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (stage: ResearchStageId, detail: string) => void;
  private readonly waitWhilePaused?: () => Promise<void>;

  constructor(options: ResearchEngineOptions) {
    this.provider = options.provider;
    this.fetchHooks = options.fetch;
    this.elsevierApiKey = options.elsevierApiKey;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
    this.waitWhilePaused = options.waitWhilePaused;
  }

  /**
   * Stage 1–2: brief + plan. Dipanggil server di POST /research/plan;
   * hasilnya di-stage untuk ★ GATE ("Jalankan riset").
   */
  async planResearch(question: string): Promise<ResearchPlan> {
    const brief = await briefStage(this.provider, question, this.signal);
    this.onProgress?.('brief', `brief: ${brief.language}, kompleksitas ${brief.intent.complexity}`);
    const spec = await planStage(this.provider, brief, this.signal);
    this.onProgress?.('plan', `${spec.subQuestions.length} sub-pertanyaan`);
    return {
      ...spec,
      planId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Stage 3–8: execute → evidence → verify → synthesize → gate →
   * compile. Dipanggil server di POST /research/run SETELAH user
   * menekan "Jalankan riset" di gate.
   */
  async runResearch(plan: ResearchPlan): Promise<ResearchPipelineResult> {
    return runResearchPipeline({
      plan,
      provider: this.provider,
      fetch: this.fetchHooks,
      elsevierApiKey: this.elsevierApiKey,
      signal: this.signal,
      onProgress: this.onProgress,
      ...(this.waitWhilePaused ? { waitWhilePaused: this.waitWhilePaused } : {}),
    });
  }
}
