import {
  formatCellRef,
  indexToCol,
  parseCellRef,
  tileRefs,
  type BlueprintDashboard,
  type DashboardTileSpec,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';
import { newSheet } from './store.ts';

/**
 * Native Excel dashboard composition (the video-proven pattern:
 * pivots → KPI cards → charts → slicers, no macro — pivots refresh on
 * load instead of a RefreshAll macro). The dashboard is ONE sheet of
 * kind 'dashboard' inside workbook.json: KPI tiles are materialized
 * into ordinary cells (a label strip + a live-formula value, merged
 * across the card footprint) so the evaluator verifies them, the
 * canvas renders them, and exceljs exports them with real styling.
 * Charts, pivots and slicers stay specifications on the sheet; the Go
 * sidecar anchors them natively at export time. Nothing here ever
 * writes a computed number into a tile — the value cell is a formula.
 */

export const DEFAULT_TILE_COLS = 3;
export const DEFAULT_TILE_ROWS = 3;
export const DEFAULT_TILE_ACCENT = '#6B50FF';
export const TILE_VALUE_FILL = '#FFFFFF';

export function tileSlug(label: string, taken: Set<string>): string {
  const base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'kpi';
  let slug = `tile-${base}`;
  let n = 2;
  while (taken.has(slug)) {
    slug = `tile-${base}-${n}`;
    n += 1;
  }
  return slug;
}

/**
 * Deterministic sequential layout for tiles that arrive without an
 * anchor: cards flow left-to-right from B2, wrapping after column N.
 * Tiles that already carry an anchor keep it.
 */
export function layoutTileAnchors(tiles: DashboardTileSpec[]): DashboardTileSpec[] {
  const placed: Array<{ col: number; row: number; cols: number; rows: number }> = [];
  const overlaps = (col: number, row: number, cols: number, rows: number): boolean =>
    placed.some((p) => col < p.col + p.cols && p.col < col + cols && row < p.row + p.rows && p.row < row + rows);
  let cursorCol = 1; // column B
  let cursorRow = 1; // row 2
  return tiles.map((tile) => {
    const cols = Math.max(1, tile.cols ?? DEFAULT_TILE_COLS);
    const rows = Math.max(2, tile.rows ?? DEFAULT_TILE_ROWS);
    const existing = parseCellRef(tile.anchor);
    if (existing) {
      placed.push({ col: existing.col, row: existing.row, cols, rows });
      return tile;
    }
    for (;;) {
      if (cursorCol + cols - 1 > 15) { // wrap after column P
        cursorCol = 1;
        cursorRow += DEFAULT_TILE_ROWS + 1;
      }
      if (!overlaps(cursorCol, cursorRow, cols, rows)) break;
      cursorCol += cols + 1;
    }
    const anchor = formatCellRef(cursorCol, cursorRow);
    placed.push({ col: cursorCol, row: cursorRow, cols, rows });
    cursorCol += cols + 1;
    return { ...tile, anchor };
  });
}

/** Write a tile's cells + merges onto the sheet (idempotent). */
export function materializeTile(sheet: SheetSpec, tile: DashboardTileSpec): string | null {
  const refs = tileRefs(tile);
  if (!refs) return `tile "${tile.id}" anchor "${tile.anchor}" is not a cell reference`;
  sheet.cells[refs.labelRef] = {
    v: tile.label,
    bold: true,
    fill: tile.accent ?? DEFAULT_TILE_ACCENT,
    color: '#FFFFFF',
  };
  sheet.cells[refs.valueRef] = {
    f: tile.formula,
    bold: true,
    size: 16,
    fill: TILE_VALUE_FILL,
    ...(tile.fmt ? { fmt: tile.fmt } : {}),
  };
  sheet.merges = [...(sheet.merges ?? []).filter((m) => m !== refs.mergeLabel && m !== refs.mergeValue), refs.mergeLabel, refs.mergeValue];
  const anchor = parseCellRef(tile.anchor) as { col: number; row: number };
  // The value row (1-based anchor row + 1) gets room for the big font.
  sheet.rowHeights = { ...(sheet.rowHeights ?? {}), [String(anchor.row + 2)]: 30 };
  // Column widths: give card columns room to read (only widen).
  const cols = Math.max(1, tile.cols ?? DEFAULT_TILE_COLS);
  sheet.colWidths = { ...(sheet.colWidths ?? {}) };
  for (let c = 0; c < cols; c += 1) {
    const letter = indexToCol(anchor.col + c);
    if ((sheet.colWidths[letter] ?? 0) < 16) sheet.colWidths[letter] = 16;
  }
  return null;
}

/** Remove a tile's cells + merges (other tiles' footprints survive). */
export function clearTile(sheet: SheetSpec, tile: DashboardTileSpec): void {
  const refs = tileRefs(tile);
  if (!refs) return;
  delete sheet.cells[refs.labelRef];
  delete sheet.cells[refs.valueRef];
  sheet.merges = (sheet.merges ?? []).filter((m) => m !== refs.mergeLabel && m !== refs.mergeValue);
}

/**
 * Compose (or recompose) the dashboard sheet from a blueprint's
 * Dashboard section. Helper sheets named by the pivots are created
 * hidden — pivot output lives there; the dashboard shows cards,
 * charts and slicers. Returns human notes for the build log.
 */
export function composeDashboard(wb: WorkbookSpec, dashboard: BlueprintDashboard): string[] {
  const notes: string[] = [];
  const name = (dashboard.sheet ?? 'Dashboard').trim() || 'Dashboard';
  let sheet = wb.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!sheet) {
    sheet = newSheet(name);
    wb.sheets.push(sheet);
  }
  sheet.kind = 'dashboard';
  sheet.hidden = false;
  sheet.tabColor = sheet.tabColor ?? '#6B50FF';

  const laid = layoutTileAnchors(dashboard.tiles);
  // Recompose from scratch: clear prior tile cells so moved cards
  // never leave ghosts behind, then materialize the current specs.
  for (const old of sheet.tiles ?? []) clearTile(sheet, old);
  sheet.tiles = [];
  for (const tile of laid) {
    const issue = materializeTile(sheet, tile);
    if (issue) {
      notes.push(`dashboard: ${issue} — dilewati`);
      continue;
    }
    sheet.tiles.push(tile);
  }
  notes.push(`Dashboard "${name}": ${sheet.tiles.length} kartu KPI dikomposisi (formula hidup)`);

  if (dashboard.charts?.length) {
    sheet.charts = dashboard.charts.map((c) => ({ ...c, sheet: c.sheet ?? name }));
    notes.push(`Dashboard: ${sheet.charts.length} chart native dijangkar saat ekspor`);
  }
  if (dashboard.pivots?.length) {
    sheet.pivots = dashboard.pivots.map((p) => ({ ...p, name: p.name ?? p.id }));
    const targets = new Set(dashboard.pivots.map((p) => p.target));
    for (const target of targets) {
      if (!wb.sheets.some((s) => s.name === target)) {
        const helper = newSheet(target);
        helper.hidden = true;
        wb.sheets.push(helper);
      }
    }
    notes.push(`Dashboard: ${dashboard.pivots.length} pivot native di sheet tersembunyi (${[...targets].join(', ')})`);
  }
  if (dashboard.slicers?.length) {
    sheet.slicers = dashboard.slicers.map((s) => ({ ...s, sheet: s.sheet ?? name }));
    notes.push(`Dashboard: ${sheet.slicers.length} slicer dijangkar saat ekspor`);
  }
  if (!sheet.printArea) sheet.printArea = 'A1:P45';
  return notes;
}
