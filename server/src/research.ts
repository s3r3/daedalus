import { randomUUID } from "node:crypto";
import { createProviderForConfig } from "@daedalus/core";
import type { EventBus, LLMProvider, TaskStore } from "@daedalus/core";
// Contract types from the parallel core worker (core/src/research/*).
// Type-only imports: erased at runtime, so the missing modules break
// typecheck (expected until the core worker lands) but never break
// runtime or tests. Value access goes through the lazy dynamic imports
// in defaultResearchHooks() below.
import type { ResearchPlan, ResearchReport } from "@daedalus/core/research/types.ts";
import type {
  FetchedPage,
  ResearchFetchHooks,
  ResearchPipelineResult,
  ResearchStageId,
  ResearchSearchHit,
} from "@daedalus/core/research/pipeline.ts";
import type { AppContext } from "./app.ts";

/**
 * Agentic Research (domain ke-5) — server-side staging + run plumbing.
 *
 * Pola yang sama dengan Mode Analis (sheets-analyze.ts): tepat SATU
 * confirmation gate di rencana. POST /research/plan men-stage rencana
 * riset untuk review; user menekan "Jalankan riset" → POST
 * /research/run. Setelah gate, execute → evidence → verify →
 * synthesize → gate → compile adalah mesin deterministik, bukan
 * keputusan user. Kegagalan verify gate = 422 dan laporan TIDAK
 * PERNAH dikembalikan dengan klaim tak terverifikasi.
 *
 * Hard boundary (check.sh): file ini tidak boleh mengimport coding
 * agent loop, provider class, atau tool registry secara langsung.
 * Semua akses LLM lewat createProviderForConfig dari @daedalus/core;
 * semua akses web lewat ResearchFetchHooks yang di-inject.
 */

/** Engine surface yang dibutuhkan server (disediakan core ResearchEngine). */
export type ResearchEngineSurface = {
  planResearch(question: string): Promise<ResearchPlan>;
  runResearch(plan: ResearchPlan): Promise<ResearchPipelineResult>;
};

export type ResearchCoreHooks = {
  planResearch(args: { question: string; provider: LLMProvider }): Promise<ResearchPlan>;
  createEngine(args: {
    provider: LLMProvider;
    fetch: ResearchFetchHooks;
    onProgress?: (stage: ResearchStageId, detail: string) => void;
  }): Promise<ResearchEngineSurface>;
  searchWeb(query: string): Promise<ResearchSearchHit[]>;
  fetchPage(url: string): Promise<FetchedPage | null>;
};

const FETCH_TIMEOUT_MS = 20_000;

function stripToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300})<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, " ").trim() : "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: text.slice(0, 60_000) };
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Daedalus-Research/1.0 (research agent; contact: research)",
        Accept: accept,
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

/**
 * Default searchWeb: DuckDuckGo lite (tanpa API key, best-effort).
 * Gagal/berubah markup → [] (engine me-retry dalam budget, bukan crash).
 * Halaman JS-heavy = limitasi MVP yang diketahui.
 */
async function defaultSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const res = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, "text/html");
  if (!res || !res.ok) return [];
  const html = await res.text();
  const hits: ResearchSearchHit[] = [];
  const seen = new Set<string>();
  // DDG lite: <a href="/l/?uddg=<url>&rut=...">title</a>
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{1,200}?)<\/a>/gi)) {
    const href = m[1] ?? "";
    let url = "";
    const uddg = /[?&]uddg=([^&"]+)/.exec(href);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1] ?? ""); } catch { url = ""; }
    } else if (/^https?:\/\//i.test(href)) {
      url = href;
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (url.includes("duckduckgo.com")) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    hits.push({ url, title: title || url });
    if (hits.length >= 10) break;
  }
  return hits;
}

/** Default fetchPage: fetch server-side + ekstraksi teks. */
async function defaultFetchPage(url: string): Promise<FetchedPage | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const res = await fetchWithTimeout(url, "text/html,application/xhtml+xml");
  if (!res || res.status !== 200) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(contentType) && contentType) return null;
  const html = await res.text();
  if (!html) return null;
  const { title, text } = stripToText(html);
  if (!text) return null;
  return { url, status: res.status, title, text };
}

/**
 * Production hooks: setiap value import lazy agar require modul ini
 * tidak menyentuh modul kontrak core — hanya di-load saat request
 * nyata mengalir tanpa fake yang di-inject.
 */
export function defaultResearchHooks(): ResearchCoreHooks {
  return {
    planResearch: async ({ question, provider }) => {
      const mod = await import("@daedalus/core/research/engine.ts");
      const engine = new mod.ResearchEngine({
        provider,
        fetch: { searchWeb: defaultSearchWeb, fetchPage: defaultFetchPage },
      });
      return engine.planResearch(question);
    },
    createEngine: async ({ provider, fetch, onProgress }) => {
      const mod = await import("@daedalus/core/research/engine.ts");
      const engine = new mod.ResearchEngine({ provider, fetch, onProgress });
      return engine as unknown as ResearchEngineSurface;
    },
    searchWeb: defaultSearchWeb,
    fetchPage: defaultFetchPage,
  };
}

export async function resolveResearchHooks(ctx: AppContext): Promise<ResearchCoreHooks> {
  return ctx.researchHooks ?? defaultResearchHooks();
}

/**
 * Provider resolution untuk request riset — pola yang sama dengan
 * /diff/review dan /sheets/analyze/*: provider_id/model eksplisit di
 * body, lalu pilihan sesi, lalu provider enabled di registry, lalu
 * legacy settings baseUrl. Undefined bila tak ada yang terkonfigurasi
 * (caller menjawab 400 no_provider_configured).
 */
export function researchProviderFromRequest(
  ctx: AppContext,
  parsed: Record<string, unknown>,
): LLMProvider | undefined {
  const registry = ctx.providerStore.registry;
  const providerId =
    typeof parsed.provider_id === "string"
      ? parsed.provider_id
      : typeof parsed.providerId === "string"
        ? parsed.providerId
        : ctx.session.providerId;
  const config =
    (providerId ? registry.get(providerId) : undefined) ??
    registry.listInternal().find((provider) => provider.enabled);
  const model =
    typeof parsed.model === "string"
      ? parsed.model
      : (ctx.session.model ?? config?.defaultModel ?? config?.models[0] ?? ctx.settings.llm.model);
  if (!config && !ctx.settings.llm.baseUrl) return undefined;
  const providerOptions = { defaultTimeoutMs: ctx.settings.llm.timeoutMs ?? undefined };
  return config
    ? createProviderForConfig(config, model, providerOptions)
    : createProviderForConfig(
        { baseUrl: ctx.settings.llm.baseUrl, apiKey: ctx.settings.llm.apiKey },
        model,
        providerOptions,
      );
}

/** Satu staged research plan — state dari single confirmation gate. */
export type StagedResearchPlan = {
  planId: string;
  question: string;
  workspaceRoot: string;
  plan: ResearchPlan;
  createdAt: number;
};

/** Staged plan hidup 30 menit; sweep periodik membuang yang kedaluwarsa. */
export const STAGED_RESEARCH_PLAN_TTL_MS = 30 * 60 * 1000;
const STAGED_RESEARCH_PLAN_SWEEP_MS = 5 * 60 * 1000;

const stagedPlans = new Map<string, StagedResearchPlan>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function ensureSweepRunning(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepStagedResearchPlans();
  }, STAGED_RESEARCH_PLAN_SWEEP_MS);
  sweepTimer.unref();
}

/** Drop setiap staged plan yang lebih tua dari TTL. Exported untuk test. */
export function sweepStagedResearchPlans(now: number = Date.now()): number {
  let dropped = 0;
  for (const [planId, staged] of stagedPlans) {
    if (now - staged.createdAt >= STAGED_RESEARCH_PLAN_TTL_MS) {
      stagedPlans.delete(planId);
      dropped += 1;
    }
  }
  return dropped;
}

export function stageResearchPlan(input: Omit<StagedResearchPlan, "planId" | "createdAt">): StagedResearchPlan {
  ensureSweepRunning();
  const staged: StagedResearchPlan = { ...input, planId: randomUUID(), createdAt: Date.now() };
  stagedPlans.set(staged.planId, staged);
  return staged;
}

/** Baca tanpa consume (GET /research/plan/:planId). */
export function peekStagedResearchPlan(planId: string): StagedResearchPlan | undefined {
  const staged = stagedPlans.get(planId);
  if (!staged) return undefined;
  if (Date.now() - staged.createdAt >= STAGED_RESEARCH_PLAN_TTL_MS) {
    stagedPlans.delete(planId);
    return undefined;
  }
  return staged;
}

/**
 * Consume staged plan untuk run (single-use gate). Undefined bila
 * hilang/kedaluwarsa — caller menjawab 410.
 */
export function takeStagedResearchPlan(planId: string): StagedResearchPlan | undefined {
  const staged = peekStagedResearchPlan(planId);
  if (staged) stagedPlans.delete(planId);
  return staged;
}

/**
 * Kegagalan verify gate di dalam engine.runResearch harus surface
 * sebagai 422. Konvensi dengan core: error membawa code ===
 * "verify_failed" (atau name "ResearchVerifyError") plus array
 * `issues`. Selain itu = failure tak terduga dengan statusnya
 * sendiri. Mengembalikan array issues, atau null bila bukan
 * verify failure.
 */
export function researchVerifyIssues(error: unknown): unknown[] | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code !== "verify_failed" && name !== "ResearchVerifyError") return null;
  return Array.isArray(record.issues) ? record.issues : [];
}

/** Test-only: paksa staged plan kedaluwarsa. Tidak dipakai route. */
export function expireStagedResearchPlanForTest(planId: string): boolean {
  const staged = stagedPlans.get(planId);
  if (!staged) return false;
  staged.createdAt = Date.now() - STAGED_RESEARCH_PLAN_TTL_MS - 1;
  return true;
}

/* --------------------------------------------- completed reports */

export type ResearchProgressEvent = { stage: string; detail: string; at: number };

/** Laporan selesai hidup 24 jam; klien mengambilnya via GET /research/report/:reportId. */
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const completedReports = new Map<string, { report: ResearchReport; createdAt: number }>();
const progressLog = new Map<string, ResearchProgressEvent[]>();

function sweepCompletedReports(now: number = Date.now()): void {
  for (const [id, entry] of completedReports) {
    if (now - entry.createdAt >= REPORT_TTL_MS) {
      completedReports.delete(id);
      progressLog.delete(id);
    }
  }
}

export function storeResearchReport(report: ResearchReport): void {
  sweepCompletedReports();
  completedReports.set(report.reportId, { report, createdAt: Date.now() });
}

export function getResearchReport(reportId: string): ResearchReport | undefined {
  const entry = completedReports.get(reportId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt >= REPORT_TTL_MS) {
    completedReports.delete(reportId);
    progressLog.delete(reportId);
    return undefined;
  }
  return entry.report;
}

/** Progres live per run (panel kiri me-poll GET /research/progress/:key). */
export function appendResearchProgress(key: string, stage: string, detail: string): void {
  const log = progressLog.get(key) ?? [];
  log.push({ stage, detail, at: Date.now() });
  progressLog.set(key, log.slice(-200));
}

export function getResearchProgress(key: string): ResearchProgressEvent[] {
  return progressLog.get(key) ?? [];
}

export function clearResearchProgress(key: string): void {
  progressLog.delete(key);
}

// Re-export tipe kontrak agar route di app.ts tidak perlu import core langsung.
export type { ResearchPlan, ResearchReport };
export type { EventBus, TaskStore };
