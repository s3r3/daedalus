import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    /** API key Elsevier (env ELSEVIER_API_KEY) — kuartil Scopus penuh. */
    elsevierApiKey?: string;
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
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&larr;/g, "←").replace(/&rarr;/g, "→")
    .replace(/&hellip;/g, "…").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
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
 * Preview sumber "kek pembaca pdf": semua tipe dokumen (PDF, DOCX/DOC/ODT,
 * halaman web, dll) disajikan sebagai PDF ke klien, yang me-render-nya
 * dengan PDF viewer bawaan browser. Tanpa thumbnail sidebar — untuk dibaca.
 */

export type ResearchDocKind = "pdf" | "office" | "html" | "unknown";

const OFFICE_EXTS = new Set([
  "doc", "docx", "odt", "rtf", "txt",
  "ppt", "pptx", "odp", "pps", "ppsx",
  "xls", "xlsx", "ods", "csv",
]);

const MAX_DOC_BYTES = 50 * 1024 * 1024;
const DOC_CONVERT_TIMEOUT_MS = 90_000;

/** Klasifikasi jenis dokumen dari ekstensi URL / content-type. */
export function detectResearchDocKind(url: string, contentType = ""): ResearchDocKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/pdf")) return "pdf";
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return "html";
  if (/officedocument|msword|ms-excel|ms-powerpoint|opendocument|\brtf\b|text\/plain|text\/csv/.test(ct)) {
    return "office";
  }
  const clean = url.split("?")[0]!.split("#")[0]!;
  const last = clean.split("/").pop() ?? "";
  const dotIdx = last.lastIndexOf(".");
  const ext = dotIdx > 0 ? last.slice(dotIdx + 1).toLowerCase() : "";
  if (ext === "pdf") return "pdf";
  if (OFFICE_EXTS.has(ext)) return "office";
  if (ext === "html" || ext === "htm" || ext === "") return "html";
  return "unknown";
}

/** Seam konversi dokumen → PDF (test menginject fake; produksi pakai tool asli). */
export type ResearchDocHooks = {
  fetchBytes(url: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  officeToPdf(bytes: Buffer, ext: string): Promise<Buffer | null>;
  htmlToPdf(url: string): Promise<Buffer | null>;
};

async function defaultFetchBytes(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Daedalus-Research/1.0 (research agent; contact: research)",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_DOC_BYTES) return null;
    return { bytes: buf, contentType: res.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** DOCX/DOC/ODT/dll → PDF via LibreOffice headless. */
async function defaultOfficeToPdf(bytes: Buffer, ext: string): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "daedalus-doc-"));
  try {
    const input = join(dir, `input.${ext || "docx"}`);
    await writeFile(input, bytes);
    await execFileAsync("soffice", [
      "--headless", "--nologo", "--nolockcheck",
      "--convert-to", "pdf", "--outdir", dir, input,
    ], DOC_CONVERT_TIMEOUT_MS);
    const pdf = await readFile(join(dir, "input.pdf"));
    return pdf.length > 0 ? pdf : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Halaman web → PDF via headless Chromium (print-to-PDF). */
async function defaultHtmlToPdf(url: string): Promise<Buffer | null> {
  let browser: { close(): Promise<void> } | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await (browser as import("playwright").Browser).newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    if (!res || !res.ok()) {
      await page.close().catch(() => undefined);
      return null;
    }
    await page.waitForTimeout(1500);
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    await page.close().catch(() => undefined);
    return pdf.length > 0 ? Buffer.from(pdf) : null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export function defaultResearchDocHooks(): ResearchDocHooks {
  return {
    fetchBytes: defaultFetchBytes,
    officeToPdf: defaultOfficeToPdf,
    htmlToPdf: defaultHtmlToPdf,
  };
}

/** Cache PDF hasil konversi (per URL, TTL 1 jam, cap 20 — PDF bisa besar). */
const DOC_PDF_CACHE_TTL_MS = 60 * 60 * 1000;
const DOC_PDF_CACHE_MAX = 20;
const docPdfCache = new Map<string, { pdf: Buffer; fetchedAt: number }>();

export function clearResearchDocCacheForTest(): void {
  docPdfCache.clear();
}

function getCachedDocPdf(url: string): Buffer | undefined {
  const entry = docPdfCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= DOC_PDF_CACHE_TTL_MS) {
    docPdfCache.delete(url);
    return undefined;
  }
  return entry.pdf;
}

function cacheDocPdf(url: string, pdf: Buffer): void {
  if (docPdfCache.size >= DOC_PDF_CACHE_MAX) {
    const oldest = docPdfCache.keys().next();
    if (!oldest.done) docPdfCache.delete(oldest.value);
  }
  docPdfCache.set(url, { pdf, fetchedAt: Date.now() });
}

export type ResearchSourceDocument =
  | { pdf: Buffer; title: string; kind: ResearchDocKind }
  | "report_not_found"
  | "source_not_found"
  | "unsupported"
  | null;

/**
 * Ambil satu sumber sebagai PDF untuk preview ala pembaca PDF:
 * PDF langsung, Office via LibreOffice, HTML via Chromium print-to-PDF.
 * Return "unsupported" bila tipe tak dikenal, null bila gagal diambil/dikonversi.
 */
export async function getResearchSourceDocument(
  reportId: string,
  sourceId: string,
  docHooks: ResearchDocHooks,
): Promise<ResearchSourceDocument> {
  const report = getResearchReport(reportId);
  if (!report) return "report_not_found";
  const source = report.sources.find((s) => s.id === sourceId);
  if (!source) return "source_not_found";
  const url = source.url;

  const cached = getCachedDocPdf(url);
  if (cached) return { pdf: cached, title: source.title || url, kind: "pdf" };

  const fetched = await docHooks.fetchBytes(url).catch(() => null);
  if (!fetched) return null;
  const kind = detectResearchDocKind(url, fetched.contentType);
  let pdf: Buffer | null = null;
  if (kind === "pdf") {
    pdf = fetched.bytes;
  } else if (kind === "office") {
    const clean = url.split("?")[0]!.split("#")[0]!;
    const ext = (clean.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "docx";
    pdf = await docHooks.officeToPdf(fetched.bytes, ext).catch(() => null);
  } else if (kind === "html") {
    pdf = await docHooks.htmlToPdf(url).catch(() => null);
  } else {
    return "unsupported";
  }
  if (!pdf || pdf.length === 0) return null;
  cacheDocPdf(url, pdf);
  return { pdf, title: source.title || url, kind };
}

/**
 * Probe apakah URL boleh di-embed dalam iframe (preview "kek buka di browser").
 * Cek header X-Frame-Options dan CSP frame-ancestors via HEAD. Konservatif:
 * ragu → false (klien fallback ke mode baca).
 */
export async function probeFrameable(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: "HEAD",
        signal: ctrl.signal,
        headers: { "User-Agent": "Daedalus-Research/1.0" },
        redirect: "follow",
      });
    } catch {
      res = null;
    } finally {
      clearTimeout(timer);
    }
    if (!res) return false;
    const xfo = (res.headers.get("x-frame-options") ?? "").toUpperCase();
    if (xfo.includes("DENY") || xfo.includes("SAMEORIGIN")) return false;
    const csp = res.headers.get("content-security-policy") ?? "";
    const fa = /frame-ancestors\s+([^;]+)/i.exec(csp);
    if (fa && !/\*/.test(fa[1] ?? "")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse hasil DuckDuckGo (dipakai lite + html endpoint — keduanya
 * memakai pola /l/?uddg=<url> atau link http langsung).
 * Exported untuk test.
 */
export function parseDdgHits(html: string): ResearchSearchHit[] {
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

/**
 * Default searchWeb: DuckDuckGo (tanpa API key, best-effort).
 * lite.duckduckgo.com kadang timeout/diblokir (diam-diam me-return
 * [] sebelumnya) — sekarang: retry sekali, fallback ke html endpoint.
 * Tetap [] bila semua gagal (engine me-retry dalam budget, bukan crash).
 * Halaman JS-heavy = limitasi MVP yang diketahui.
 */
async function defaultSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const urls = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ];
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchWithTimeout(url, "text/html");
      if (!res || !res.ok) continue;
      const html = await res.text();
      if (!html || html.length < 1000) continue; // challenge/block page
      const hits = parseDdgHits(html);
      if (hits.length > 0) return hits;
      break; // HTML valid tapi 0 hits — coba endpoint lain, bukan retry sia-sia
    }
  }
  return [];
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
 * Cache halaman ter-fetch (per URL, TTL 1 jam, cap 300): dipakai dua kali —
 * pipeline runResearch mengisinya saat executeStage, dan endpoint preview
 * sumber (`GET /research/report/:reportId/source/:sourceId/content`)
 * membacanya agar preview inline tidak me-refetch.
 */
const PAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const PAGE_CACHE_MAX = 300;
const fetchedPageCache = new Map<string, { title: string; text: string; fetchedAt: number }>();

export function cacheFetchedPage(url: string, title: string, text: string): void {
  if (fetchedPageCache.size >= PAGE_CACHE_MAX) {
    const oldest = fetchedPageCache.keys().next();
    if (!oldest.done) fetchedPageCache.delete(oldest.value);
  }
  fetchedPageCache.set(url, { title, text, fetchedAt: Date.now() });
}

export function getCachedFetchedPage(url: string): { title: string; text: string } | undefined {
  const entry = fetchedPageCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= PAGE_CACHE_TTL_MS) {
    fetchedPageCache.delete(url);
    return undefined;
  }
  return { title: entry.title, text: entry.text };
}

/** Test seam: kosongkan cache halaman. */
export function clearFetchedPageCacheForTest(): void {
  fetchedPageCache.clear();
}

/** fetchPage default yang mengisi cache — dipakai production hooks. */
async function cachedFetchPage(url: string): Promise<FetchedPage | null> {
  const cached = getCachedFetchedPage(url);
  if (cached) return { url, status: 200, title: cached.title, text: cached.text };
  const page = await defaultFetchPage(url);
  if (page && page.text) cacheFetchedPage(url, page.title, page.text);
  return page;
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
        fetch: { searchWeb: defaultSearchWeb, fetchPage: cachedFetchPage },
      });
      return engine.planResearch(question);
    },
    createEngine: async ({ provider, fetch, elsevierApiKey, onProgress }) => {
      const mod = await import("@daedalus/core/research/engine.ts");
      const engine = new mod.ResearchEngine({ provider, fetch, elsevierApiKey, onProgress });
      return engine as unknown as ResearchEngineSurface;
    },
    searchWeb: defaultSearchWeb,
    fetchPage: cachedFetchPage,
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
 *
 * Dipakai hanya saat run selesai (sukses/gagal); selama run berjalan
 * plan tetap di-peek agar retry/timeout tidak dibilang "kedaluwarsa".
 */
export function takeStagedResearchPlan(planId: string): StagedResearchPlan | undefined {
  const staged = peekStagedResearchPlan(planId);
  if (staged) stagedPlans.delete(planId);
  return staged;
}

/**
 * Run riset yang sedang berjalan, per planId. Mencegah double-submit:
 * request kedua untuk plan yang sama dijawab 409 already_running,
 * bukan 410 yang menyesatkan. Dibersihkan di finally setiap run.
 */
const researchRunsInProgress = new Set<string>();

/** true bila run untuk planId ini sudah berjalan (panggil sebelum run). */
export function isResearchRunInProgress(planId: string): boolean {
  return researchRunsInProgress.has(planId);
}

/** Tandai run dimulai; kembalikan false bila sudah ada yang berjalan. */
export function tryStartResearchRun(planId: string): boolean {
  if (researchRunsInProgress.has(planId)) return false;
  researchRunsInProgress.add(planId);
  return true;
}

/** Tandai run selesai (finally) — plan tetap dihapus via takeStagedResearchPlan. */
export function finishResearchRun(planId: string): void {
  researchRunsInProgress.delete(planId);
}

/**
 * reportId per planId yang run-nya selesai — untuk recovery client
 * yang request-nya putus di tengah jalan (timeout/proxy). TTL 1 jam.
 */
const researchRunReports = new Map<string, { reportId: string; at: number }>();
const RESEARCH_RUN_REPORT_TTL_MS = 60 * 60 * 1000;

export function rememberResearchRunReport(planId: string, reportId: string): void {
  researchRunReports.set(planId, { reportId, at: Date.now() });
  if (researchRunReports.size > 100) {
    const oldest = [...researchRunReports.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) researchRunReports.delete(oldest[0]);
  }
}

export function getResearchRunReportId(planId: string): string | undefined {
  const entry = researchRunReports.get(planId);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= RESEARCH_RUN_REPORT_TTL_MS) {
    researchRunReports.delete(planId);
    return undefined;
  }
  return entry.reportId;
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

/** Konten sumber untuk preview inline di panel tengah (embed browser / mode baca). */
export interface ResearchSourceContent {
  url: string;
  title: string;
  text: string;
  cached: boolean;
  isPdf: boolean;
  /** true bila halaman boleh di-embed iframe (preview "kek buka di browser"). */
  frameable: boolean;
}

/**
 * Ambil konten satu sumber untuk preview: dari cache fetch pipeline bila ada,
 * else fetch live sekali via hooks lalu cache. Selalu sertakan hasil probe
 * frameable (boleh di-iframe "kek buka di browser" atau tidak). PDF tidak
 * di-fetch teksnya — klien me-embed URL-nya langsung.
 * Return "report_not_found" | "source_not_found" | null (tak bisa diambil).
 */
export async function getResearchSourceContent(
  reportId: string,
  sourceId: string,
  hooks: Pick<ResearchCoreHooks, "fetchPage">,
): Promise<ResearchSourceContent | "report_not_found" | "source_not_found" | null> {
  const report = getResearchReport(reportId);
  if (!report) return "report_not_found";
  const source = report.sources.find((s) => s.id === sourceId);
  if (!source) return "source_not_found";
  const url = source.url;
  const isPdf = /\.pdf(?:[?#]|$)/i.test(url);
  const frameable = await probeFrameable(url);
  if (isPdf) {
    return { url, title: source.title || url, text: "", cached: false, isPdf: true, frameable };
  }
  const cached = getCachedFetchedPage(url);
  if (cached) {
    return { url, title: source.title || cached.title, text: cached.text, cached: true, isPdf: false, frameable };
  }
  const page = await hooks.fetchPage(url).catch(() => null);
  if (page && page.text) {
    cacheFetchedPage(url, page.title, page.text);
    return { url, title: source.title || page.title, text: page.text, cached: false, isPdf: false, frameable };
  }
  return null;
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
