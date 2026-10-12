import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../providers/llm/types.ts';
import { MAX_STAGE_ATTEMPTS, structuredCall } from '../sheets/pipeline.ts';
import { classifyResearchIntent, generateResearchPlan, type ResearchIntent } from './plan.ts';
import { runVerifyGate, type EvidenceEntry, type VerifyGateResult } from './verify.ts';
import { assessCredibility, defaultCredibilityFetch, type CredibilityFetcher } from './credibility.ts';
import { buildBibliography } from './bibliography.ts';
import {
  validateResearchPlan,
  type ResearchClaim,
  type ResearchLanguage,
  type ResearchPlan,
  type ResearchReport,
  type ResearchSource,
  type SourceConflict,
} from './types.ts';

/**
 * Frozen Research orchestration (pola DataInterpreter/gpt-researcher,
 * diimplementasi ulang di atas ResearchEngine): urutan stage hidup di
 * kode — Brief → Plan → Execute → Evidence → Verify → Synthesize →
 * Gate → Compile — dan model hanya mengisi slot JSON di dalam stage
 * plan/extract/synthesize. Klaim ditulis engine dari evidence pool;
 * fakta mentah model TIDAK PERNAH dibekukan jadi klaim.
 *
 * ★ GATE ada di antara Plan dan Execute, di server: plan di-stage,
 * user klik "Jalankan riset", baru runResearch dipanggil.
 */

export type ResearchStageId =
  | 'brief' | 'plan' | 'execute' | 'evidence'
  | 'verify' | 'synthesize' | 'gate' | 'compile';

export interface ResearchSearchHit {
  url: string;
  title: string;
  snippet?: string;
}

export interface FetchedPage {
  url: string;
  status: number;
  title: string;
  /** Teks hasil ekstraksi (sudah bersih dari markup). */
  text: string;
}

/**
 * Seam fetch (pola AnalysisCoreHooks): server menginject
 * implementasi default; test menginject fake.
 */
export interface ResearchFetchHooks {
  searchWeb(query: string, signal?: AbortSignal): Promise<ResearchSearchHit[]>;
  fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage | null>;
}

export interface ResearchPipelineInput {
  /** Plan yang sudah di-review user di gate (di-validasi ulang di sini). */
  plan: ResearchPlan;
  provider: LLMProvider;
  fetch: ResearchFetchHooks;
  credibilityFetch?: CredibilityFetcher;
  signal?: AbortSignal;
  onProgress?: (stage: ResearchStageId, detail: string) => void;
}

export interface ResearchPipelineResult {
  report: ResearchReport;
  gate: VerifyGateResult;
}

/** Batas keras paralelisme fetch (dzhng/deep-research: breadth terbatas). */
const FETCH_CONCURRENCY = 4;
/** Potongan teks per sumber yang dilihat model (konteks). */
const MAX_SOURCE_CHARS = 8000;

function progress(input: ResearchPipelineInput, stage: ResearchStageId, detail: string): void {
  try {
    input.onProgress?.(stage, detail);
  } catch {
    /* progress tidak boleh menggagalkan run */
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) u.searchParams.delete(p);
    let s = u.toString().toLowerCase();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim().toLowerCase();
  }
}

/* ------------------------------------------------------------- brief */

export interface ResearchBrief {
  question: string;
  language: ResearchLanguage;
  intent: ResearchIntent;
}

/** Stage 1 — Brief: normalisasi pertanyaan + intent routing (deterministik + 1 call murah). */
export async function briefStage(
  provider: LLMProvider,
  question: string,
  signal?: AbortSignal,
): Promise<ResearchBrief> {
  const q = question.trim();
  if (!q) throw new Error('riset butuh pertanyaan');
  const intent = await classifyResearchIntent(provider, q, signal);
  return { question: q, language: intent.language, intent };
}

/* -------------------------------------------------------------- plan */

/** Stage 2 — Plan: two-call planner → spec (di-stage di server untuk gate). */
export async function planStage(
  provider: LLMProvider,
  brief: ResearchBrief,
  signal?: AbortSignal,
): Promise<Omit<ResearchPlan, 'planId' | 'createdAt'>> {
  return generateResearchPlan(provider, brief.question, brief.intent, signal);
}

/* ----------------------------------------------------------- execute */

interface ExecutedSource {
  id: string;
  url: string;
  title: string;
  text: string;
  status: number;
  fetchedAt: string;
}

/** Stage 3 — Execute: sub-pertanyaan dijalankan dengan paralelisme terbatas dalam budget. */
export async function executeStage(input: ResearchPipelineInput, plan: ResearchPlan): Promise<ExecutedSource[]> {
  const { fetch, signal } = input;
  const subQuestions = plan.subQuestions.slice(0, plan.budget.maxQueries);
  const seen = new Set<string>();
  const collected: ExecutedSource[] = [];
  let sourceCount = 0;
  let n = 0;

  progress(input, 'execute', `mencari ${subQuestions.length} sub-pertanyaan…`);
  for (const sq of subQuestions) {
    if (sourceCount >= plan.budget.maxSources) break;
    let hits: ResearchSearchHit[];
    try {
      hits = await fetch.searchWeb(sq.text, signal);
    } catch (err) {
      throw new Error(`pencarian gagal untuk "${sq.text}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fetch paralel terbatas per sub-pertanyaan.
    const fresh = hits.filter((h) => {
      const key = normalizeUrl(h.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const queue = fresh.slice();
    const workers: Promise<void>[] = [];
    const take = async (): Promise<void> => {
      // Reservasi slot budget secara atomik: cek + increment berjalan
      // sinkron tanpa await di antaranya, jadi worker paralel tidak bisa
      // race dan melebihi maxSources (bug live-test: 27 > 24).
      while (queue.length > 0) {
        if (sourceCount >= plan.budget.maxSources) break;
        const hit = queue.shift() as ResearchSearchHit;
        sourceCount += 1;
        n += 1;
        const id = `s${n}`;
        let page: FetchedPage | null = null;
        try {
          page = await fetch.fetchPage(hit.url, signal);
        } catch {
          page = null;
        }
        if (page && page.status === 200 && page.text.trim().length > 0) {
          collected.push({
            id,
            url: hit.url,
            title: page.title || hit.title,
            text: page.text.slice(0, MAX_SOURCE_CHARS),
            status: page.status,
            fetchedAt: new Date().toISOString(),
          });
          progress(input, 'execute', `ter-fetch ${collected.length}/${plan.budget.maxSources} sumber`);
        } else {
          sourceCount -= 1; // fetch gagal — kembalikan slot budget
        }
      }
    };
    for (let w = 0; w < Math.min(FETCH_CONCURRENCY, queue.length); w += 1) workers.push(take());
    await Promise.all(workers);
    progress(input, 'execute', `sub-pertanyaan "${sq.id}" selesai`);
  }
  if (collected.length === 0) {
    throw new ResearchPipelineError('tidak ada sumber yang berhasil di-fetch — riset dibatalkan');
  }
  return collected;
}

/* ---------------------------------------------------------- evidence */

/** Stage 4 — Evidence: dedup (sudah di execute) + skor kredibilitas per sumber. */
export async function evidenceStage(
  input: ResearchPipelineInput,
  executed: ExecutedSource[],
): Promise<{ sources: ResearchSource[]; evidence: Map<string, EvidenceEntry> }> {
  const fetchFn = input.credibilityFetch ?? defaultCredibilityFetch;
  const sources: ResearchSource[] = [];
  const evidence = new Map<string, EvidenceEntry>();
  const queue = executed.slice();
  const workers: Promise<void>[] = [];
  const take = async (): Promise<void> => {
    while (queue.length > 0) {
      const ex = queue.shift() as ExecutedSource;
      let credibility;
      try {
        credibility = await assessCredibility({ url: ex.url, title: ex.title }, fetchFn);
      } catch {
        credibility = { tier: 'web' as const, verified: false, detail: 'penilaian kredibilitas gagal — diperlakukan sebagai web umum' };
      }
      const source: ResearchSource = {
        id: ex.id, url: ex.url, title: ex.title, fetchedAt: ex.fetchedAt, credibility,
      };
      sources.push(source);
      evidence.set(ex.id.toLowerCase(), { sourceId: ex.id, url: ex.url, status: ex.status, content: ex.text });
      progress(input, 'evidence', `kredibilitas ${ex.id}: ${credibility.tier}${credibility.verified ? ' (terverifikasi)' : ''}`);
    }
  };
  for (let w = 0; w < Math.min(FETCH_CONCURRENCY, queue.length); w += 1) workers.push(take());
  await Promise.all(workers);
  sources.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { sources, evidence };
}

/* ------------------------------------------------------------ verify */

const EXTRACT_SYSTEM = [
  'You extract atomic factual claims from the fetched sources below. Output exactly one JSON object and nothing else.',
  'Shape: {"claims": [{"text": string, "sourceIds": ["s1"], "excerpts": [string]}]}',
  'Hard rules — violating any of them rejects your output:',
  '- text: ONE atomic fact per claim (no compound claims). Write in the brief language.',
  '- sourceIds: the source(s) the claim comes from — 1 source minimum, 2+ when independent sources agree.',
  '- excerpts: VERBATIM quotes from the source content (exact substrings). Every number, date, or direct quote',
  '  in text MUST appear verbatim in at least one excerpt of the same claim. No excerpt may be invented or paraphrased.',
  '- Copy numbers and dates CHARACTER-FOR-CHARACTER from the excerpt into text. If the source does not state',
  '  a year/number explicitly, write the claim WITHOUT it — never fill it in from the question or your knowledge.',
  '- Only claims fully supported by the sources. If a source is thin, extract fewer claims — never pad.',
  '- Aim for 8-25 claims covering the sub-questions. Skip boilerplate, nav text, and ads.',
].join('\n');

interface ExtractedClaim {
  text: string;
  sourceIds: string[];
  excerpts: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateExtracted(value: unknown, knownIds: Set<string>): { ok: true; value: ExtractedClaim[] } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected {"claims": [...]}'] };
  if (!Array.isArray(value.claims) || value.claims.length === 0) {
    return { ok: false, issues: ['claims must be a non-empty array'] };
  }
  const out: ExtractedClaim[] = [];
  for (const [i, raw] of (value.claims as unknown[]).entries()) {
    const where = `claims[${i}]`;
    if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
    if (!isNonEmptyString(raw.text)) { issues.push(`${where} needs a text`); continue; }
    if (!Array.isArray(raw.sourceIds) || raw.sourceIds.length === 0 || !(raw.sourceIds as unknown[]).every(isNonEmptyString)) {
      issues.push(`${where}: sourceIds must be a non-empty array`); continue;
    }
    const ids = (raw.sourceIds as string[]).map((s) => s.trim());
    const unknown = ids.filter((id) => !knownIds.has(id.toLowerCase()));
    if (unknown.length > 0) { issues.push(`${where}: sourceId tidak dikenal: ${unknown.join(', ')}`); continue; }
    if (!Array.isArray(raw.excerpts) || raw.excerpts.length === 0 || !(raw.excerpts as unknown[]).every(isNonEmptyString)) {
      issues.push(`${where}: excerpts must be a non-empty array of verbatim quotes`); continue;
    }
    out.push({ text: (raw.text as string).trim(), sourceIds: ids, excerpts: (raw.excerpts as string[]).map((e) => e.trim()) });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: out };
}

/**
 * Stage 5 — Verify (ekstraksi independen): model dalam KONTEKS SEGAR
 * hanya melihat evidence — memetakan tiap klaim ke sumber + excerpt
 * verbatim. Confidence dihitung engine secara deterministik:
 * high = 2+ sumber independen, moderate = 1 sumber.
 */
export async function verifyStage(
  provider: LLMProvider,
  sources: ResearchSource[],
  evidence: Map<string, EvidenceEntry>,
  language: ResearchLanguage,
  signal?: AbortSignal,
): Promise<ResearchClaim[]> {
  const knownIds = new Set(sources.map((s) => s.id.toLowerCase()));
  const evidenceText = sources.map((s) => {
    const entry = evidence.get(s.id.toLowerCase());
    const content = entry ? entry.content.slice(0, 4000) : '';
    return `--- SOURCE ${s.id} ---\nTitle: ${s.title}\nURL: ${s.url}\n${content}`;
  }).join('\n\n');
  const extracted = await structuredCall<ExtractedClaim[]>(
    provider,
    EXTRACT_SYSTEM,
    [
      `Brief language: ${language}. Extract claims in ${language === 'id' ? 'Indonesian' : 'English'}.`,
      '',
      'EVIDENCE:',
      evidenceText,
    ].join('\n'),
    (value) => validateExtracted(value, knownIds),
    signal,
  );
  return extracted.map((c, i) => ({
    id: `c${i + 1}`,
    text: c.text,
    sourceIds: c.sourceIds,
    excerpts: c.excerpts,
    confidence: (c.sourceIds.length >= 2 ? 'high' : 'moderate') as ResearchClaim['confidence'],
    status: 'verified' as const,
  }));
}

/* -------------------------------------------------------- synthesize */

const SYNTH_SYSTEM = [
  'You write a research report from VERIFIED claims only. Output exactly one JSON object and nothing else.',
  'Shape: {"sections": [{"id": "sec1", "title": string, "claimIds": ["c1"]}],',
  ' "conflicts": [{"topic": string, "positions": [{"sourceId": "s1", "stance": string}]}],',
  ' "limitations": [string], "summary": string}',
  'Hard rules — violating any of them rejects your output:',
  '- sections: group the claims into 3-6 titled sections. Every claimId must exist; every claim appears in >= 1 section.',
  '- conflicts: when sources genuinely disagree, surface it here (>= 2 positions, sourceIds must exist). Empty array if none.',
  '- limitations: honest limits of this research (thin sources, language coverage, paywalls, date cutoff). >= 1 item.',
  '- summary: executive summary, 4-8 sentences. NEVER introduce numbers, dates, or quotes that are not inside the claims.',
  '- You NEVER add facts. You only organize and narrate the given claims.',
].join('\n');

interface Synthesized {
  sections: Array<{ id: string; title: string; claimIds: string[] }>;
  conflicts: SourceConflict[];
  limitations: string[];
  summary: string;
}

function validateSynthesized(
  value: unknown,
  claimIds: Set<string>,
  sourceIds: Set<string>,
): { ok: true; value: Synthesized } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object'] };
  const sections: Synthesized['sections'] = [];
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    issues.push('sections must be a non-empty array');
  } else {
    for (const [i, raw] of (value.sections as unknown[]).entries()) {
      const where = `sections[${i}]`;
      if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
      const id = isNonEmptyString(raw.id) ? (raw.id as string).trim() : `sec${i + 1}`;
      if (!isNonEmptyString(raw.title)) { issues.push(`${where} needs a title`); continue; }
      if (!Array.isArray(raw.claimIds) || raw.claimIds.length === 0 || !(raw.claimIds as unknown[]).every(isNonEmptyString)) {
        issues.push(`${where}: claimIds must be a non-empty array`); continue;
      }
      const cids = (raw.claimIds as string[]).map((c) => c.trim());
      const unknown = cids.filter((c) => !claimIds.has(c.toLowerCase()));
      if (unknown.length > 0) { issues.push(`${where}: claimId tidak dikenal: ${unknown.join(', ')}`); continue; }
      sections.push({ id, title: (raw.title as string).trim(), claimIds: cids });
    }
  }
  const covered = new Set(sections.flatMap((s) => s.claimIds.map((c) => c.toLowerCase())));
  const uncovered = [...claimIds].filter((c) => !covered.has(c));
  if (uncovered.length > 0) issues.push(`klaim tanpa section: ${uncovered.join(', ')}`);

  const conflicts: SourceConflict[] = [];
  if (value.conflicts !== undefined) {
    if (!Array.isArray(value.conflicts)) issues.push('conflicts must be an array');
    else for (const [i, raw] of (value.conflicts as unknown[]).entries()) {
      const where = `conflicts[${i}]`;
      if (!isObj(raw) || !isNonEmptyString(raw.topic)) { issues.push(`${where} needs a topic`); continue; }
      if (!Array.isArray(raw.positions) || raw.positions.length < 2) { issues.push(`${where}: positions butuh >= 2`); continue; }
      const positions: Array<{ sourceId: string; stance: string }> = [];
      let bad = false;
      for (const [j, p] of (raw.positions as unknown[]).entries()) {
        if (!isObj(p) || !isNonEmptyString(p.sourceId) || !isNonEmptyString(p.stance)) {
          issues.push(`${where}.positions[${j}] needs sourceId + stance`); bad = true; break;
        }
        const sid = (p.sourceId as string).trim();
        if (!sourceIds.has(sid.toLowerCase())) { issues.push(`${where}.positions[${j}]: sourceId "${sid}" tidak dikenal`); bad = true; break; }
        positions.push({ sourceId: sid, stance: (p.stance as string).trim() });
      }
      if (!bad) conflicts.push({ topic: (raw.topic as string).trim(), positions });
    }
  }

  const limitations: string[] = [];
  if (!Array.isArray(value.limitations) || value.limitations.length === 0) {
    issues.push('limitations must be a non-empty array');
  } else {
    for (const [i, raw] of (value.limitations as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`limitations[${i}] must be a non-empty string`); continue; }
      limitations.push((raw as string).trim());
    }
  }
  if (!isNonEmptyString(value.summary)) issues.push('summary must be a non-empty string');

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { sections, conflicts, limitations, summary: (value.summary as string).trim() } };
}

/** Stage 6 — Synthesize: model MENARASIKAN hanya dari klaim terverifikasi. */
export async function synthesizeStage(
  provider: LLMProvider,
  args: { question: string; language: ResearchLanguage; claims: ResearchClaim[]; sources: ResearchSource[] },
  signal?: AbortSignal,
): Promise<Synthesized> {
  const claimIds = new Set(args.claims.map((c) => c.id.toLowerCase()));
  const sourceIds = new Set(args.sources.map((s) => s.id.toLowerCase()));
  const claimsText = args.claims.map((c) => `- ${c.id}: ${c.text} [${c.sourceIds.join(', ')}]`).join('\n');
  return structuredCall<Synthesized>(
    provider,
    SYNTH_SYSTEM,
    [
      `Question: ${args.question}`,
      `Language: ${args.language}`,
      '',
      'VERIFIED CLAIMS (the only facts you may use):',
      claimsText,
    ].join('\n'),
    (value) => validateSynthesized(value, claimIds, sourceIds),
    signal,
  );
}

/* ------------------------------------------------------------ runner */

export class ResearchPipelineError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ResearchPipelineError';
    this.issues = issues;
  }
}

/**
 * Verify-gate failure: satu-satunya error yang di-map server ke 422
 * (pola AnalysisVerifyError di Analis).
 */
export class ResearchVerifyError extends ResearchPipelineError {
  readonly code = 'verify_failed';
  constructor(message: string, issues: string[] = []) {
    super(message, issues);
    this.name = 'ResearchVerifyError';
  }
}

function verifyIssuesText(gate: VerifyGateResult): string[] {
  return gate.issues.map((i) => `[aturan ${i.rule}]${i.claimId ? ` ${i.claimId}` : ''}: ${i.message}`);
}

/**
 * runResearch — stage 3–8 setelah ★ GATE ("Jalankan riset").
 * Plan di-validasi ulang secara hard sebelum execute.
 */
export async function runResearchPipeline(input: ResearchPipelineInput): Promise<ResearchPipelineResult> {
  const { plan, signal } = input;
  const planVerdict = validateResearchPlan({
    question: plan.question,
    language: plan.language,
    subQuestions: plan.subQuestions,
    sourceStrategy: plan.sourceStrategy,
    budget: plan.budget,
  });
  if (!planVerdict.ok) {
    throw new ResearchPipelineError(`rencana riset tidak valid: ${planVerdict.issues.join('; ')}`, planVerdict.issues);
  }

  // execute → evidence
  const executed = await executeStage(input, plan);
  progress(input, 'evidence', `${executed.length} sumber ter-fetch, menilai kredibilitas…`);
  const { sources, evidence } = await evidenceStage(input, executed);

  // verify (ekstraksi independen) — 1x revisi bila model gagal total.
  let claims: ResearchClaim[] | null = null;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    try {
      progress(input, 'verify', `ekstraksi klaim (upaya ${attempt})…`);
      claims = await verifyStage(input.provider, sources, evidence, plan.language, signal);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!claims) throw new ResearchPipelineError(`ekstraksi klaim gagal: ${lastError}`);

  // synthesize
  progress(input, 'synthesize', 'menyusun laporan dari klaim terverifikasi…');
  const synth = await synthesizeStage(
    input.provider,
    { question: plan.question, language: plan.language, claims, sources },
    signal,
  );

  // gate — deterministik, nol LLM.
  progress(input, 'gate', 'verify gate deterministik…');
  const draft: ResearchReport = {
    reportId: randomUUID(),
    question: plan.question,
    language: plan.language,
    sections: synth.sections,
    claims,
    sources,
    conflicts: synth.conflicts,
    limitations: synth.limitations,
    summary: synth.summary,
    bibliography: buildBibliography(sources),
    budget: { queriesUsed: Math.min(plan.subQuestions.length, plan.budget.maxQueries), sourcesFetched: sources.length },
    verification: { claimsVerified: 0, claimsDropped: 0, gatePassed: false },
  };
  const gate = runVerifyGate({ report: draft, evidence, budget: plan.budget });
  if (!gate.ok) {
    const texts = verifyIssuesText(gate);
    throw new ResearchVerifyError(`verify gate gagal — tanpa laporan: ${texts.join('; ')}`, texts);
  }

  // compile
  progress(input, 'compile', 'kompilasi laporan final…');
  const report: ResearchReport = {
    ...gate.report,
    verification: {
      claimsVerified: gate.claimsVerified,
      claimsDropped: gate.claimsDropped,
      gatePassed: true,
    },
  };
  return { report, gate };
}
