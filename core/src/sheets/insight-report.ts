import type { LLMProvider } from '../providers/llm/types.ts';
import { displayValue, type WorkbookEvaluation } from './evaluator.ts';
import { structuredCall } from './pipeline.ts';
import type { AnalysisPlan } from './analysis-plan.ts';
import type { SheetSpec, VerifyReport, WorkbookSpec } from './workbook.ts';

/**
 * Insight-report synthesizer for the Analis mode. Hard doctrine (the
 * golden pattern from the research): the model only narrates around
 * numbers that already passed the Verify gate — it never computes.
 *  - every `refs` entry must be a cell the engine computed,
 *  - every number in the prose must come from those computed values.
 * Violations are validation issues retried verbatim; after the last
 * attempt the stage throws and nothing is fabricated.
 */

export interface InsightFinding {
  text: string;
  /** Cell addresses, e.g. "Ringkasan!B2" — must all be computed cells. */
  refs: string[];
}

export interface InsightReport {
  question: string;
  findings: InsightFinding[];
  recommendations: string[];
  /** ISO timestamp the report was synthesized (engine-set, not model). */
  verifiedAt: string;
  /** One-line Verify gate verdict the numbers rest on. */
  verifySummary: string;
}

/** One computed cell the engine materialized (label + address). */
export interface SummaryCell {
  metricId: string;
  label: string;
  /** Sheet-qualified address, e.g. "Ringkasan!B2". */
  cellRef: string;
}

/** A computed cell with its evaluated display value. */
export interface ComputedMetric extends SummaryCell {
  value: string;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function splitCellRef(cellRef: string): { sheet: string; ref: string } | null {
  const bang = cellRef.indexOf('!');
  if (bang < 0) return null;
  return { sheet: cellRef.slice(0, bang), ref: cellRef.slice(bang + 1) };
}

/**
 * Resolve computed cells to display values AFTER verify passed
 * (evaluateWorkbook over the verified workbook). Pure.
 */
export function toComputedMetrics(
  workbook: WorkbookSpec,
  evaluation: WorkbookEvaluation,
  cells: SummaryCell[],
): ComputedMetric[] {
  const byName = new Map<string, SheetSpec>(workbook.sheets.map((s) => [s.name, s]));
  return cells.map((c) => {
    const split = splitCellRef(c.cellRef);
    const sheet = split ? byName.get(split.sheet) : undefined;
    const value = sheet && split ? displayValue(workbook, evaluation, sheet, split.ref) : '';
    return { ...c, value };
  });
}

/* ------------------------------------------------ number grounding */

const NUMBER_TOKEN_RE = /(?<![A-Za-z0-9])-?\d[\d.,]*(?:\s?%)?(?![A-Za-z0-9])/g;

/** Parse one numeric token the way Indonesian/English writers write it. */
function parseNumericToken(raw: string): number[] {
  let t = raw.trim();
  const isPercent = /%\s*$/.test(t);
  t = t.replace(/%\s*$/, '').trim().replace(/^(rp\.?|usd|\$|€|£)\s*/i, '').replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(t)) return [];
  const out: number[] = [];
  const decimalAware = parseDecimalAware(t);
  if (decimalAware !== null) out.push(isPercent ? decimalAware / 100 : decimalAware);
  const plain = Number(t.replace(/[.,]/g, ''));
  if (Number.isFinite(plain)) out.push(isPercent ? plain / 100 : plain);
  return [...new Set(out)];
}

function parseDecimalAware(t: string): number | null {
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  let normalized = t;
  if (dots > 0 && commas > 0) {
    normalized = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (commas > 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
  } else if (dots > 1 || /^\d{1,3}(\.\d{3})+$/.test(t)) {
    normalized = t.replace(/\./g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN_RE)) found.push(...parseNumericToken(match[0]));
  return found;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Hard validation of the model's report JSON: refs must all be
 * computed cells, and every number in the prose must occur among the
 * computed values. Exported for tests; synthesizeInsightReport uses
 * it through structuredCall.
 */
export function validateInsightReport(
  value: unknown,
  computed: ComputedMetric[],
): Verdict<{ findings: InsightFinding[]; recommendations: string[] }> {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object {"findings": [...], "recommendations": [...]}'] };
  const knownRefs = new Set(computed.map((c) => c.cellRef));
  const knownNumbers = computed.flatMap((c) => numbersIn(c.value));

  const findings: InsightFinding[] = [];
  if (!Array.isArray(value.findings) || value.findings.length === 0) {
    issues.push('findings must be a non-empty array');
  } else {
    for (const [i, raw] of (value.findings as unknown[]).entries()) {
      const where = `findings[${i}]`;
      if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
      const text = isNonEmptyString(raw.text) ? raw.text.trim() : '';
      if (!text) { issues.push(`${where} needs a text`); continue; }
      if (!Array.isArray(raw.refs) || raw.refs.length === 0 || !(raw.refs as unknown[]).every(isNonEmptyString)) {
        issues.push(`${where}: refs must be a non-empty array of cell addresses (mis. "Ringkasan!B2")`);
        continue;
      }
      for (const ref of raw.refs as string[]) {
        if (!knownRefs.has(ref)) issues.push(`${where}: refs "${ref}" bukan sel yang dihitung engine — hanya boleh: ${[...knownRefs].join(', ') || '(tidak ada)'}`);
      }
      for (const n of numbersIn(text)) {
        if (!knownNumbers.some((k) => closeEnough(k, n))) {
          issues.push(`${where}: angka "${n}" di teks tidak berasal dari nilai terverifikasi — hanya angka dari sel computed yang boleh disebut`);
          break;
        }
      }
      findings.push({ text, refs: (raw.refs as string[]).map((r) => r.trim()) });
    }
  }

  const recommendations: string[] = [];
  if (value.recommendations !== undefined) {
    if (!Array.isArray(value.recommendations)) issues.push('recommendations must be an array of strings');
    else for (const [i, raw] of (value.recommendations as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`recommendations[${i}] must be a non-empty string`); continue; }
      const text = raw.trim();
      for (const n of numbersIn(text)) {
        if (!knownNumbers.some((k) => closeEnough(k, n))) {
          issues.push(`recommendations[${i}]: angka "${n}" tidak berasal dari nilai terverifikasi`);
          break;
        }
      }
      recommendations.push(text);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { findings, recommendations } };
}

const REPORT_SYSTEM = [
  'You write the insight section of a data-analysis report. You output exactly one JSON object and nothing else.',
  'Shape: {"findings": [{"text": string, "refs": ["Ringkasan!B2"]}], "recommendations": [string]}',
  'Hard rules — violating any of them rejects your output:',
  '- You NEVER compute. Every number you write must appear among the computed values below (same value; thousand separators and % signs may differ). No other numbers in the prose — no years, no counts you made up, no "top 3" unless 3 is a computed value.',
  '- Every refs entry must be one of the computed cell addresses. Put cell addresses ONLY in refs, never bare in the text.',
  '- findings: what the verified numbers say (trends, leaders/laggards, notable ratios). recommendations: concrete next actions grounded in the findings.',
  '- Language: the user language of the question (default Indonesian). Be specific — cite the numbers.',
].join('\n');

export async function synthesizeInsightReport(
  provider: LLMProvider,
  args: {
    question: string;
    plan: AnalysisPlan;
    computed: ComputedMetric[];
    verify: VerifyReport;
  },
  signal?: AbortSignal,
): Promise<InsightReport> {
  const computedText = args.computed
    .map((c) => `- ${c.label} = ${c.value}  [${c.cellRef}]`)
    .join('\n');
  const planText = [
    `Metrik: ${args.plan.metrics.map((m) => `${m.label} (${m.id})`).join('; ')}`,
    args.plan.groupBys.length > 0 ? `Grouping: ${args.plan.groupBys.join(', ')}` : '',
    args.plan.comparisons.length > 0 ? `Perbandingan: ${args.plan.comparisons.join('; ')}` : '',
  ].filter(Boolean).join('\n');
  const { findings, recommendations } = await structuredCall<{ findings: InsightFinding[]; recommendations: string[] }>(
    provider,
    REPORT_SYSTEM,
    [
      `Question: ${args.question}`,
      '',
      'Analysis plan:',
      planText,
      '',
      'Computed values (VERIFIED — these are the only numbers you may cite):',
      computedText || '(tidak ada nilai terhitung)',
      '',
      `Verify: ${args.verify.summary}`,
    ].join('\n'),
    (value) => validateInsightReport(value, args.computed),
    signal,
  );
  return {
    question: args.question,
    findings,
    recommendations,
    verifiedAt: new Date().toISOString(),
    verifySummary: args.verify.summary,
  };
}
