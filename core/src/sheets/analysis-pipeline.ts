import type { LLMProvider } from '../providers/llm/types.ts';
import { evaluateWorkbook } from './evaluator.ts';
import { exportWorkbookToXlsx } from './export.ts';
import { applySheetOps } from './ops.ts';
import { profileWorkbook, type DatasetProfile } from './analysis-profile.ts';
import { FORMULA_CATALOG, validateAnalysisPlan, type AnalysisPlan } from './analysis-plan.ts';
import { synthesizeInsightReport, toComputedMetrics, type InsightReport, type SummaryCell } from './insight-report.ts';
import { SheetPipelineError, structuredCall } from './pipeline.ts';
import { formatCellRef, indexToCol, type CellScalar, type VerifyReport, type WorkbookSpec } from './workbook.ts';
import { verifyWorkbook } from './verify.ts';

/**
 * Frozen Analis orchestration (the DataInterpreter pattern, rebuilt
 * in TypeScript over the SpreadsheetEngine's own stages): the stage
 * order lives in code — Ingest → Profile → Plan → Compute → Verify →
 * Synthesize → Export — and the model only ever fills JSON slots
 * inside the plan/repair/synthesize stages. Compute materializes the
 * "Ringkasan" sheet through the closed op vocabulary (ops.ts), so
 * every derived cell is a live formula by construction: model
 * arithmetic is NEVER frozen into values.
 *
 * The plan → compute → verify → revise loop: a failed Verify gate
 * whose issues are all formula-family triggers at most
 * MAX_RECOMPUTE_ATTEMPTS re-materializations with a model-revised
 * plan spec (re-validated hard); anything else throws with the gate's
 * issues and NO report is synthesized.
 */

export type AnalysisStageId = 'ingest' | 'profile' | 'plan' | 'compute' | 'verify' | 'synthesize' | 'export';

/** The pipeline's action-space bound (TaskWeaver pattern): plan formula templates may only call these. */
export { FORMULA_CATALOG };

export const SUMMARY_SHEET_NAME = 'Ringkasan';
/** Re-materializations with a revised spec after a failed verify (initial compute + these). */
export const MAX_RECOMPUTE_ATTEMPTS = 2;

/** Verify error codes a revised plan spec can plausibly fix. */
const FIXABLE_VERIFY_CODES = new Set(['formula-error', 'broken-reference', 'circular-reference', 'recalc-error']);

export interface AnalysisPipelineInput {
  question: string;
  /** Already-imported dataset (CSV/XLSX → workbook.json via import.ts). */
  dataset: WorkbookSpec;
  /** The reviewed/staged plan — re-validated hard before compute. */
  plan: AnalysisPlan;
  provider: LLMProvider;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface AnalysisPipelineResult {
  workbook: WorkbookSpec;
  verify: VerifyReport;
  report: InsightReport;
  exported?: { path: string; bytes: number };
}

/* ------------------------------------------------------------ compute */

/** =FUNC(sheet!Xa:Xb) single-range aggregations the engine can group deterministically. */
const SIMPLE_AGG_RE = /^=([A-Za-z]+)\(\s*(?:'([^']+)'|([A-Za-z0-9_]+))!\$?([A-Za-z]{1,3})\$?(\d+|\{r\}):\$?([A-Za-z]{1,3})\$?(\d+|\{r\})\s*\)$/;

function quoteSheet(name: string): string {
  return /[^A-Za-z0-9_]/.test(name) ? `'${name}'` : name;
}

function resolveGroupColumn(profiles: DatasetProfile[], name: string): { profile: DatasetProfile; index: number } | null {
  const want = name.trim().toLowerCase();
  for (const profile of profiles) {
    const index = profile.columns.findIndex((c) => c.name.toLowerCase() === want);
    if (index >= 0) return { profile, index };
  }
  return null;
}

/**
 * Derive a per-group formula from an overall metric template when the
 * template is a simple =FUNC(range) aggregation:
 *   SUM → SUMIF, AVERAGE → AVERAGEIF, COUNT/COUNTA → COUNTIF.
 * Anything else returns null — the cell stays blank rather than
 * fabricating a derivation the engine cannot prove.
 */
function deriveGroupedFormula(
  template: string,
  groupSheet: string,
  groupColLetter: string,
  groupRow: number,
  lastDataRow1: number,
): string | null {
  const m = SIMPLE_AGG_RE.exec(template.trim());
  if (!m) return null;
  const func = (m[1] as string).toUpperCase();
  const sheet = quoteSheet(m[2] ?? m[3] as string);
  if (sheet.toLowerCase() !== quoteSheet(groupSheet).toLowerCase()) return null;
  const valueRange = `${sheet}!$${m[4]}$${m[5]}:$${m[6]}$${m[7]}`;
  const groupRange = `${quoteSheet(groupSheet)}!$${groupColLetter}$2:$${groupColLetter}$${lastDataRow1}`;
  const criterion = `$A${groupRow}`;
  if (func === 'SUM') return `=SUMIF(${groupRange},${criterion},${valueRange})`;
  if (func === 'AVERAGE') return `=AVERAGEIF(${groupRange},${criterion},${valueRange})`;
  if (func === 'COUNT' || func === 'COUNTA') return `=COUNTIF(${groupRange},${criterion})`;
  return null;
}

type GroupBlock = { groupBy: string; headerRow1: number; firstDataRow1: number; lastDataRow1: number; metricCols: number };

function setCellsOp(rows: CellScalar[][], startRow1: number): { op: string; sheet: string; range: string; values: CellScalar[][] } {
  const width = Math.max(...rows.map((r) => r.length));
  const endCol = indexToCol(width - 1);
  return {
    op: 'set_cells',
    sheet: SUMMARY_SHEET_NAME,
    range: `A${startRow1}:${endCol}${startRow1 + rows.length - 1}`,
    values: rows,
  };
}

/**
 * Materialize the Ringkasan sheet from a validated plan. Deterministic
 * and idempotent: the sheet is rebuilt from the dataset clone every
 * time, so verify-repair retries never accumulate stale rows.
 */
function materializeSummary(
  dataset: WorkbookSpec,
  plan: AnalysisPlan,
  profiles: DatasetProfile[],
): { workbook: WorkbookSpec; cells: SummaryCell[] } {
  const wb = JSON.parse(JSON.stringify(dataset)) as WorkbookSpec;
  wb.sheets = wb.sheets.filter((s) => s.name !== SUMMARY_SHEET_NAME);
  const bySheetName = new Map(wb.sheets.map((s) => [s.name, s]));

  const ops: unknown[] = [{ op: 'add_sheet', name: SUMMARY_SHEET_NAME }];
  const cells: SummaryCell[] = [];
  const formats: Array<{ range: string; numFmt: string }> = [];

  // Overall metrics block: one row per metric, live formula from the template.
  const metricRows: CellScalar[][] = [['Metrik', 'Nilai']];
  plan.metrics.forEach((metric, i) => {
    const row1 = i + 2;
    metricRows.push([metric.label, metric.formulaTemplate.replaceAll('{r}', String(row1))]);
    cells.push({ metricId: metric.id, label: metric.label, cellRef: `${SUMMARY_SHEET_NAME}!B${row1}` });
    if (metric.format) formats.push({ range: `B${row1}`, numFmt: metric.format });
  });
  ops.push(setCellsOp(metricRows, 1));
  let cursor1 = metricRows.length + 1; // next free 1-based row

  // Group-by blocks: distinct group values as literals, per-metric
  // formulas derived deterministically (never model arithmetic).
  const blocks: GroupBlock[] = [];
  for (const groupBy of plan.groupBys) {
    const resolved = resolveGroupColumn(profiles, groupBy);
    if (!resolved) continue; // validated earlier; defensive
    const sheet = bySheetName.get(resolved.profile.sheetName);
    if (!sheet) continue;
    const lastDataRow1 = resolved.profile.rowCount + 1;
    const seen = new Map<string, CellScalar>();
    for (let r = 1; r <= resolved.profile.rowCount; r += 1) {
      const cell = sheet.cells[formatCellRef(resolved.index, r)];
      if (cell?.v === undefined || cell.v === '') continue;
      const key = `${typeof cell.v}:${String(cell.v)}`;
      if (!seen.has(key)) seen.set(key, cell.v);
    }
    const values = [...seen.values()];
    if (values.length === 0) continue;
    const titleRow1 = cursor1 + 1;
    const headerRow1 = titleRow1 + 1;
    const firstDataRow1 = headerRow1 + 1;
    const groupColLetter = indexToCol(resolved.index);
    const blockRows: CellScalar[][] = [
      [`Per ${resolved.profile.columns[resolved.index]?.name ?? groupBy}`],
      [resolved.profile.columns[resolved.index]?.name ?? groupBy, ...plan.metrics.map((m) => m.label)],
    ];
    values.forEach((gv, vi) => {
      const row1 = firstDataRow1 + vi;
      const row: CellScalar[] = [gv];
      plan.metrics.forEach((metric, mi) => {
        const derived = deriveGroupedFormula(metric.formulaTemplate, resolved.profile.sheetName, groupColLetter, row1, lastDataRow1);
        row.push(derived ?? '');
        if (derived) {
          cells.push({
            metricId: `${metric.id}|${groupBy}|${String(gv)}`,
            label: `${metric.label} — ${groupBy}: ${String(gv)}`,
            cellRef: `${SUMMARY_SHEET_NAME}!${indexToCol(mi + 1)}${row1}`,
          });
          if (metric.format) formats.push({ range: `${indexToCol(mi + 1)}${row1}`, numFmt: metric.format });
        }
      });
      blockRows.push(row);
    });
    ops.push(setCellsOp(blockRows, titleRow1));
    blocks.push({ groupBy, headerRow1, firstDataRow1, lastDataRow1: firstDataRow1 + values.length - 1, metricCols: plan.metrics.length });
    cursor1 = titleRow1 + blockRows.length;
  }
  for (const f of formats) ops.push({ op: 'set_format', sheet: SUMMARY_SHEET_NAME, range: f.range, numFmt: f.numFmt });

  // Chart specs: bound to the matching group block when the plan's
  // categoryField is a group-by, else to the overall metrics block.
  plan.charts.forEach((chart, i) => {
    const block = blocks.find((b) => b.groupBy.toLowerCase() === chart.categoryField.trim().toLowerCase());
    const range = block
      ? `${SUMMARY_SHEET_NAME}!A${block.headerRow1}:${indexToCol(block.metricCols)}${block.lastDataRow1}`
      : `${SUMMARY_SHEET_NAME}!A1:B${plan.metrics.length + 1}`;
    ops.push({
      op: 'set_chart',
      sheet: SUMMARY_SHEET_NAME,
      id: `chart-analis-${i + 1}`,
      type: chart.type,
      range,
      anchor: `A${cursor1 + 2 + i * 16}`,
      title: chart.title,
    });
  });

  const applied = applySheetOps(wb, { kind: 'sheet-ops', ops });
  if (!applied.ok) {
    throw new SheetPipelineError(`gagal mematerialisasi sheet ${SUMMARY_SHEET_NAME}: ${applied.issues.join('; ')}`, applied.issues);
  }
  return { workbook: applied.workbook, cells };
}

/* -------------------------------------------------------------- repair */

const REPAIR_SYSTEM = [
  'You repair an analysis plan whose computed sheet failed verification. Output exactly one JSON analysis plan and nothing else.',
  'Shape: {"question": string, "metrics": [{"id": string, "label": string, "formulaTemplate": "=...", "format": "#,##0"}], "groupBys": [column names], "comparisons": [string], "charts": [{"type": "column|bar|line|pie", "title": string, "categoryField": column, "valueField": column}], "assumptions": [{"name": string, "value": scalar}], "steps": [string]}',
  'Rules: keep the question, metric ids/labels, groupBys, charts, and steps; fix ONLY what the verify issues blame — usually a formulaTemplate with a wrong sheet name, a column outside the dataset, or a function outside the catalog.',
  'Formula rules (violations are rejected): leading "="; dataset refs sheet-qualified with explicit row ranges (e.g. "=SUM(Data!D2:D101)"); "{r}" is the metric-row placeholder; only these functions: ' + FORMULA_CATALOG.map((f) => f.name).join(', ') + '.',
].join('\n');

async function repairAnalysisPlan(
  provider: LLMProvider,
  plan: AnalysisPlan,
  profiles: DatasetProfile[],
  issues: string[],
  signal?: AbortSignal,
): Promise<AnalysisPlan> {
  return structuredCall<AnalysisPlan>(
    provider,
    REPAIR_SYSTEM,
    [
      `Failing plan:\n${JSON.stringify(plan)}`,
      '',
      'Verify issues to fix:',
      ...issues.map((i) => `- ${i}`),
    ].join('\n'),
    (value) => validateAnalysisPlan(value, profiles),
    signal,
  );
}

/* ---------------------------------------------------------- pipeline */

function verifyIssues(report: VerifyReport): string[] {
  return report.errors.map((e) => `${e.sheet}!${e.cell} [${e.code}]: ${e.message}`);
}

export async function runAnalysisPipeline(input: AnalysisPipelineInput): Promise<AnalysisPipelineResult> {
  const signal = input.signal;
  // ingest: the dataset arrives already imported; guard the shape.
  if (!input.dataset || !Array.isArray(input.dataset.sheets) || input.dataset.sheets.length === 0) {
    throw new SheetPipelineError('analisis butuh dataset: workbook tanpa sheet');
  }
  if (!input.question || !input.question.trim()) {
    throw new SheetPipelineError('analisis butuh pertanyaan');
  }

  // profile: deterministic, zero LLM — grounds the plan stage.
  const profiles = profileWorkbook(input.dataset);

  // plan: the staged plan is re-validated hard before anything is written.
  const planVerdict = validateAnalysisPlan(input.plan, profiles);
  if (!planVerdict.ok) {
    throw new SheetPipelineError(`rencana analisis tidak valid: ${planVerdict.issues.join('; ')}`, planVerdict.issues);
  }
  let plan = planVerdict.value;

  // compute → verify, with the DataInterpreter revise loop on
  // formula-family failures (bounded re-materializations).
  let materialized = materializeSummary(input.dataset, plan, profiles);
  let verify = await verifyWorkbook(materialized.workbook, { coreOnly: true });
  for (let attempt = 0; !verify.ok && attempt < MAX_RECOMPUTE_ATTEMPTS; attempt += 1) {
    const issues = verifyIssues(verify);
    if (!verify.errors.every((e) => FIXABLE_VERIFY_CODES.has(e.code))) {
      throw new SheetPipelineError(`verify gagal (${verify.summary}): ${issues.join('; ')}`, issues);
    }
    plan = await repairAnalysisPlan(input.provider, plan, profiles, issues, signal);
    materialized = materializeSummary(input.dataset, plan, profiles);
    verify = await verifyWorkbook(materialized.workbook, { coreOnly: true });
  }
  if (!verify.ok) {
    const issues = verifyIssues(verify);
    throw new SheetPipelineError(
      `verify gagal setelah ${MAX_RECOMPUTE_ATTEMPTS + 1}x compute — tanpa laporan: ${issues.join('; ')}`,
      issues,
    );
  }

  // synthesize: only verified numbers reach the report writer.
  const evaluation = evaluateWorkbook(materialized.workbook);
  const computed = toComputedMetrics(materialized.workbook, evaluation, materialized.cells);
  const report = await synthesizeInsightReport(
    input.provider,
    { question: input.question.trim(), plan, computed, verify },
    signal,
  );

  // export.
  let exported: AnalysisPipelineResult['exported'];
  if (input.workspaceRoot) {
    const record = await exportWorkbookToXlsx(materialized.workbook, input.workspaceRoot);
    exported = { path: record.path, bytes: record.bytes };
  }

  return { workbook: materialized.workbook, verify, report, ...(exported ? { exported } : {}) };
}
