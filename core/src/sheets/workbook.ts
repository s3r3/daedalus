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
  /** Font size in points (exporter honors it; KPI values use it). */
  size?: number;
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
  /** Native size in PIXELS (the sidecar passes them to Excelize's
   *  Chart.Dimension; one default chart ≈ 480x290). */
  width?: number;
  height?: number;
};

/**
 * One KPI card on a dashboard sheet. The card is materialized into
 * ordinary cells (label strip + live-formula value) so the evaluator,
 * the canvas and the exporter all work off the same truth; this spec
 * is the editable descriptor the ops and the panel edit.
 */
export type DashboardTileSpec = {
  id: string;
  label: string;
  /** Live formula for the KPI value (leading '='). Never a frozen number. */
  formula: string;
  /** Number format for the value cell, e.g. '#,##0' or '"Rp" #,##0'. */
  fmt?: string;
  /** Top-left cell of the card, e.g. 'B2'. */
  anchor: string;
  /** Card footprint in cells (cols includes the full merge span). */
  cols?: number;
  rows?: number;
  /** Accent fill (#rrggbb) for the label strip. */
  accent?: string;
};

/**
 * A slicer floating on a sheet (usually the dashboard). Bound either to
 * a pivot spec (`pivot` = PivotSpec.id) or, without one, to a table the
 * sidecar creates over `source`. `kind: 'timeline'` asks for a date
 * timeline slicer; Excelize 2.9 can only read timelines, so the
 * sidecar substitutes a regular date-field slicer and says so.
 */
export type SlicerSpec = {
  id: string;
  /** Field (header name in `source`) the slicer filters. */
  field: string;
  /** Source range incl. headers, e.g. 'Data!A1:F100'. */
  source: string;
  /** Sheet the slicer floats on (defaults to the owning sheet). */
  sheet?: string;
  /** Anchor cell on that sheet. */
  anchor: string;
  /** PivotSpec.id to bind to instead of a source table. */
  pivot?: string;
  kind?: 'field' | 'timeline';
};

export type PivotValueSpec = { field: string; agg: 'sum' | 'count' | 'average' | 'min' | 'max' };

export type PivotSpec = {
  id: string;
  /** Native pivot table name (a slicer binds by this name). */
  name?: string;
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
  /** 'dashboard' = composed KPI sheet (tiles/charts/slicers); default data. */
  kind?: 'dashboard';
  /** Hidden sheet (pivot helper sheets live here; exporter honors it). */
  hidden?: boolean;
  /** Frozen panes: rows/cols frozen from the top-left (0 = none). */
  frozen?: { row: number; col: number };
  /** Column widths keyed by column letter. */
  colWidths?: Record<string, number>;
  /** Row heights keyed by 1-based row number. */
  rowHeights?: Record<string, number>;
  /** Print area (A1 range) the exporter sets, e.g. 'A1:N40'. */
  printArea?: string;
  /** Sparse cell map keyed by A1 ref ('B2'). */
  cells: Record<string, SheetCell>;
  merges?: string[];
  conditionalFormats?: ConditionalFormatSpec[];
  dataValidations?: DataValidationSpec[];
  charts?: ChartSpec[];
  pivots?: PivotSpec[];
  /** KPI cards (dashboard sheets; materialized into cells + merges). */
  tiles?: DashboardTileSpec[];
  /** Slicers floating on this sheet (materialized by the sidecar). */
  slicers?: SlicerSpec[];
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

/**
 * The optional Dashboard section of a blueprint (native Excel
 * dashboard, video-proven pattern: pivots → KPI cards → charts →
 * slicers, no macro — pivots carry refreshOnLoad). Tiles are live
 * formulas over the data sheets; charts/pivots/slicers are specs the
 * export stage materializes natively through the Go sidecar.
 */
export type BlueprintDashboard = {
  /** Dashboard sheet name (default 'Dashboard'). */
  sheet?: string;
  tiles: DashboardTileSpec[];
  charts?: ChartSpec[];
  /** Pivots backing the dashboard (usually onto a hidden helper sheet). */
  pivots?: PivotSpec[];
  slicers?: SlicerSpec[];
};

export type SheetBlueprint = {
  goal: string;
  /** Data sources the build consumed (workspace-relative paths). */
  sources: string[];
  assumptions: BlueprintAssumption[];
  sheets: BlueprintSheet[];
  dashboard?: BlueprintDashboard;
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
  /** Composed native-dashboard counts, when a dashboard sheet exists. */
  dashboard?: { sheet: string; tiles: number; charts: number; slicers: number };
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

// NOTE: workbookPaths() lives in ./store.ts with the rest of the
// filesystem surface — this module must stay free of node: imports:
// the web bundle imports it directly (tileRefs) and Rollup cannot
// externalize node:path into the browser build.

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

export { colToIndex, indexToCol, parseCellRef, formatCellRef, parseRange, sheetHeaders, type CellRef, type RangeRef } from './refs.ts';
import { parseCellRef } from './refs.ts';

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

export { DEFAULT_TILE_COLS, DEFAULT_TILE_ROWS, tileRefs, tileIssues } from './refs.ts';
