/**
 * Agentic Research — follow-up actions (FASE E).
 *
 * E1: Dalami temuan — pick a claim, research deeper, append to report.
 * E2: Banding sumber kritis — compare 2+ sources side-by-side.
 * E3: Update riset — find newer sources, append to existing report.
 *
 * These reuse the existing research pipeline (plan → search → verify)
 * with focused sub-questions. All claims still go through the verify gate.
 */

import type {
  ResearchClaim,
  ResearchReport,
  ResearchSource,
  CredibilityTier,
} from "./types.ts";

export interface DeepenResult {
  /** New claims found by the deeper research. */
  newClaims: ResearchClaim[];
  /** New sources fetched. */
  newSources: ResearchSource[];
  /** The focused question that was researched. */
  focusedQuestion: string;
}

export interface SourceComparison {
  sources: ResearchSource[];
  /** Per-source key findings (from claims that cite them). */
  findings: Map<string, string[]>;
  /** Agreement/disagreement summary. */
  summary: string;
}

/**
 * E1: Build a focused research question from a claim.
 * The deeper research will use this as its seed question.
 */
export function buildDeepenQuestion(claim: ResearchClaim, reportQuestion: string): string {
  return `Dalami lebih dalam: "${claim.text}" (dari riset: "${reportQuestion}"). ` +
    `Cari bukti tambahan, data pendukung, dan perspektif yang belum tercakup.`;
}

/**
 * E2: Compare sources critically.
 * Returns a structured comparison from the report's existing data —
 * no new searches needed, just intelligent presentation.
 */
export function compareSources(
  report: ResearchReport,
  sourceIds: string[],
): SourceComparison {
  const sources = report.sources.filter((s) => sourceIds.includes(s.id));
  const findings = new Map<string, string[]>();

  for (const source of sources) {
    const related = report.claims
      .filter((c) => c.sourceIds.includes(source.id))
      .map((c) => c.text);
    findings.set(source.id, related);
  }

  // Build agreement summary from conflicts.
  const relevantConflicts = report.conflicts.filter((c) =>
    c.sourceIds.some((id) => sourceIds.includes(id)),
  );
  let summary: string;
  if (relevantConflicts.length === 0) {
    summary = "Sumber-sumber ini tidak menunjukkan konflik langsung dalam laporan.";
  } else {
    summary = relevantConflicts
      .map((c) => `Perbedaan: ${c.description}`)
      .join("\n");
  }

  return { sources, findings, summary };
}

/**
 * E3: Check if a report can be updated with newer sources.
 * Returns the cutoff year (max year in existing sources).
 */
export function getUpdateCutoff(report: ResearchReport): number {
  const years = report.sources
    .map((s) => s.year)
    .filter((y): y is number => typeof y === "number" && y > 0);
  return years.length ? Math.max(...years) : new Date().getFullYear() - 1;
}

/**
 * E3: Build an update query focused on newer sources.
 */
export function buildUpdateQuery(report: ResearchReport): string {
  const cutoff = getUpdateCutoff(report);
  return `Penelitian terbaru (setelah ${cutoff}) tentang: "${report.question}". ` +
    `Fokus pada temuan baru yang belum tercakup dalam laporan existing.`;
}

/**
 * Format a source for display in comparisons.
 */
export function formatSourceCard(source: ResearchSource): string {
  const authors = source.authors?.join(", ") ?? "Anonim";
  const year = source.year ? ` (${source.year})` : "";
  const tier = formatTier(source.credibility.tier);
  return `${source.title}\n${authors}${year}\n${tier}`;
}

function formatTier(tier: CredibilityTier): string {
  const labels: Record<string, string> = {
    "scopus-q1": "Scopus Q1 🟣",
    "scopus-q2": "Scopus Q2 🟣",
    "scopus-q3": "Scopus Q3 🟣",
    "scopus-q4": "Scopus Q4 🟣",
    "sinta1": "Sinta 1",
    "sinta2": "Sinta 2",
    "doaj": "DOAJ",
  };
  return labels[tier] ?? tier;
}
