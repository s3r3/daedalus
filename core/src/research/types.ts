/**
 * Agentic Research — shared contract types (domain ke-5 Daedalus).
 *
 * Doktrin yang sama dengan Analis: model hanya mengisi slot JSON di
 * dalam stage; klaim ditulis engine dari evidence pool terverifikasi,
 * tidak pernah fakta mentah model yang dibekukan jadi klaim. Semua
 * validasi di bawah ini manual (pola analysis-plan.ts) — tanpa zod.
 */

export type ResearchLanguage = 'id' | 'en';

export type CredibilityTier =
  | 'scopus' | 'scopus-q1' | 'scopus-q2' | 'scopus-q3' | 'scopus-q4'
  | 'sinta1' | 'sinta2' | 'sinta3' | 'sinta4' | 'sinta5' | 'sinta6'
  | 'doaj' | 'garuda' | 'scholar' | 'web' | 'unknown';

export interface SourceCredibility {
  tier: CredibilityTier;
  /**
   * true = dikonfirmasi API/daftar resmi (Sinta, Crossref, DOAJ);
   * false = heuristic (pencocokan nama/domain) — UI wajib melabeli
   * "terdeteksi", bukan "terverifikasi".
   */
  verified: boolean;
  /** cth "Sinta 2 — sinta.kemdikbud.go.id" atau "terdeteksi dari domain garuda.kemdikbud.go.id". */
  detail?: string;
}

export interface ResearchSource {
  id: string;
  /** Harus pernah di-fetch HTTP 200 dalam run ini (ada di evidence pool). */
  url: string;
  title: string;
  authors?: string[];
  year?: number;
  doi?: string;
  /** ISO timestamp fetch (engine-set, bukan model). */
  fetchedAt: string;
  credibility: SourceCredibility;
}

export type ClaimConfidence = 'high' | 'moderate' | 'low';
export type ClaimStatus = 'verified' | 'corrected' | 'dropped';

export interface ResearchClaim {
  id: string;
  text: string;
  /** >= 1 — semua harus ada di sources. */
  sourceIds: string[];
  /** Kutipan verbatim — tiap excerpt harus substring konten ter-fetch sumbernya. */
  excerpts: string[];
  /** high = didukung 2+ sumber independen. */
  confidence: ClaimConfidence;
  status: ClaimStatus;
}

export interface ResearchSection {
  id: string;
  title: string;
  claimIds: string[];
}

export interface SourceConflict {
  topic: string;
  positions: Array<{ sourceId: string; stance: string }>;
}

export interface ResearchReport {
  reportId: string;
  question: string;
  language: ResearchLanguage;
  sections: ResearchSection[];
  claims: ResearchClaim[];
  sources: ResearchSource[];
  conflicts: SourceConflict[];
  limitations: string[];
  /** Ringkasan eksekutif (panel Ringkasan). */
  summary: string;
  bibliography: { apa: string[]; ieee: string[] };
  budget: { queriesUsed: number; sourcesFetched: number };
  verification: { claimsVerified: number; claimsDropped: number; gatePassed: boolean };
}

export interface ResearchSubQuestion {
  id: string;
  text: string;
  rationale?: string;
}

export interface ResearchPlan {
  planId: string;
  question: string;
  language: ResearchLanguage;
  subQuestions: ResearchSubQuestion[];
  /** Strategi sumber yang direncanakan model, mis. "prioritaskan jurnal Sinta/Scopus untuk klaim akademik". */
  sourceStrategy: string;
  budget: { maxQueries: number; maxSources: number };
  /** ISO timestamp (engine-set). */
  createdAt: string;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

const TIERS: readonly string[] = [
  'scopus', 'scopus-q1', 'scopus-q2', 'scopus-q3', 'scopus-q4',
  'sinta1', 'sinta2', 'sinta3', 'sinta4', 'sinta5', 'sinta6',
  'doaj', 'garuda', 'scholar', 'web', 'unknown',
];
const CONFIDENCES = ['high', 'moderate', 'low'] as const;
const STATUSES = ['verified', 'corrected', 'dropped'] as const;

function checkCredibility(raw: unknown, where: string, issues: string[]): SourceCredibility | null {
  if (!isObj(raw)) { issues.push(`${where}.credibility must be an object`); return null; }
  const tier = typeof raw.tier === 'string' ? raw.tier : '';
  if (!TIERS.includes(tier)) { issues.push(`${where}.credibility.tier harus salah satu: ${TIERS.join(', ')}`); return null; }
  if (typeof raw.verified !== 'boolean') { issues.push(`${where}.credibility.verified must be a boolean`); return null; }
  const out: SourceCredibility = { tier: tier as CredibilityTier, verified: raw.verified };
  if (typeof raw.detail === 'string' && raw.detail.trim()) out.detail = raw.detail.trim();
  return out;
}

function checkSource(raw: unknown, where: string, issues: string[], seenIds: Set<string>): ResearchSource | null {
  if (!isObj(raw)) { issues.push(`${where} must be an object`); return null; }
  const id = isNonEmptyString(raw.id) ? raw.id.trim() : '';
  if (!id) { issues.push(`${where} needs an id`); return null; }
  if (seenIds.has(id.toLowerCase())) { issues.push(`${where}: source id "${id}" duplikat`); return null; }
  seenIds.add(id.toLowerCase());
  const url = isNonEmptyString(raw.url) ? raw.url.trim() : '';
  if (!url) { issues.push(`${where} ("${id}"): url must be a non-empty string`); return null; }
  if (!/^https?:\/\//i.test(url)) { issues.push(`${where} ("${id}"): url harus http(s)`); return null; }
  const title = isNonEmptyString(raw.title) ? raw.title.trim() : '';
  if (!title) { issues.push(`${where} ("${id}"): title must be a non-empty string`); return null; }
  const credibility = checkCredibility(raw.credibility, `${where} ("${id}")`, issues);
  if (!credibility) return null;
  const out: ResearchSource = {
    id, url, title, credibility,
    fetchedAt: isNonEmptyString(raw.fetchedAt) ? raw.fetchedAt.trim() : new Date().toISOString(),
  };
  if (Array.isArray(raw.authors)) {
    const authors = (raw.authors as unknown[]).filter(isNonEmptyString).map((a) => (a as string).trim());
    if (authors.length > 0) out.authors = authors;
  }
  if (typeof raw.year === 'number' && Number.isInteger(raw.year) && raw.year > 1500 && raw.year < 2100) out.year = raw.year;
  if (isNonEmptyString(raw.doi)) out.doi = raw.doi.trim();
  return out;
}

function checkClaim(raw: unknown, where: string, issues: string[], sourceIds: Set<string>, seenIds: Set<string>): ResearchClaim | null {
  if (!isObj(raw)) { issues.push(`${where} must be an object`); return null; }
  const id = isNonEmptyString(raw.id) ? raw.id.trim() : '';
  if (!id) { issues.push(`${where} needs an id`); return null; }
  if (seenIds.has(id.toLowerCase())) { issues.push(`${where}: claim id "${id}" duplikat`); return null; }
  seenIds.add(id.toLowerCase());
  const text = isNonEmptyString(raw.text) ? raw.text.trim() : '';
  if (!text) { issues.push(`${where} ("${id}"): text must be a non-empty string`); return null; }
  if (!Array.isArray(raw.sourceIds) || raw.sourceIds.length === 0 || !(raw.sourceIds as unknown[]).every(isNonEmptyString)) {
    issues.push(`${where} ("${id}"): sourceIds must be a non-empty array of source ids`);
    return null;
  }
  const ids = (raw.sourceIds as string[]).map((s) => s.trim());
  for (const sid of ids) {
    if (![...sourceIds].some((known) => known.toLowerCase() === sid.toLowerCase())) {
      issues.push(`${where} ("${id}"): sourceId "${sid}" tidak ada di sources`);
      return null;
    }
  }
  const excerpts: string[] = [];
  if (raw.excerpts !== undefined) {
    if (!Array.isArray(raw.excerpts)) { issues.push(`${where} ("${id}"): excerpts must be an array of strings`); return null; }
    for (const [i, e] of (raw.excerpts as unknown[]).entries()) {
      if (!isNonEmptyString(e)) { issues.push(`${where} ("${id}"): excerpts[${i}] must be a non-empty string`); return null; }
      excerpts.push((e as string).trim());
    }
  }
  const confidence = typeof raw.confidence === 'string' ? raw.confidence : '';
  if (!(CONFIDENCES as readonly string[]).includes(confidence)) {
    issues.push(`${where} ("${id}"): confidence harus salah satu ${CONFIDENCES.join(', ')}`);
    return null;
  }
  const status = typeof raw.status === 'string' ? raw.status : '';
  if (!(STATUSES as readonly string[]).includes(status)) {
    issues.push(`${where} ("${id}"): status harus salah satu ${STATUSES.join(', ')}`);
    return null;
  }
  return { id, text, sourceIds: ids, excerpts, confidence: confidence as ClaimConfidence, status: status as ClaimStatus };
}

/**
 * Validasi bentuk ResearchReport (shape-level). Aturan gate
 * deterministik yang butuh evidence pool (excerpt substring, URL
 * ter-fetch, angka tanpa sitasi) hidup di verify.ts — bukan di sini.
 */
export function validateResearchReport(value: unknown): Verdict<ResearchReport> {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object (ResearchReport)'] };
  const reportId = isNonEmptyString(value.reportId) ? value.reportId.trim() : '';
  if (!reportId) issues.push('reportId must be a non-empty string');
  const question = isNonEmptyString(value.question) ? value.question.trim() : '';
  if (!question) issues.push('question must be a non-empty string');
  const language = value.language === 'id' || value.language === 'en' ? value.language : null;
  if (!language) issues.push('language harus "id" atau "en"');

  const sources: ResearchSource[] = [];
  const seenSourceIds = new Set<string>();
  if (!Array.isArray(value.sources)) issues.push('sources must be an array');
  else for (const [i, raw] of (value.sources as unknown[]).entries()) {
    const s = checkSource(raw, `sources[${i}]`, issues, seenSourceIds);
    if (s) sources.push(s);
  }

  const claims: ResearchClaim[] = [];
  const seenClaimIds = new Set<string>();
  if (!Array.isArray(value.claims)) issues.push('claims must be an array');
  else for (const [i, raw] of (value.claims as unknown[]).entries()) {
    const c = checkClaim(raw, `claims[${i}]`, issues, seenSourceIds, seenClaimIds);
    if (c) claims.push(c);
  }

  const sections: ResearchSection[] = [];
  if (!Array.isArray(value.sections)) issues.push('sections must be an array');
  else for (const [i, raw] of (value.sections as unknown[]).entries()) {
    const where = `sections[${i}]`;
    if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
    const id = isNonEmptyString(raw.id) ? raw.id.trim() : '';
    const title = isNonEmptyString(raw.title) ? raw.title.trim() : '';
    if (!id) { issues.push(`${where} needs an id`); continue; }
    if (!title) { issues.push(`${where} ("${id}") needs a title`); continue; }
    const claimIds: string[] = [];
    if (raw.claimIds !== undefined) {
      if (!Array.isArray(raw.claimIds) || !(raw.claimIds as unknown[]).every(isNonEmptyString)) {
        issues.push(`${where} ("${id}"): claimIds must be an array of strings`); continue;
      }
      for (const cid of raw.claimIds as string[]) {
        if (![...seenClaimIds].some((k) => k.toLowerCase() === cid.trim().toLowerCase())) {
          issues.push(`${where} ("${id}"): claimId "${cid}" tidak ada di claims`); continue;
        }
        claimIds.push(cid.trim());
      }
    }
    sections.push({ id, title, claimIds });
  }

  const conflicts: SourceConflict[] = [];
  if (value.conflicts !== undefined) {
    if (!Array.isArray(value.conflicts)) issues.push('conflicts must be an array');
    else for (const [i, raw] of (value.conflicts as unknown[]).entries()) {
      const where = `conflicts[${i}]`;
      if (!isObj(raw) || !isNonEmptyString(raw.topic)) { issues.push(`${where} needs a topic`); continue; }
      if (!Array.isArray(raw.positions) || raw.positions.length < 2) { issues.push(`${where}: positions butuh >= 2 sumber yang beda pendapat`); continue; }
      const positions: Array<{ sourceId: string; stance: string }> = [];
      let bad = false;
      for (const [j, p] of (raw.positions as unknown[]).entries()) {
        if (!isObj(p) || !isNonEmptyString(p.sourceId) || !isNonEmptyString(p.stance)) {
          issues.push(`${where}.positions[${j}] needs sourceId + stance`); bad = true; break;
        }
        positions.push({ sourceId: (p.sourceId as string).trim(), stance: (p.stance as string).trim() });
      }
      if (!bad) conflicts.push({ topic: (raw.topic as string).trim(), positions });
    }
  }

  const limitations: string[] = [];
  if (value.limitations !== undefined) {
    if (!Array.isArray(value.limitations)) issues.push('limitations must be an array of strings');
    else for (const [i, raw] of ((value.limitations ?? []) as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`limitations[${i}] must be a non-empty string`); continue; }
      limitations.push((raw as string).trim());
    }
  }

  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!summary) issues.push('summary (ringkasan eksekutif) must be a non-empty string');

  const bibliography = { apa: [] as string[], ieee: [] as string[] };
  if (!isObj(value.bibliography)) issues.push('bibliography must be an object {apa: [...], ieee: [...]}');
  else {
    for (const key of ['apa', 'ieee'] as const) {
      const arr = (value.bibliography as Record<string, unknown>)[key];
      if (!Array.isArray(arr)) { issues.push(`bibliography.${key} must be an array of strings`); continue; }
      for (const [i, e] of (arr as unknown[]).entries()) {
        if (!isNonEmptyString(e)) { issues.push(`bibliography.${key}[${i}] must be a non-empty string`); continue; }
        bibliography[key].push((e as string).trim());
      }
    }
  }

  const budget = { queriesUsed: 0, sourcesFetched: 0 };
  if (!isObj(value.budget)) issues.push('budget must be an object {queriesUsed, sourcesFetched}');
  else {
    for (const key of ['queriesUsed', 'sourcesFetched'] as const) {
      const n = (value.budget as Record<string, unknown>)[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) { issues.push(`budget.${key} must be a non-negative integer`); continue; }
      budget[key] = n;
    }
  }

  const verification = { claimsVerified: 0, claimsDropped: 0, gatePassed: false };
  if (!isObj(value.verification)) issues.push('verification must be an object');
  else {
    const v = value.verification as Record<string, unknown>;
    for (const key of ['claimsVerified', 'claimsDropped'] as const) {
      const n = v[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) { issues.push(`verification.${key} must be a non-negative integer`); continue; }
      verification[key] = n;
    }
    if (typeof v.gatePassed !== 'boolean') issues.push('verification.gatePassed must be a boolean');
    else verification.gatePassed = v.gatePassed;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      reportId, question, language: language as ResearchLanguage,
      sections, claims, sources, conflicts, limitations, summary,
      bibliography, budget, verification,
    },
  };
}

/** Validasi bentuk ResearchPlan (dipakai server saat staging). */
export function validateResearchPlan(value: unknown): Verdict<Omit<ResearchPlan, 'planId' | 'createdAt'>> {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object (ResearchPlan)'] };
  const question = isNonEmptyString(value.question) ? value.question.trim() : '';
  if (!question) issues.push('question must be a non-empty string');
  const language = value.language === 'id' || value.language === 'en' ? value.language : null;
  if (!language) issues.push('language harus "id" atau "en"');
  const subQuestions: ResearchSubQuestion[] = [];
  if (!Array.isArray(value.subQuestions) || value.subQuestions.length === 0) {
    issues.push('subQuestions must be a non-empty array');
  } else {
    const seen = new Set<string>();
    for (const [i, raw] of (value.subQuestions as unknown[]).entries()) {
      const where = `subQuestions[${i}]`;
      if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
      const id = isNonEmptyString(raw.id) ? raw.id.trim() : `sq${i + 1}`;
      const text = isNonEmptyString(raw.text) ? raw.text.trim() : '';
      if (!text) { issues.push(`${where} needs a text`); continue; }
      if (seen.has(id.toLowerCase())) { issues.push(`${where}: sub-question id "${id}" duplikat`); continue; }
      seen.add(id.toLowerCase());
      const sq: ResearchSubQuestion = { id, text };
      if (isNonEmptyString(raw.rationale)) sq.rationale = (raw.rationale as string).trim();
      subQuestions.push(sq);
    }
  }
  const sourceStrategy = isNonEmptyString(value.sourceStrategy) ? (value.sourceStrategy as string).trim() : '';
  if (!sourceStrategy) issues.push('sourceStrategy must be a non-empty string');
  const budget = { maxQueries: 12, maxSources: 30 };
  if (isObj(value.budget)) {
    const b = value.budget as Record<string, unknown>;
    if (typeof b.maxQueries === 'number' && Number.isInteger(b.maxQueries) && b.maxQueries > 0 && b.maxQueries <= 50) {
      budget.maxQueries = b.maxQueries;
    }
    if (typeof b.maxSources === 'number' && Number.isInteger(b.maxSources) && b.maxSources > 0 && b.maxSources <= 100) {
      budget.maxSources = b.maxSources;
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { question, language: language as ResearchLanguage, subQuestions, sourceStrategy, budget } };
}
