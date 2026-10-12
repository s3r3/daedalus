import type { ResearchReport } from './types.ts';

/**
 * Verify gate deterministik (nol LLM) — satu-satunya jalan klaim masuk
 * laporan. Tujuh aturan dari Desain-Agentic-Research-v1:
 *  1. tiap klaim punya >= 1 sourceId yang ada di sources
 *  2. tiap URL sumber pernah di-fetch HTTP 200 dalam run ini (evidence pool)
 *  3. tiap excerpt adalah substring konten ter-fetch sumber tersebut
 *  4. tidak ada angka/tanggal/kutipan langsung tanpa sitasi —
 *     token angka/tanggal/kutip di teks klaim harus muncul verbatim
 *     di >= 1 excerpt klaim itu
 *  5. tidak ada marker [CITATION NEEDED] / teks placeholder
 *  6. budget tidak jebol (queries <= max, sources <= max)
 *  7. klaim `low` tanpa 1 sumber valid pun → dropped, tidak masuk laporan
 *
 * Kegagalan gate (aturan 1–6) = laporan tidak dikembalikan; server
 * memetakan ke 422. Aturan 7 bersifat korektif: klaim di-drop dari
 * laporan dan dihitung di verification.claimsDropped.
 */

export interface EvidenceEntry {
  sourceId: string;
  url: string;
  /** HTTP status saat fetch; hanya 200 yang dihitung "pernah di-fetch". */
  status: number;
  /** Teks hasil ekstraksi halaman. */
  content: string;
}

export interface VerifyGateInput {
  report: ResearchReport;
  /** Evidence pool dari stage Evidence, keyed by sourceId. */
  evidence: Map<string, EvidenceEntry>;
  budget: { maxQueries: number; maxSources: number };
}

export interface VerifyIssue {
  rule: number;
  claimId?: string;
  message: string;
}

export interface VerifyGateResult {
  ok: boolean;
  issues: VerifyIssue[];
  /** Laporan final: klaim dropped (aturan 7) sudah dibuang. */
  report: ResearchReport;
  claimsVerified: number;
  claimsDropped: number;
}

/** Normalisasi untuk perbandingan substring: collapse whitespace, lowercase. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const NUMBER_TOKEN_RE = /(?<![A-Za-z0-9])-?\d[\d.,]*(?:\s?%)?(?![A-Za-z0-9])/g;
const MONTHS = 'januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|september|october|november|december';
const DATE_RE = new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}\\b|\\b(19|20)\\d{2}\\b`, 'gi');
const QUOTE_RE = /[""«»„]([^"""«»„]{8,})[""«»„]/g;
const PLACEHOLDER_RE = /\[CITATION NEEDED\]|\[TODO\]|\[TBD\]|\[.*?\]|lorem ipsum|\bxxx+\b/i;

function tokensIn(text: string): string[] {
  const out: string[] = [];
  // Titik/koma/colon di ujung token adalah tanda baca kalimat, bukan
  // bagian angka — buang agar "6." tercakup excerpt "... 6".
  const clean = (t: string): string => norm(t).replace(/[.,;:]+$/g, '');
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const t = clean(m[0]);
    if (t) out.push(t);
  }
  for (const m of text.matchAll(DATE_RE)) out.push(norm(m[0]));
  for (const m of text.matchAll(QUOTE_RE)) out.push(norm(m[1] as string));
  return [...new Set(out)];
}

function excerptCovers(excerpts: string[], token: string): boolean {
  const t = norm(token);
  if (!t) return true;
  return excerpts.some((e) => norm(e).includes(t));
}

export function runVerifyGate(input: VerifyGateInput): VerifyGateResult {
  const { report, evidence, budget } = input;
  const issues: VerifyIssue[] = [];
  const bySourceId = new Map(report.sources.map((s) => [s.id.toLowerCase(), s]));
  const droppedIds = new Set<string>();

  // Aturan 6 — budget (sekali per laporan).
  if (report.budget.queriesUsed > budget.maxQueries) {
    issues.push({ rule: 6, message: `budget jebol: queriesUsed ${report.budget.queriesUsed} > max ${budget.maxQueries}` });
  }
  if (report.budget.sourcesFetched > budget.maxSources) {
    issues.push({ rule: 6, message: `budget jebol: sourcesFetched ${report.budget.sourcesFetched} > max ${budget.maxSources}` });
  }

  // Aturan 5 — placeholder di summary/sections/claims.
  const texts: Array<{ where: string; text: string; claimId?: string }> = [
    { where: 'summary', text: report.summary },
    ...report.sections.map((s) => ({ where: `sections("${s.id}")`, text: s.title })),
    ...report.claims.map((c) => ({ where: `claims("${c.id}")`, text: c.text, claimId: c.id })),
  ];
  for (const t of texts) {
    if (PLACEHOLDER_RE.test(t.text)) {
      issues.push({ rule: 5, claimId: t.claimId, message: `${t.where}: mengandung placeholder/marker sitasi yang belum diisi` });
    }
  }

  let claimsVerified = 0;
  for (const claim of report.claims) {
    const where = `claims("${claim.id}")`;
    // Aturan 1 — >= 1 sourceId yang ada di sources.
    if (claim.sourceIds.length === 0) {
      if (claim.confidence === 'low') {
        droppedIds.add(claim.id);
        continue; // aturan 7
      }
      issues.push({ rule: 1, claimId: claim.id, message: `${where}: tidak punya sourceId` });
      continue;
    }
    const unknownSources = claim.sourceIds.filter((sid) => !bySourceId.has(sid.toLowerCase()));
    if (unknownSources.length > 0) {
      issues.push({ rule: 1, claimId: claim.id, message: `${where}: sourceId tidak dikenal: ${unknownSources.join(', ')}` });
      continue;
    }
    // Aturan 2 — tiap sumber pernah di-fetch HTTP 200 dalam run ini.
    const unfetched = claim.sourceIds.filter((sid) => {
      const e = evidence.get(sid.toLowerCase());
      return !e || e.status !== 200;
    });
    if (unfetched.length > 0) {
      if (claim.confidence === 'low' && unfetched.length === claim.sourceIds.length) {
        droppedIds.add(claim.id);
        continue; // aturan 7: low tanpa 1 pun sumber valid
      }
      issues.push({ rule: 2, claimId: claim.id, message: `${where}: sumber belum ter-fetch HTTP 200 dalam run ini: ${unfetched.join(', ')}` });
      continue;
    }
    // Aturan 3 — tiap excerpt substring dari konten sumbernya.
    let excerptBad = false;
    for (const sid of claim.sourceIds) {
      const entry = evidence.get(sid.toLowerCase()) as EvidenceEntry;
      const content = norm(entry.content);
      for (const ex of claim.excerpts) {
        if (!content.includes(norm(ex))) {
          issues.push({ rule: 3, claimId: claim.id, message: `${where}: excerpt bukan substring konten ${sid} — "${ex.slice(0, 60)}…"` });
          excerptBad = true;
          break;
        }
      }
      if (excerptBad) break;
    }
    if (excerptBad) continue;
    // Aturan 4 — angka/tanggal/kutipan di teks harus muncul verbatim di excerpt.
    const uncovered = tokensIn(claim.text).filter((t) => !excerptCovers(claim.excerpts, t));
    if (uncovered.length > 0) {
      issues.push({
        rule: 4, claimId: claim.id,
        message: `${where}: token tanpa sitasi verbatim di excerpt: ${uncovered.slice(0, 3).join(', ')}${uncovered.length > 3 ? '…' : ''}`,
      });
      continue;
    }
    claimsVerified += 1;
  }

  const finalClaims = report.claims.filter((c) => !droppedIds.has(c.id));
  const keptIds = new Set(finalClaims.map((c) => c.id.toLowerCase()));
  const finalSections = report.sections.map((s) => ({
    ...s,
    claimIds: s.claimIds.filter((cid) => keptIds.has(cid.toLowerCase())),
  }));

  const finalReport: ResearchReport = {
    ...report,
    claims: finalClaims,
    sections: finalSections,
    verification: {
      claimsVerified,
      claimsDropped: droppedIds.size,
      gatePassed: issues.length === 0,
    },
  };
  return {
    ok: issues.length === 0,
    issues,
    report: finalReport,
    claimsVerified,
    claimsDropped: droppedIds.size,
  };
}
