import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderForConfig } from "@s3r3/core";
import type { EventBus, LLMProvider, TaskStore } from "@s3r3/core";
// Contract types from the parallel core worker (core/src/research/*).
// Type-only imports: erased at runtime, so the missing modules break
// typecheck (expected until the core worker lands) but never break
// runtime or tests. Value access goes through the lazy dynamic imports
// in defaultResearchHooks() below.
import type { ResearchPlan, ResearchReport } from "@s3r3/core/research/types.ts";
import type {
  FetchedPage,
  ResearchFetchHooks,
  ResearchPipelineResult,
  ResearchStageId,
  ResearchSearchHit,
} from "@s3r3/core/research/pipeline.ts";
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
 * Semua akses LLM lewat createProviderForConfig dari @s3r3/core;
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
    /** Cooperative pause (Dae Captain pill ⏸) — diteruskan ke pipeline. */
    waitWhilePaused?: () => Promise<void>;
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

async function fetchWithTimeout(url: string, accept: string, userAgent?: string): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": userAgent ?? "Daedalus-Research/1.0 (research agent; contact: research)",
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
 * Backend pencarian gratis (permintaan Farid 2026-10-12: "semuanya aja").
 * Urutan: Brave (2rb/bln gratis) -> Tavily (1rb/bln gratis) -> Google CSE
 * (100/hari gratis) -> DuckDuckGo (tanpa key, best-effort). Backend yang
 * tidak punya key di-skip diam-diam; yang gagal dilempar ke berikutnya.
 * Tanpa key sama sekali = perilaku DDG lama (tidak berubah).
 */

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

interface SearchBackendHit { url: string; title: string }

/** Decode entitas HTML/XML umum (dipakai parser RSS/Atom). */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Bing RSS (tanpa key, tanpa daftar): pengganti DuckDuckGo untuk web umum.
 * Exported untuk test.
 */
export async function bingRssSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  // Bing mengembalikan RSS kosong untuk UA non-browser — pakai UA browser.
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
    "application/rss+xml",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  );
  if (!res || !res.ok) return [];
  const xml = await res.text();
  if (!xml || !xml.includes("<item")) return [];
  const hits: ResearchSearchHit[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1] ?? "";
    const link = (/<link>([\s\S]*?)<\/link>/i.exec(item)?.[1] ?? "").trim();
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const key = link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = decodeEntities((/<title>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? "").trim()).slice(0, 200);
    const snippet = decodeEntities((/<description>([\s\S]*?)<\/description>/i.exec(item)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300);
    hits.push({ url: link, title: title || link, snippet: snippet || undefined });
    if (hits.length >= 10) break;
  }
  return hits;
}

/**
 * OpenAlex (tanpa key, tanpa daftar): karya ilmiah — cocok untuk riset akademik.
 * Exported untuk test.
 */
export async function openAlexSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const res = await fetchWithTimeout(
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=10&select=id,doi,title,publication_year,cited_by_count`,
    "application/json",
  );
  if (!res || !res.ok) return [];
  try {
    const data = (await res.json()) as {
      results?: Array<{ doi?: string | null; title?: string | null; publication_year?: number; cited_by_count?: number }>;
    };
    const hits: ResearchSearchHit[] = [];
    for (const w of data.results ?? []) {
      if (!w?.doi || !w.title) continue;
      const doi = w.doi.replace(/^https?:\/\/doi\.org\//i, "");
      const meta = [
        w.publication_year ? String(w.publication_year) : "",
        typeof w.cited_by_count === "number" ? `disitasi ${w.cited_by_count}x` : "",
      ].filter(Boolean).join(" · ");
      hits.push({ url: `https://doi.org/${doi}`, title: w.title, snippet: meta || undefined });
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Crossref (tanpa key, tanpa daftar): karya ilmiah berbasis DOI.
 * Exported untuk test.
 */
export async function crossrefSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const res = await fetchWithTimeout(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=10&select=DOI,title,URL`,
    "application/json",
  );
  if (!res || !res.ok) return [];
  try {
    const data = (await res.json()) as {
      message?: { items?: Array<{ DOI?: string; title?: string[]; URL?: string }> };
    };
    const hits: ResearchSearchHit[] = [];
    for (const it of data.message?.items ?? []) {
      const title = it.title?.[0]?.trim();
      if (!it.DOI || !title) continue;
      hits.push({ url: it.URL || `https://doi.org/${it.DOI}`, title });
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * arXiv (tanpa key, tanpa daftar): preprint — relevan untuk topik ML/AI terkini.
 * Exported untuk test.
 */
export async function arxivSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const res = await fetchWithTimeout(
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=10&sortBy=relevance&sortOrder=descending`,
    "application/atom+xml",
  );
  if (!res || !res.ok) return [];
  const xml = await res.text();
  if (!xml || !xml.includes("<entry")) return [];
  const hits: ResearchSearchHit[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const entry = m[1] ?? "";
    const id = (/<id>([\s\S]*?)<\/id>/i.exec(entry)?.[1] ?? "").trim();
    if (!id || !/^https?:\/\//i.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = decodeEntities((/<title>([\s\S]*?)<\/title>/i.exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
    const published = (/<published>([\s\S]*?)<\/published>/i.exec(entry)?.[1] ?? "").slice(0, 10);
    hits.push({ url: id, title: title || id, snippet: published ? `arXiv · ${published}` : "arXiv" });
    if (hits.length >= 10) break;
  }
  return hits;
}

async function braveSearchWeb(query: string, apiKey: string): Promise<SearchBackendHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
      signal: ctrl.signal,
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json() as { web?: { results?: Array<{ url?: string; title?: string }> } };
    const out: SearchBackendHit[] = [];
    for (const r of data.web?.results ?? []) {
      if (r.url && /^https?:\/\//i.test(r.url)) out.push({ url: r.url, title: r.title ?? r.url });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function tavilySearchWeb(query: string, apiKey: string): Promise<SearchBackendHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 10, search_depth: 'basic' }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: Array<{ url?: string; title?: string }> };
    const out: SearchBackendHit[] = [];
    for (const r of data.results ?? []) {
      if (r.url && /^https?:\/\//i.test(r.url)) out.push({ url: r.url, title: r.title ?? r.url });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function googleCseSearchWeb(query: string, apiKey: string, cx: string): Promise<SearchBackendHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=10`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return [];
    const data = await res.json() as { items?: Array<{ link?: string; title?: string }> };
    const out: SearchBackendHit[] = [];
    for (const r of data.items ?? []) {
      if (r.link && /^https?:\/\//i.test(r.link)) out.push({ url: r.link, title: r.title ?? r.link });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default searchWeb: rantai backend gratis.
 * Brave -> Tavily -> Google CSE -> DuckDuckGo (tanpa key, best-effort) ->
 * rantai keyless tanpa daftar: Bing RSS (web umum) -> OpenAlex ->
 * Crossref -> arXiv (ilmiah). Backend tanpa key di-skip; yang gagal
 * dilempar ke berikutnya.
 * Env: BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, GOOGLE_CSE_API_KEY +
 * GOOGLE_CSE_CX. Tetap [] bila semua gagal (bukan crash).
 */
async function defaultSearchWeb(query: string): Promise<ResearchSearchHit[]> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY || "";
  if (braveKey) {
    const hits = await braveSearchWeb(query, braveKey);
    if (hits.length > 0) return hits;
  }
  const tavilyKey = process.env.TAVILY_API_KEY || "";
  if (tavilyKey) {
    const hits = await tavilySearchWeb(query, tavilyKey);
    if (hits.length > 0) return hits;
  }
  const cseKey = process.env.GOOGLE_CSE_API_KEY || "";
  const cseCx = process.env.GOOGLE_CSE_CX || "";
  if (cseKey && cseCx) {
    const hits = await googleCseSearchWeb(query, cseKey, cseCx);
    if (hits.length > 0) return hits;
  }
  // DuckDuckGo tanpa key: retry sekali, fallback html endpoint.
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
  // Rantai keyless tanpa daftar — untuk kasus DDG diblokir jaringan.
  const bingHits = await bingRssSearchWeb(query);
  if (bingHits.length > 0) return bingHits;
  const openAlexHits = await openAlexSearchWeb(query);
  if (openAlexHits.length > 0) return openAlexHits;
  const crossrefHits = await crossrefSearchWeb(query);
  if (crossrefHits.length > 0) return crossrefHits;
  const arxivHits = await arxivSearchWeb(query);
  if (arxivHits.length > 0) return arxivHits;
  return [];
}

/**
 * Fetch via curl (subprocess) dengan header browser. Beberapa situs/WAF
 * memblokir fingerprint TLS Node tapi meloloskan curl — jalur fallback
 * saat Node fetch gagal. Exported untuk test. Nonaktif via env
 * DAEDALUS_RESEARCH_CURL=0.
 */
export async function curlFetchPage(url: string): Promise<FetchedPage | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const html = await new Promise<string>((resolve, reject) => {
      execFile(
        "curl",
        [
          "-sL", "--max-time", "25",
          "-A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "-H", "Accept-Language: id-ID,id;q=0.9,en;q=0.8",
          "--compressed",
          url,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    if (!html || html.length < 500) return null;
    const { title, text } = stripToText(html);
    if (!text) return null;
    return { url, status: 200, title, text };
  } catch {
    return null;
  }
}

/**
 * Default fetchPage: fetch server-side + ekstraksi teks.
 * Jalur 1: Node fetch. Jalur 2 (fallback): curl — untuk situs yang
 * memblokir Node tapi meloloskan curl. Bisa dimatikan via env
 * DAEDALUS_RESEARCH_CURL=0.
 */
async function defaultFetchPage(url: string): Promise<FetchedPage | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const res = await fetchWithTimeout(url, "text/html,application/xhtml+xml");
  if (res && res.status === 200) {
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType || /text\/html|application\/xhtml/i.test(contentType)) {
      const html = await res.text();
      if (html) {
        const { title, text } = stripToText(html);
        if (text) return { url, status: res.status, title, text };
      }
    }
  }
  if (process.env.DAEDALUS_RESEARCH_CURL === "0") return null;
  return curlFetchPage(url);
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
      const mod = await import("@s3r3/core/research/engine.ts");
      const engine = new mod.ResearchEngine({
        provider,
        fetch: { searchWeb: defaultSearchWeb, fetchPage: cachedFetchPage },
      });
      return engine.planResearch(question);
    },
    createEngine: async ({ provider, fetch, elsevierApiKey, onProgress, waitWhilePaused }) => {
      const mod = await import("@s3r3/core/research/engine.ts");
      const engine = new mod.ResearchEngine({ provider, fetch, elsevierApiKey, onProgress, waitWhilePaused });
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
  /** Dae Captain v2 Fase 7 — kedalaman yang dipilih di kartu [Cepat][Standar][Mendalam]. */
  depth?: string;
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
