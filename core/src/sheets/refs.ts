import type { DashboardTileSpec } from './workbook.ts';
/** A1 cell addressing — pure, browser-safe (the Web grid parses/formats refs with these). */

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


/** First-row header labels by column index. */
export function sheetHeaders(sheet: { cells: Record<string, { v?: unknown }> }): Map<number, string> {
  const headers = new Map<number, string>();
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const ref = parseCellRef(key);
    if (!ref || ref.row !== 0) continue;
    if (typeof cell.v === 'string' && cell.v.trim()) headers.set(ref.col, cell.v.trim());
  }
  return headers;
}

export const DEFAULT_TILE_COLS = 3;
export const DEFAULT_TILE_ROWS = 3;

/** Cells a dashboard tile owns: label strip on the anchor row, value below. */
export function tileRefs(tile: DashboardTileSpec): { labelRef: string; valueRef: string; mergeLabel: string; mergeValue: string } | null {
  const anchor = parseCellRef(tile.anchor);
  if (!anchor) return null;
  const cols = Math.max(1, tile.cols ?? DEFAULT_TILE_COLS);
  const rows = Math.max(2, tile.rows ?? DEFAULT_TILE_ROWS);
  const start = formatCellRef(anchor.col, anchor.row);
  const labelEnd = formatCellRef(anchor.col + cols - 1, anchor.row);
  const valueStart = formatCellRef(anchor.col, anchor.row + 1);
  const valueEnd = formatCellRef(anchor.col + cols - 1, anchor.row + rows - 1);
  return {
    labelRef: start,
    valueRef: valueStart,
    mergeLabel: cols > 1 ? `${start}:${labelEnd}` : start,
    mergeValue: rows > 2 || cols > 1 ? `${valueStart}:${valueEnd}` : valueStart,
  };
}

/** Structural issues for one dashboard tile spec (empty = valid). */
export function tileIssues(tile: DashboardTileSpec, opts: { anchorRequired?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (!tile.id || typeof tile.id !== 'string') issues.push('tile needs an id');
  if (!tile.label || !tile.label.trim()) issues.push(`tile "${tile.id}" needs a label`);
  if (typeof tile.formula !== 'string' || !tile.formula.startsWith('=')) {
    issues.push(`tile "${tile.id}" formula must be a live formula starting with = (got ${JSON.stringify(tile.formula)})`);
  }
  // Blueprint tiles may omit the anchor (the build lays them out
  // sequentially); materialized workbook.json specs always carry one.
  if ((opts.anchorRequired !== false || tile.anchor) && !parseCellRef(tile.anchor)) issues.push(`tile "${tile.id}" anchor "${tile.anchor}" is not a cell reference`);
  if (tile.cols !== undefined && (!Number.isInteger(tile.cols) || tile.cols < 1 || tile.cols > 26)) issues.push(`tile "${tile.id}" cols must be 1..26`);
  if (tile.rows !== undefined && (!Number.isInteger(tile.rows) || tile.rows < 2 || tile.rows > 50)) issues.push(`tile "${tile.id}" rows must be 2..50`);
  if (tile.fmt !== undefined && typeof tile.fmt !== 'string') issues.push(`tile "${tile.id}" fmt must be a string`);
  if (tile.accent !== undefined && (typeof tile.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(tile.accent))) issues.push(`tile "${tile.id}" accent must be #rrggbb`);
  return issues;
}
