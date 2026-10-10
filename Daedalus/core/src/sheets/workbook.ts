import { join } from 'node:path';

/**
 * Agentic Spreadsheet source of truth: `workbook/workbook.json` (analog
 * of deck/deck.json in the Slide domain). One cell stores a literal
 * value OR a formula, never the engine's own computed result — derived
 * cells are always live formulas (`=SUMIFS(...)`), so the exported
 * workbook recomputes in Excel instead of freezing the model's math.
 * Charts and pivots live here as *specifications*; materializing them
 * into native OOXML parts is the Go sidecar's job at export time, so a
 * missing sidecar degrades the export honestly, never the model.
 */

export type CellScalar = string | number | boolean;

export type SheetCell = {
  /** Literal value (input). Mutually exclusive with `f`. */
  v?: CellScalar;
  /** Formula, leading '=' included. Mutually exclusive with `v`. */
  f?: string;
  /** Number format (Excel numFmt string, e.g. '#,##0' or '0.0%'). */
  fmt?: string;
  /** Lightweight cell style the exporter honors. */
  bold?: boolean;
  /** Fill color as #rrggbb. */
  fill?: string;
  /** Font color as #rrggbb. */
  color?: string;
};

export type ChartSpec = {
  id: string;
  /** 'column' | 'bar' | 'line' | 'pie' (the spike-proven subset). */
  type: string;
  /** Data range incl. header row, e.g. 'Data!A1:B13'. */
  range: string;
  /** Anchor cell on `sheet`, e.g. 'D2'. */
  anchor: string;
  /** Sheet the chart is drawn on (defaults to the range's sheet). */
  sheet?: string;
  title?: string;
};

export type PivotValueSpec = { field: string; agg: 'sum' | 'count' | 'average' | 'min' | 'max' };

export type PivotSpec = {
  id: string;
  /** Source range incl. headers, e.g. 'Raw!A1:F500'. */
  source: string;
  /** Sheet the pivot table lands on. */
  target: string;
  /** Anchor cell on `target`, e.g. 'A1'. */
  anchor?: string;
  rows: string[];
  cols?: string[];
  values: PivotValueSpec[];
};

export type ConditionalFormatSpec = {
  range: string;
  /** 'cellIs' with operator/value, kept as data for the exporter. */
  operator: string;
  value: string;
  fill?: string;
  color?: string;
};

export type DataValidationSpec = {
  range: string;
  type: 'list';
  /** Excel list formula, e.g. '"Ya,Tidak"'. */
  formula1: string;
};

export type SheetSpec = {
  id: string;
  name: string;
  tabColor?: string;
  /** Frozen panes: rows/cols frozen from the top-left (0 = none). */
  frozen?: { row: number; col: number };
  /** Column widths keyed by column letter. */
  colWidths?: Record<string, number>;
  /** Sparse cell map keyed by A1 ref ('B2'). */
  cells: Record<string, SheetCell>;
  merges?: string[];
  conditionalFormats?: ConditionalFormatSpec[];
  dataValidations?: DataValidationSpec[];
  charts?: ChartSpec[];
  pivots?: PivotSpec[];
};

export type ColumnType = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'boolean';

export type BlueprintColumn = {
  name: string;
  type: ColumnType;
  /** Where the column's data comes from. */
  source: 'input' | 'formula' | 'assumption';
  /**
   * Formula template for `formula` columns; `{r}` is the row placeholder
   * the build substitutes per data row (e.g. '=B{r}*Asumsi!$B$2').
   */
  formula?: string;
};

export type BlueprintSheet = {
  name: string;
  purpose?: string;
  columns: BlueprintColumn[];
  /** Summary plan for this sheet (formula summary / native pivot / chart). */
  summary?: string;
  /** Native chart specs the export stage materializes (sidecar) — optional. */
  charts?: ChartSpec[];
  /** Native pivot specs the export stage materializes (sidecar) — optional. */
  pivots?: PivotSpec[];
};

export type BlueprintAssumption = { name: string; value: CellScalar; note?: string };

export type SheetBlueprint = {
  goal: string;
  /** Data sources the build consumed (workspace-relative paths). */
  sources: string[];
  assumptions: BlueprintAssumption[];
  sheets: BlueprintSheet[];
  notes?: string;
};

export type VerifyCellIssue = {
  sheet: string;
  cell: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

export type VerifyReport = {
  /** ISO timestamp of the run. */
  at: string;
  /**
   * Which verification path actually ran: 'core' = in-core evaluator
   * only (LibreOffice absent), 'core+libreoffice' = evaluator plus a
   * headless recalc of the exported file, 'partial' = core evaluator
   * with an incomplete formula subset (reported honestly, never quiet).
   */
  path: 'core' | 'core+libreoffice' | 'partial';
  ok: boolean;
  /** Number of formula cells evaluated by the in-core evaluator. */
  formulasChecked: number;
  /** Formula cells whose function the evaluator does not know. */
  unsupported: number;
  errors: VerifyCellIssue[];
  warnings: VerifyCellIssue[];
  /** One-line human summary of the gate verdict. */
  summary: string;
};

export type SheetExportRecord = {
  at: string;
  path: string;
  format: 'xlsx' | 'csv';
  bytes: number;
  /** 'exceljs' = plain export; 'exceljs+sidecar' = native parts injected. */
  via: 'exceljs' | 'exceljs+sidecar';
  /** Honest note when natives were skipped or the sidecar was absent. */
  note?: string;
};

export type WorkbookStage = 'blueprint' | 'ready';

export type WorkbookSpec = {
  version: 1;
  id: string;
  title: string;
  /** 'blueprint' = structure staged, awaiting the Buat button; 'ready' = built. */
  stage: WorkbookStage;
  sheets: SheetSpec[];
  namedRanges?: Record<string, string>;
  blueprint?: SheetBlueprint;
  verify?: VerifyReport;
  exports?: SheetExportRecord[];
  meta: { createdBy: string; model?: string; createdAt?: string };
};

export type WorkbookIssue = {
  sheet?: string;
  cell?: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

export const WORKBOOK_DIRNAME = 'workbook';
export const WORKBOOK_FILENAME = 'workbook.json';
export const MAX_SHEETS = 20;
export const MAX_CELLS_PER_SHEET = 200_000;

export function workbookPaths(root: string): { dir: string; file: string } {
  const dir = join(root, WORKBOOK_DIRNAME);
  return { dir, file: join(dir, WORKBOOK_FILENAME) };
}

/** Relative (workspace) paths, for messages/tools. */
export function workbookRelativePaths(): { dir: string; file: string } {
  return { dir: WORKBOOK_DIRNAME, file: `${WORKBOOK_DIRNAME}/${WORKBOOK_FILENAME}` };
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'workbook';
}

/* ------------------------------------------------- cell addressing */

const CELL_REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export type CellRef = { col: number; row: number; colAbs: boolean; rowAbs: boolean };

/** Parse an A1 ref ('B2', '$B$2'); rows are 1-based in text, 0-based here. */
export function parseCellRef(text: string): CellRef | null {
  const match = CELL_REF_RE.exec(text.trim());
  if (!match) return null;
  return {
    col: colToIndex(match[2] as string),
    row: Number(match[4]) - 1,
    colAbs: match[1] === '$',
    rowAbs: match[3] === '$',
  };
}

export function formatCellRef(col: number, row: number, colAbs = false, rowAbs = false): string {
  return `${colAbs ? '$' : ''}${indexToCol(col)}${rowAbs ? '$' : ''}${row + 1}`;
}

export type RangeRef = { start: CellRef; end: CellRef };

/** Parse 'A1' or 'A1:B9'. */
export function parseRange(text: string): RangeRef | null {
  const parts = text.trim().split(':');
  if (parts.length === 1) {
    const single = parseCellRef(parts[0] as string);
    return single ? { start: single, end: single } : null;
  }
  if (parts.length !== 2) return null;
  const start = parseCellRef(parts[0] as string);
  const end = parseCellRef(parts[1] as string);
  if (!start || !end) return null;
  return { start, end };
}

/** Used-range bounds of a sheet's sparse cell map (null when empty). */
export function sheetBounds(sheet: SheetSpec): { minCol: number; minRow: number; maxCol: number; maxRow: number } | null {
  let bounds: { minCol: number; minRow: number; maxCol: number; maxRow: number } | null = null;
  for (const key of Object.keys(sheet.cells)) {
    const ref = parseCellRef(key);
    if (!ref) continue;
    if (!bounds) bounds = { minCol: ref.col, minRow: ref.row, maxCol: ref.col, maxRow: ref.row };
    else {
      bounds.minCol = Math.min(bounds.minCol, ref.col);
      bounds.minRow = Math.min(bounds.minRow, ref.row);
      bounds.maxCol = Math.max(bounds.maxCol, ref.col);
      bounds.maxRow = Math.max(bounds.maxRow, ref.row);
    }
  }
  return bounds;
}

/** Header row values (row 1) as trimmed strings, keyed by column index. */
export function sheetHeaders(sheet: SheetSpec): Map<number, string> {
  const headers = new Map<number, string>();
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const ref = parseCellRef(key);
    if (!ref || ref.row !== 0) continue;
    if (typeof cell.v === 'string' && cell.v.trim()) headers.set(ref.col, cell.v.trim());
  }
  return headers;
}
