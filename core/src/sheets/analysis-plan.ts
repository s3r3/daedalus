import type { LLMProvider } from '../providers/llm/types.ts';
import { structuredCall } from './pipeline.ts';
import { indexToCol } from './refs.ts';
import type { DatasetProfile } from './analysis-profile.ts';

/**
 * Two-call analysis planner (the reginald-francis pattern: a cheap
 * classifier call, then the spec call). The model ONLY emits spec
 * JSON — metric formula *templates*, never computed numbers. Every
 * template is validated hard before any cell is written:
 *  - names a real profiled column (or a sheet the engine owns),
 *  - starts with '=',
 *  - calls only functions from FORMULA_CATALOG (the TaskWeaver
 *    pattern: a typed function catalog bounding the action space).
 */

export interface CatalogFunction {
  name: string;
  signature: string;
  returns: 'number' | 'text' | 'boolean';
}

/**
 * Typed formula-function catalog. Every entry is supported by the
 * in-core evaluator, so a catalogued formula stays on the verify
 * gate's 'core' path instead of degrading to 'partial'. Re-exported
 * from analysis-pipeline.ts as the pipeline's action-space bound.
 */
export const FORMULA_CATALOG: CatalogFunction[] = [
  { name: 'SUM', signature: 'SUM(range, ...)', returns: 'number' },
  { name: 'AVERAGE', signature: 'AVERAGE(range, ...)', returns: 'number' },
  { name: 'COUNT', signature: 'COUNT(range, ...)', returns: 'number' },
  { name: 'COUNTA', signature: 'COUNTA(range, ...)', returns: 'number' },
  { name: 'SUMIF', signature: 'SUMIF(criteria_range, criteria, [sum_range])', returns: 'number' },
  { name: 'COUNTIF', signature: 'COUNTIF(range, criteria)', returns: 'number' },
  { name: 'SUMIFS', signature: 'SUMIFS(sum_range, criteria_range1, criteria1, ...)', returns: 'number' },
  { name: 'COUNTIFS', signature: 'COUNTIFS(criteria_range1, criteria1, ...)', returns: 'number' },
  { name: 'AVERAGEIF', signature: 'AVERAGEIF(range, criteria, [average_range])', returns: 'number' },
  { name: 'MIN', signature: 'MIN(range, ...)', returns: 'number' },
  { name: 'MAX', signature: 'MAX(range, ...)', returns: 'number' },
  { name: 'IF', signature: 'IF(logical_test, value_if_true, value_if_false)', returns: 'number' },
  { name: 'IFERROR', signature: 'IFERROR(value, value_if_error)', returns: 'number' },
  { name: 'ROUND', signature: 'ROUND(number, num_digits)', returns: 'number' },
  { name: 'ABS', signature: 'ABS(number)', returns: 'number' },
  { name: 'AND', signature: 'AND(logical1, ...)', returns: 'boolean' },
  { name: 'OR', signature: 'OR(logical1, ...)', returns: 'boolean' },
  { name: 'NOT', signature: 'NOT(logical)', returns: 'boolean' },
  { name: 'CONCAT', signature: 'CONCAT(text1, ...)', returns: 'text' },
  { name: 'TEXT', signature: 'TEXT(value, format_text)', returns: 'text' },
  { name: 'UPPER', signature: 'UPPER(text)', returns: 'text' },
  { name: 'LOWER', signature: 'LOWER(text)', returns: 'text' },
  { name: 'TRIM', signature: 'TRIM(text)', returns: 'text' },
  { name: 'LEN', signature: 'LEN(text)', returns: 'number' },
  { name: 'TODAY', signature: 'TODAY()', returns: 'number' },
  { name: 'YEAR', signature: 'YEAR(date)', returns: 'number' },
  { name: 'MONTH', signature: 'MONTH(date)', returns: 'number' },
  { name: 'DAY', signature: 'DAY(date)', returns: 'number' },
];

const CATALOG_NAMES = new Set(FORMULA_CATALOG.map((f) => f.name));

export interface AnalysisMetric {
  id: string;
  label: string;
  /**
   * Live-formula template, leading '=' required. `{r}` is the row
   * placeholder the compute stage substitutes with the metric's own
   * 1-based row on the Ringkasan sheet (blueprint convention).
   * Dataset refs must be sheet-qualified, e.g.
   * "=SUM(Data!D2:D101)" or "=SUMIF(Data!$B$2:$B$101,$A{r},Data!$D$2:$D$101)".
   */
  formulaTemplate: string;
  /** Excel numFmt for the value cell, e.g. '#,##0' or '0.0%'. */
  format?: string;
}

export interface AnalysisChart {
  type: 'column' | 'bar' | 'line' | 'pie';
  title: string;
  categoryField: string;
  valueField: string;
}

export interface AnalysisPlan {
  question: string;
  metrics: AnalysisMetric[];
  groupBys: string[];
  comparisons: string[];
  charts: AnalysisChart[];
  assumptions: Array<{ name: string; value: string | number | boolean }>;
  steps: string[];
}

export type AnalysisComplexity = 'simple' | 'moderate' | 'complex';

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Case-insensitive column lookup across all profiles. */
function findColumn(profiles: DatasetProfile[], name: string): { profile: DatasetProfile; index: number } | null {
  const want = name.trim().toLowerCase();
  for (const profile of profiles) {
    const index = profile.columns.findIndex((c) => c.name.toLowerCase() === want);
    if (index >= 0) return { profile, index };
  }
  return null;
}

function findProfile(profiles: DatasetProfile[], sheetName: string): DatasetProfile | null {
  const want = sheetName.toLowerCase();
  return profiles.find((p) => p.sheetName.toLowerCase() === want) ?? null;
}

/** Strip string literals so quoted text can't fake a function call. */
function stripStrings(formula: string): string {
  return formula.replace(/"[^"]*"/g, '""');
}

// Ref tokens incl. the {r} row placeholder: [sheet!]col$row — the row
// part is digits or {r}. Mirrors ops.ts REF_TOKEN_RE plus {r}.
const REF_RE = /((?:'[^']+'|[A-Za-z0-9_]+)!)?(\$?)([A-Za-z]{1,3})(\$?)(\{r\}|\d{1,7})/g;
// Bare words followed by '(' — candidate function calls.
const CALL_RE = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Hard formula check: every referenced column must exist in the
 * profiled dataset and every called function must be catalogued.
 * Refs qualified with a sheet the profiler did not see (the engine's
 * own Ringkasan/Asumsi sheets) are left to the Verify gate.
 */
export function validateFormulaTemplate(template: string, profiles: DatasetProfile[], where: string): string[] {
  const issues: string[] = [];
  const code = stripStrings(template);
  for (const match of code.matchAll(REF_RE)) {
    const idx = match.index ?? 0;
    // A function name that merely looks like a ref (LOG10() stays put).
    if (code[idx + match[0].length] === '(') continue;
    const qualifier = match[1] as string | undefined;
    const colIndex = colLettersToIndex(match[3] as string);
    if (qualifier) {
      const sheetName = qualifier.endsWith('!') ? qualifier.slice(0, -1).replace(/^'|'$/g, '') : qualifier;
      const profile = findProfile(profiles, sheetName);
      if (profile && colIndex >= profile.columns.length) {
        issues.push(`${where}: kolom ${match[3]} di luar jangkauan sheet "${sheetName}" (${profile.columns.length} kolom terprofil)`);
      }
      // Unknown sheet qualifier: engine-owned sheet — Verify gate judges it.
    } else if (profiles.length > 0 && colIndex >= (profiles[0] as DatasetProfile).columns.length) {
      issues.push(`${where}: referensi kolom ${match[3]} tanpa nama sheet di luar ${ (profiles[0] as DatasetProfile).columns.length} kolom dataset — kualifikasi dengan nama sheet (mis. ${(profiles[0] as DatasetProfile).sheetName}!${match[3]}2)`);
    }
  }
  for (const match of code.matchAll(CALL_RE)) {
    const name = (match[1] as string).toUpperCase();
    if (!CATALOG_NAMES.has(name)) {
      issues.push(`${where}: fungsi "${match[1]}" di luar katalog formula — hanya boleh: ${[...CATALOG_NAMES].join(', ')}`);
    }
  }
  return issues;
}

const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;

/**
 * Hard plan validation (the pipeline.ts Verdict pattern): unknown
 * columns, missing '=', duplicate metric ids, and off-catalog
 * functions are all rejected — nothing reaches the compute stage
 * ungrounded.
 */
export function validateAnalysisPlan(value: unknown, profiles: DatasetProfile[]): Verdict<AnalysisPlan> {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object {"question": ..., "metrics": [...], ...}'] };
  const question = isNonEmptyString(value.question) ? value.question.trim() : '';
  if (!question) issues.push('question must be a non-empty string');

  const metrics: AnalysisMetric[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(value.metrics) || value.metrics.length === 0) {
    issues.push('metrics must be a non-empty array');
  } else {
    for (const [i, raw] of (value.metrics as unknown[]).entries()) {
      const where = `metrics[${i}]`;
      if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
      const id = isNonEmptyString(raw.id) ? raw.id.trim() : '';
      const label = isNonEmptyString(raw.label) ? raw.label.trim() : '';
      if (!id) issues.push(`${where} needs an id`);
      else if (seenIds.has(id.toLowerCase())) issues.push(`${where}: metric id "${id}" duplikat`);
      else seenIds.add(id.toLowerCase());
      if (!label) issues.push(`${where} ("${id || '?'})") needs a label`);
      const template = typeof raw.formulaTemplate === 'string' ? raw.formulaTemplate : '';
      if (!template.startsWith('=')) {
        issues.push(`${where} ("${id}"): formulaTemplate harus diawali '='`);
      } else {
        issues.push(...validateFormulaTemplate(template, profiles, `${where} ("${id}")`));
      }
      const format = typeof raw.format === 'string' && raw.format ? raw.format : undefined;
      metrics.push({ id, label, formulaTemplate: template, ...(format ? { format } : {}) });
    }
  }

  const groupBys: string[] = [];
  if (value.groupBys !== undefined) {
    if (!Array.isArray(value.groupBys)) issues.push('groupBys must be an array of column names');
    else for (const [i, raw] of (value.groupBys as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`groupBys[${i}] must be a column name string`); continue; }
      if (!findColumn(profiles, raw)) issues.push(`groupBys[${i}]: kolom "${raw}" tidak ada di dataset terprofil`);
      else groupBys.push(raw.trim());
    }
  }

  const comparisons: string[] = [];
  if (value.comparisons !== undefined) {
    if (!Array.isArray(value.comparisons)) issues.push('comparisons must be an array of strings');
    else for (const [i, raw] of (value.comparisons as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`comparisons[${i}] must be a non-empty string`); continue; }
      comparisons.push(raw.trim());
    }
  }

  const charts: AnalysisChart[] = [];
  if (value.charts !== undefined) {
    if (!Array.isArray(value.charts)) issues.push('charts must be an array');
    else for (const [i, raw] of (value.charts as unknown[]).entries()) {
      const where = `charts[${i}]`;
      if (!isObj(raw)) { issues.push(`${where} must be an object`); continue; }
      if (!(CHART_TYPES as readonly string[]).includes(String(raw.type))) { issues.push(`${where}: type harus salah satu ${CHART_TYPES.join(', ')}`); continue; }
      const title = isNonEmptyString(raw.title) ? raw.title.trim() : '';
      if (!title) issues.push(`${where} needs a title`);
      const categoryField = isNonEmptyString(raw.categoryField) ? raw.categoryField.trim() : '';
      const valueField = isNonEmptyString(raw.valueField) ? raw.valueField.trim() : '';
      if (!categoryField || !findColumn(profiles, categoryField)) issues.push(`${where}: categoryField "${String(raw.categoryField)}" bukan kolom dataset`);
      if (!valueField || !findColumn(profiles, valueField)) issues.push(`${where}: valueField "${String(raw.valueField)}" bukan kolom dataset`);
      charts.push({ type: raw.type as AnalysisChart['type'], title, categoryField, valueField });
    }
  }

  const assumptions: AnalysisPlan['assumptions'] = [];
  if (value.assumptions !== undefined) {
    if (!Array.isArray(value.assumptions)) issues.push('assumptions must be an array');
    else for (const [i, raw] of (value.assumptions as unknown[]).entries()) {
      if (!isObj(raw) || !isNonEmptyString(raw.name)) { issues.push(`assumptions[${i}] needs a name`); continue; }
      const v = raw.value;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { issues.push(`assumptions[${i}] ("${raw.name}") needs a scalar value`); continue; }
      assumptions.push({ name: raw.name.trim(), value: v });
    }
  }

  const steps: string[] = [];
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    issues.push('steps must be a non-empty array of strings');
  } else {
    for (const [i, raw] of (value.steps as unknown[]).entries()) {
      if (!isNonEmptyString(raw)) { issues.push(`steps[${i}] must be a non-empty string`); continue; }
      steps.push(raw.trim());
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { question, metrics, groupBys, comparisons, charts, assumptions, steps } };
}

/* ------------------------------------------------------- two calls */

function profileGrounding(profiles: DatasetProfile[]): string {
  return profiles.map((p) => {
    const cols = p.columns
      .map((c, i) => `  ${indexToCol(i)}. "${c.name}" (${c.type}; null ${(c.nullRate * 100).toFixed(0)}%; ${c.cardinality} nilai unik${c.samples.length ? `; cth: ${c.samples.join(', ')}` : ''})`)
      .join('\n');
    return [
      `Sheet "${p.sheetName}": ${p.rowCount} baris data (baris 2..${p.rowCount + 1}), kolom:`,
      cols || '  (tidak ada kolom terprofil)',
      p.groupCandidates.length > 0 ? `Kandidat grouping: ${p.groupCandidates.join(', ')}` : 'Kandidat grouping: —',
    ].join('\n');
  }).join('\n\n');
}

const CLASSIFY_SYSTEM = [
  'You classify the complexity of a data-analysis question. Output exactly one JSON object: {"complexity": "simple"|"moderate"|"complex"} and nothing else.',
  '- simple: one aggregate or lookup over the dataset (e.g. total revenue, row count).',
  '- moderate: several metrics, one or two group-bys, basic comparisons.',
  '- complex: many metrics, multiple group-bys, derived ratios, several charts.',
].join('\n');

/**
 * Call 1 — cheap intent/complexity routing. Retry budget is the
 * shared MAX_STAGE_ATTEMPTS inside structuredCall (keputusan final
 * 2026-10-12: disamakan, bukan 2/3/5).
 */
export async function classifyAnalysisIntent(
  provider: LLMProvider,
  question: string,
  profiles: DatasetProfile[],
  signal?: AbortSignal,
): Promise<{ complexity: AnalysisComplexity }> {
  return structuredCall<{ complexity: AnalysisComplexity }>(
    provider,
    CLASSIFY_SYSTEM,
    [`Question: ${question}`, '', 'Dataset:', profileGrounding(profiles)].join('\n'),
    (value) => {
      if (!isObj(value) || !['simple', 'moderate', 'complex'].includes(String(value.complexity))) {
        return { ok: false, issues: ['expected {"complexity": "simple"|"moderate"|"complex"}'] };
      }
      return { ok: true, value: { complexity: value.complexity as AnalysisComplexity } };
    },
    signal,
  );
}

const PLAN_SYSTEM = [
  'You are the planner of an agentic spreadsheet analyst. You output exactly one JSON object and nothing else.',
  'Shape: {"question": string, "metrics": [{"id": string, "label": string, "formulaTemplate": "=...", "format": "#,##0"}], "groupBys": [column names], "comparisons": [string], "charts": [{"type": "column|bar|line|pie", "title": string, "categoryField": column, "valueField": column}], "assumptions": [{"name": string, "value": scalar}], "steps": [string]}',
  'Rules:',
  '- metrics: one row per business metric the question needs. formulaTemplate is a LIVE formula template (leading "=") over the dataset — never a number you computed yourself.',
  '- Dataset refs must be sheet-qualified with explicit row ranges, e.g. "=SUM(Data!D2:D101)". "{r}" is the placeholder for the metric\'s own row on the Ringkasan sheet (blueprint convention).',
  '- Only these functions exist: ' + FORMULA_CATALOG.map((f) => f.signature).join('; ') + '. Any other function name is rejected.',
  '- groupBys: column names from the profile (prefer the group candidates). charts reference real profiled columns.',
  '- Never invent data values; structure and formulas only. Labels/steps in the user language of the question (default Indonesian).',
].join('\n');

/** Call 2 — emit the AnalysisPlan spec, validated hard against the profiles. */
export async function generateAnalysisPlan(
  provider: LLMProvider,
  question: string,
  profiles: DatasetProfile[],
  signal?: AbortSignal,
): Promise<AnalysisPlan> {
  return structuredCall<AnalysisPlan>(
    provider,
    PLAN_SYSTEM,
    [`Question: ${question}`, '', 'Dataset profile (grounding — only these columns exist):', profileGrounding(profiles)].join('\n'),
    (value) => validateAnalysisPlan(value, profiles),
    signal,
  );
}
