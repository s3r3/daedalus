import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  formatCellRef,
  parseCellRef,
  parseRange,
  sheetBounds,
  sheetHeaders,
  workbookPaths,
  MAX_CELLS_PER_SHEET,
  MAX_SHEETS,
  type SheetSpec,
  type WorkbookIssue,
  type WorkbookSpec,
} from './workbook.ts';

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  try {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }
}

export function newWorkbookId(): string { return uniqueId('wb'); }
export function newSheetId(): string { return uniqueId('sheet'); }

export function newWorkbook(title: string, meta: { createdBy: string; model?: string }): WorkbookSpec {
  return {
    version: 1,
    id: newWorkbookId(),
    title,
    stage: 'blueprint',
    sheets: [],
    meta: { ...meta, createdAt: new Date().toISOString() },
  };
}

export function newSheet(name: string): SheetSpec {
  return { id: newSheetId(), name, cells: {} };
}

export async function ensureWorkbookDir(root: string): Promise<{ dir: string; file: string }> {
  const paths = workbookPaths(root);
  await mkdir(paths.dir, { recursive: true });
  return paths;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isWorkbookShape(v: unknown): v is WorkbookSpec {
  if (!isObj(v)) return false;
  if (v.version !== 1) return false;
  if (typeof v.id !== 'string' || typeof v.title !== 'string') return false;
  if (v.stage !== 'blueprint' && v.stage !== 'ready') return false;
  if (!Array.isArray(v.sheets)) return false;
  for (const s of v.sheets as unknown[]) {
    if (!isObj(s)) return false;
    if (typeof s.id !== 'string' || typeof s.name !== 'string') return false;
    if (!isObj(s.cells)) return false;
  }
  if (!isObj(v.meta) || typeof v.meta.createdBy !== 'string') return false;
  return true;
}

export async function readWorkbook(root: string): Promise<WorkbookSpec | null> {
  const paths = workbookPaths(root);
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`workbook.json is not valid JSON (${paths.file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isWorkbookShape(parsed)) {
    throw new Error(`workbook.json has an invalid shape (${paths.file}): expected {version:1, id, title, stage, sheets[], meta}`);
  }
  return parsed;
}

export async function writeWorkbook(root: string, workbook: WorkbookSpec): Promise<void> {
  const paths = await ensureWorkbookDir(root);
  const tmp = `${paths.file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(workbook, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.file);
}

/**
 * Structural validation of the source of truth. Errors are the ones the
 * canvas save and the edit-op seam refuse on; the evaluator separately
 * judges formula *results* (verify stage), which are not structural.
 */
export function validateWorkbook(workbook: WorkbookSpec): WorkbookIssue[] {
  const issues: WorkbookIssue[] = [];
  const err = (code: string, message: string, sheet?: string, cell?: string): void => {
    issues.push({ code, message, severity: 'error', ...(sheet ? { sheet } : {}), ...(cell ? { cell } : {}) });
  };
  if (!workbook || typeof workbook !== 'object') {
    return [{ code: 'invalid-workbook', message: 'workbook must be an object', severity: 'error' }];
  }
  if (workbook.version !== 1) err('invalid-version', `workbook version must be 1, got ${String(workbook.version)}`);
  if (typeof workbook.title !== 'string' || workbook.title.trim().length === 0) err('missing-title', 'workbook title is required');
  if (!Array.isArray(workbook.sheets)) {
    err('invalid-sheets', 'workbook sheets must be an array');
    return issues;
  }
  if (workbook.sheets.length > MAX_SHEETS) {
    issues.push({ code: 'too-many-sheets', message: `workbook has ${workbook.sheets.length} sheets (max ${MAX_SHEETS})`, severity: 'warning' });
  }
  if (workbook.sheets.length === 0) {
    issues.push({ code: 'empty-workbook', message: 'workbook has no sheets yet', severity: 'warning' });
  }

  const sheetNames = new Map<string, string>();
  for (const sheet of workbook.sheets) {
    if (typeof sheet.name !== 'string' || sheet.name.trim().length === 0) {
      err('missing-sheet-name', 'every sheet needs a non-empty name', sheet?.id);
      continue;
    }
    const key = sheet.name.toLowerCase();
    if (sheetNames.has(key)) err('duplicate-sheet-name', `sheet name "${sheet.name}" appears more than once`, sheet.name);
    else sheetNames.set(key, sheet.id);
    if (/[[\]:*?/\\]/.test(sheet.name)) err('invalid-sheet-name', `sheet name "${sheet.name}" contains characters Excel forbids ([]:*?/\\)`, sheet.name);
    if (sheet.name.length > 31) err('sheet-name-too-long', `sheet name "${sheet.name}" is ${sheet.name.length} chars (max 31)`, sheet.name);
  }

  for (const sheet of workbook.sheets) {
    const cells = sheet.cells ?? {};
    const count = Object.keys(cells).length;
    if (count > MAX_CELLS_PER_SHEET) {
      issues.push({ sheet: sheet.name, code: 'too-many-cells', message: `sheet ${sheet.name} has ${count} cells (max ${MAX_CELLS_PER_SHEET})`, severity: 'warning' });
    }
    for (const [refText, cell] of Object.entries(cells)) {
      const ref = parseCellRef(refText);
      if (!ref) {
        err('invalid-cell-ref', `cell key "${refText}" is not an A1 reference`, sheet.name, refText);
        continue;
      }
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
        err('invalid-cell', `cell ${refText} must be an object {v} or {f}`, sheet.name, refText);
        continue;
      }
      const hasValue = cell.v !== undefined;
      const hasFormula = typeof cell.f === 'string' && cell.f.length > 0;
      if (hasValue && hasFormula) {
        err('cell-value-and-formula', `cell ${refText} carries both a value and a formula — one cell holds a value OR a live formula, never both`, sheet.name, refText);
      }
      if (!hasValue && !hasFormula) {
        err('empty-cell', `cell ${refText} is empty (no value, no formula) — remove it from the sparse map`, sheet.name, refText);
      }
      if (hasFormula && !(cell.f as string).startsWith('=')) {
        err('formula-missing-equals', `cell ${refText} formula must start with '='`, sheet.name, refText);
      }
      if (cell.fmt !== undefined && typeof cell.fmt !== 'string') {
        err('invalid-cell-fmt', `cell ${refText} fmt must be a string`, sheet.name, refText);
      }
    }
    for (const merge of sheet.merges ?? []) {
      if (!parseRange(merge)) err('invalid-merge', `merge range "${merge}" is not a valid A1 range`, sheet.name);
    }
    for (const chart of sheet.charts ?? []) {
      if (typeof chart.id !== 'string' || typeof chart.type !== 'string' || typeof chart.range !== 'string' || typeof chart.anchor !== 'string') {
        err('invalid-chart-spec', `chart spec on ${sheet.name} needs {id, type, range, anchor}`, sheet.name);
      }
    }
    for (const pivot of sheet.pivots ?? []) {
      if (typeof pivot.id !== 'string' || typeof pivot.source !== 'string' || typeof pivot.target !== 'string') {
        err('invalid-pivot-spec', `pivot spec on ${sheet.name} needs {id, source, target}`, sheet.name);
      }
    }
  }

  for (const [name, ref] of Object.entries(workbook.namedRanges ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) err('invalid-named-range', `named range "${name}" is not a valid Excel name`);
    if (typeof ref !== 'string' || ref.length === 0) err('invalid-named-range', `named range "${name}" needs a reference string`);
  }
  return issues;
}

/* ------------------------------------------------------- perception */

export type SheetSummary = {
  name: string;
  rows: number;
  cols: number;
  headers: string[];
  formulaCells: number;
  valueCells: number;
};

export type WorkbookSummary = {
  title: string;
  stage: WorkbookSpec['stage'];
  sheets: SheetSummary[];
  namedRanges: string[];
  hasBlueprint: boolean;
  verifyOk: boolean | null;
};

/**
 * The engine's perception surface: dimensions, detected headers, and
 * formula/value counts per sheet — never a full grid dump (the research
 * is unambiguous that full-grid context collapses past ~32k tokens).
 */
export function summarizeWorkbook(workbook: WorkbookSpec): WorkbookSummary {
  const sheets: SheetSummary[] = workbook.sheets.map((sheet) => {
    const bounds = sheetBounds(sheet);
    const headers = [...sheetHeaders(sheet).entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    let formulaCells = 0;
    let valueCells = 0;
    for (const cell of Object.values(sheet.cells)) {
      if (typeof cell.f === 'string' && cell.f) formulaCells += 1;
      else if (cell.v !== undefined) valueCells += 1;
    }
    return {
      name: sheet.name,
      rows: bounds ? bounds.maxRow + 1 : 0,
      cols: bounds ? bounds.maxCol + 1 : 0,
      headers,
      formulaCells,
      valueCells,
    };
  });
  return {
    title: workbook.title,
    stage: workbook.stage,
    sheets,
    namedRanges: Object.keys(workbook.namedRanges ?? {}),
    hasBlueprint: workbook.blueprint !== undefined,
    verifyOk: workbook.verify ? workbook.verify.ok : null,
  };
}

/** A windowed, addressed read of one sheet — the only grid read the engine performs. */
export function readRangeValues(
  workbook: WorkbookSpec,
  sheetName: string,
  rangeText: string,
): { ok: true; sheet: string; rows: Array<Array<{ ref: string; v?: unknown; f?: string }>> } | { ok: false; issues: string[] } {
  const sheet = workbook.sheets.find((s) => s.name === sheetName);
  if (!sheet) return { ok: false, issues: [`sheet "${sheetName}" does not exist (sheets: ${workbook.sheets.map((s) => s.name).join(', ') || 'none'})`] };
  const range = parseRange(rangeText);
  if (!range) return { ok: false, issues: [`range "${rangeText}" is not a valid A1 range`] };
  const rows: Array<Array<{ ref: string; v?: unknown; f?: string }>> = [];
  for (let r = range.start.row; r <= range.end.row; r += 1) {
    const row: Array<{ ref: string; v?: unknown; f?: string }> = [];
    for (let c = range.start.col; c <= range.end.col; c += 1) {
      const ref = formatCellRef(c, r);
      const cell = sheet.cells[ref];
      row.push(cell ? { ref, ...(cell.v !== undefined ? { v: cell.v } : {}), ...(cell.f ? { f: cell.f } : {}) } : { ref });
    }
    rows.push(row);
  }
  return { ok: true, sheet: sheet.name, rows };
}
