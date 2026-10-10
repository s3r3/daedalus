import type { ContentBlock, LLMProvider, Message } from '../providers/llm/types.ts';
import { MAX_SHEETS, type BlueprintColumn, type SheetBlueprint } from './workbook.ts';

/** Text of a provider message (string or text blocks) — local copy, no cross-domain import. */
function messageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');
}

/**
 * Spreadsheet pipeline stages. Sequencing lives in code (Intake →
 * Blueprint → Build → Verify → Export); the model only ever fills
 * JSON slots inside a stage. Two stage shapes exist:
 *  - the blueprint stage, whose output is staged in the panel for the
 *    user's "Buat" click (Standard flow — the design never lets a
 *    fresh generation run unstaged);
 *  - the row-fill stage, which returns literal input values only —
 *    formula columns are written by the engine from the blueprint's
 *    formula templates, so derived cells are live formulas by
 *    construction, never model arithmetic frozen into values.
 * Edit/repair go through the closed op vocabulary in ops.ts.
 */

export const MAX_STAGE_ATTEMPTS = 3;
export const MAX_FILL_ROWS = 500;

export class SheetPipelineError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'SheetPipelineError';
    this.issues = issues;
  }
}

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function extractJsonValue(raw: string): unknown {
  const candidates: string[] = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* next shape */ }
  }
  return undefined;
}

/**
 * Sheets-local copy of the slide pipeline's structured-call contract
 * (same doctrine, no cross-domain import): invalid output is retried
 * with verbatim issues; after the last attempt the stage throws and
 * nothing is fabricated.
 */
export async function structuredCall<T>(
  provider: LLMProvider,
  system: string,
  user: string,
  validate: (value: unknown) => Verdict<T>,
  signal?: AbortSignal,
): Promise<T> {
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let issues: string[] = ['model produced no parseable JSON'];
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await provider.chat(messages, undefined, signal ? { signal } : undefined);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      issues = [`the model request failed: ${message}`];
      if (attempt < MAX_STAGE_ATTEMPTS) {
        messages.push({ role: 'user', content: `The previous request failed (${message}). Return the corrected JSON only — no prose, no explanation, no markdown fences.` });
        continue;
      }
      throw new SheetPipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
    }
    const raw = messageText(response.message.content);
    const verdict = validate(extractJsonValue(raw));
    if (verdict.ok) return verdict.value;
    issues = verdict.issues;
    if (attempt < MAX_STAGE_ATTEMPTS) {
      messages.push({ role: 'assistant', content: raw.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: `That output is invalid:\n${verdict.issues.map((i) => `- ${i}`).join('\n')}\n\nReturn corrected JSON only — no prose, no explanation, no markdown fences.`,
      });
    }
  }
  throw new SheetPipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* -------------------------------------------------------- blueprint */

export type BlueprintStageInput = {
  goal: string;
  /** Perception summaries of attached/imported sources (never a full grid dump). */
  sourceSummaries: Array<{ path: string; sheets: Array<{ name: string; rows: number; cols: number; headers: string[]; sampleRows: string[][] }> }>;
  /** Summary of an already-open workbook (audit/edit context), when present. */
  existingSummary?: string;
};

const COLUMN_TYPES = ['text', 'number', 'currency', 'percent', 'date', 'boolean'] as const;

export function validateBlueprint(value: unknown, goal: string): Verdict<SheetBlueprint> {
  const issues: string[] = [];
  if (!isObj(value)) return { ok: false, issues: ['expected a JSON object {"title": ..., "sheets": [...], "assumptions": [...]}'] };
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '';
  if (!Array.isArray(value.sheets) || value.sheets.length === 0) issues.push('sheets must be a non-empty array');
  if (Array.isArray(value.sheets) && value.sheets.length > MAX_SHEETS) issues.push(`at most ${MAX_SHEETS} sheets`);
  const sheets: SheetBlueprint['sheets'] = [];
  const sheetNames = new Set<string>();
  for (const [si, rawSheet] of (value.sheets as unknown[]).entries()) {
    if (!isObj(rawSheet) || typeof rawSheet.name !== 'string' || !rawSheet.name.trim()) { issues.push(`sheets[${si}] needs a name`); continue; }
    const name = rawSheet.name.trim();
    if (sheetNames.has(name.toLowerCase())) issues.push(`sheet name "${name}" is duplicated`);
    sheetNames.add(name.toLowerCase());
    if (!Array.isArray(rawSheet.columns) || rawSheet.columns.length === 0) { issues.push(`sheet "${name}" needs at least one column`); continue; }
    const columns: BlueprintColumn[] = [];
    const colNames = new Set<string>();
    for (const [ci, rawCol] of (rawSheet.columns as unknown[]).entries()) {
      if (!isObj(rawCol) || typeof rawCol.name !== 'string' || !rawCol.name.trim()) { issues.push(`sheet "${name}" columns[${ci}] needs a name`); continue; }
      const colName = rawCol.name.trim();
      if (colNames.has(colName.toLowerCase())) issues.push(`sheet "${name}" column "${colName}" is duplicated`);
      colNames.add(colName.toLowerCase());
      const type = (COLUMN_TYPES as readonly string[]).includes(String(rawCol.type)) ? rawCol.type as BlueprintColumn['type'] : 'text';
      const source = rawCol.source === 'formula' ? 'formula' : rawCol.source === 'assumption' ? 'assumption' : 'input';
      const formula = typeof rawCol.formula === 'string' ? rawCol.formula : undefined;
      if (source === 'formula' && (!formula || !formula.startsWith('='))) {
        issues.push(`sheet "${name}" column "${colName}" is source "formula" but carries no formula template starting with =`);
      }
      columns.push({ name: colName, type, source, ...(formula ? { formula } : {}) });
    }
    const charts = Array.isArray(rawSheet.charts) ? (rawSheet.charts as unknown[]).filter(isObj).map((c, i) => ({
      id: typeof c.id === 'string' ? c.id : `chart-${si}-${i}`,
      type: typeof c.type === 'string' ? c.type : 'column',
      range: typeof c.range === 'string' ? c.range : '',
      anchor: typeof c.anchor === 'string' ? c.anchor : 'A1',
      ...(typeof c.title === 'string' ? { title: c.title } : {}),
    })).filter((c) => c.range.length > 0) : undefined;
    const pivots = Array.isArray(rawSheet.pivots) ? (rawSheet.pivots as unknown[]).filter(isObj).map((p, i) => ({
      id: typeof p.id === 'string' ? p.id : `pivot-${si}-${i}`,
      source: typeof p.source === 'string' ? p.source : '',
      target: typeof p.target === 'string' ? p.target : name,
      rows: Array.isArray(p.rows) ? p.rows.filter((r): r is string => typeof r === 'string') : [],
      ...(Array.isArray(p.cols) ? { cols: p.cols.filter((r): r is string => typeof r === 'string') } : {}),
      values: Array.isArray(p.values) ? p.values.filter(isObj).map((v) => ({
        field: typeof v.field === 'string' ? v.field : '',
        agg: (['sum', 'count', 'average', 'min', 'max'] as const).includes(v.agg as 'sum') ? (v.agg as 'sum' | 'count' | 'average' | 'min' | 'max') : 'sum' as const,
      })).filter((v) => v.field.length > 0) : [],
    })).filter((p) => p.source.length > 0 && p.rows.length > 0) : undefined;
    sheets.push({
      name,
      ...(typeof rawSheet.purpose === 'string' ? { purpose: rawSheet.purpose } : {}),
      columns,
      ...(typeof rawSheet.summary === 'string' ? { summary: rawSheet.summary } : {}),
      ...(charts && charts.length > 0 ? { charts } : {}),
      ...(pivots && pivots.length > 0 ? { pivots } : {}),
    });
  }
  const assumptions: SheetBlueprint['assumptions'] = [];
  if (value.assumptions !== undefined && !Array.isArray(value.assumptions)) issues.push('assumptions must be an array');
  for (const [ai, raw] of ((value.assumptions as unknown[] | undefined) ?? []).entries()) {
    if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name.trim()) { issues.push(`assumptions[${ai}] needs a name`); continue; }
    const v = raw.value;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { issues.push(`assumptions[${ai}] ("${raw.name}") needs a scalar value`); continue; }
    assumptions.push({ name: raw.name.trim(), value: v, ...(typeof raw.note === 'string' ? { note: raw.note } : {}) });
  }
  if (issues.length > 0) return { ok: false, issues };
  void title;
  return {
    ok: true,
    value: {
      goal,
      sources: [],
      assumptions,
      sheets,
      ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    },
  };
}

const BLUEPRINT_SYSTEM = [
  'You are the blueprint stage of an agentic spreadsheet builder. You output exactly one JSON object and nothing else.',
  'Shape: {"title": string, "sheets": [{"name": string, "purpose": string, "columns": [{"name": string, "type": "text|number|currency|percent|date|boolean", "source": "input|formula|assumption", "formula": "=...{r}..."}], "summary": string, "charts": [{"type": "column|bar|line|pie", "range": "Sheet!A1:B9", "anchor": "D2", "title": string}], "pivots": [{"source": "Data!A1:F100", "target": "Ringkasan", "rows": ["Kategori"], "values": [{"field": "Total", "agg": "sum"}]}]}], "assumptions": [{"name": string, "value": number|string|boolean, "note": string}], "notes": string}',
  'Rules:',
  '- Design the workbook the user asked for: a data sheet (raw/input rows), an "Asumsi" sheet for every rate/price/threshold the math depends on, and a summary/dashboard sheet whose cells are live formulas.',
  '- Every derived number is a formula. Formula templates use {r} as the row placeholder (e.g. "=B{r}*Asumsi!$B$2"); cross-sheet references to assumptions use absolute $ refs.',
  '- Column names are headers; keep them short and in the user language of the goal (default Indonesian).',
  '- "charts" and "pivots" are optional native specs for the export stage; only include them when the goal asks for a chart or a pivot summary.',
  '- Never invent data values in the blueprint; only structure, formulas, and assumptions.',
].join('\n');

export async function generateBlueprintStage(
  provider: LLMProvider,
  input: BlueprintStageInput,
  signal?: AbortSignal,
): Promise<SheetBlueprint & { title: string }> {
  const sourceText = input.sourceSummaries.length === 0
    ? 'No source files: design from the goal text alone.'
    : input.sourceSummaries.map((s) => [
        `Source file: ${s.path}`,
        ...s.sheets.map((sh) => `  Sheet "${sh.name}": ${sh.rows} rows × ${sh.cols} cols; headers: ${sh.headers.join(' | ') || '(none detected)'}; sample rows: ${sh.sampleRows.map((r) => r.join(' | ')).join(' ;; ') || '(none)'}`),
      ].join('\n')).join('\n');
  const user = [
    `Goal: ${input.goal}`,
    input.existingSummary ? `Existing workbook summary:\n${input.existingSummary}` : '',
    sourceText,
  ].filter(Boolean).join('\n\n');
  const blueprint = await structuredCall<SheetBlueprint & { title: string }>(
    provider,
    BLUEPRINT_SYSTEM,
    user,
    (value) => {
      const verdict = validateBlueprint(value, input.goal);
      if (!verdict.ok) return verdict;
      const title = isObj(value) && typeof value.title === 'string' && value.title.trim() ? value.title.trim() : input.goal.slice(0, 60);
      return { ok: true, value: { ...verdict.value, title } };
    },
    signal,
  );
  return blueprint;
}

/* ------------------------------------------------------------ fill */

export type FillStageInput = {
  goal: string;
  sheetName: string;
  columns: BlueprintColumn[];
  assumptionsSheet?: string;
};

export type FillStageResult = { rows: Array<Array<string | number | boolean>> };

export function validateFillRows(value: unknown, inputColumns: BlueprintColumn[]): Verdict<FillStageResult> {
  if (!isObj(value) || !Array.isArray(value.rows)) return { ok: false, issues: ['expected {"rows": [[...], ...]}'] };
  const issues: string[] = [];
  const rows: FillStageResult['rows'] = [];
  const width = inputColumns.length;
  for (const [ri, rawRow] of (value.rows as unknown[]).entries()) {
    if (!Array.isArray(rawRow)) { issues.push(`rows[${ri}] must be an array`); continue; }
    if (rawRow.length !== width) { issues.push(`rows[${ri}] has ${rawRow.length} values but the sheet has ${width} input columns`); continue; }
    const row: Array<string | number | boolean> = [];
    let bad = false;
    for (const cell of rawRow as unknown[]) {
      if (typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean') { bad = true; break; }
      row.push(cell);
    }
    if (bad) { issues.push(`rows[${ri}] contains a non-scalar value`); continue; }
    rows.push(row);
  }
  if (rows.length === 0) issues.push('rows must not be empty');
  if (rows.length > MAX_FILL_ROWS) issues.push(`at most ${MAX_FILL_ROWS} rows per fill`);
  return issues.length ? { ok: false, issues } : { ok: true, value: { rows } };
}

const FILL_SYSTEM = [
  'You fill the input columns of one spreadsheet sheet. Output exactly one JSON object: {"rows": [[...], ...]} and nothing else.',
  'Each row has exactly one scalar (string, number, or boolean) per listed input column, in order.',
  'Numbers are numbers (no thousand separators, no currency symbols); dates are "YYYY-MM-DD" strings; percents are decimals (0.12 for 12%).',
  'Generate realistic data that satisfies the goal; never add totals or summary rows unless asked.',
].join('\n');

export async function fillSheetRowsStage(
  provider: LLMProvider,
  input: FillStageInput,
  signal?: AbortSignal,
): Promise<FillStageResult> {
  const inputColumns = input.columns.filter((c) => c.source === 'input');
  const user = [
    `Goal: ${input.goal}`,
    `Sheet: ${input.sheetName}`,
    `Input columns (in order): ${inputColumns.map((c) => `${c.name} (${c.type})`).join(', ')}`,
  ].join('\n');
  return structuredCall<FillStageResult>(
    provider,
    FILL_SYSTEM,
    user,
    (value) => validateFillRows(value, inputColumns),
    signal,
  );
}
