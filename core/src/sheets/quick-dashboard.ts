import { profileSheet } from './analysis-profile.ts';
import { mainNumericColumn, pickDatasetSheet, toNumber } from './qa.ts';
import { composeDashboard, tileSlug } from './dashboard.ts';
import { validateWorkbook } from './store.ts';
import {
  formatCellRef,
  indexToCol,
  type BlueprintDashboard,
  type DashboardTileSpec,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';

/**
 * Dashboard 1 perintah — the "📊 Buat Dashboard" surface of Dae
 * Captain v2 Fase D. Zero LLM, fully deterministic: column roles
 * come from the dataset profiler (qa.ts), the KPI cards are LIVE
 * formulas over the data sheet (never frozen numbers), and the
 * per-category summary table uses COUNTIF/SUMIF/AVERAGEIF so the
 * mandatory Verify gate can evaluate every number it shows.
 *
 * Layout (deterministic): 4 KPI tiles flow from B2 (the dashboard
 * module's own layout), the summary table lands at A7, and the
 * chart spec anchors below the table.
 */

export type QuickDashboardKpi = {
  label: string;
  formula: string;
  column: string;
};

export type QuickDashboardResult =
  | {
    ok: true;
    /** Workbook clone with the composed Dashboard sheet. */
    workbook: WorkbookSpec;
    dashboardSheet: string;
    measureColumn: string;
    groupColumn: string | null;
    kpis: QuickDashboardKpi[];
    categories: string[];
    summary: string;
    notes: string[];
  }
  | { ok: false; reason: string };

const TILE_ACCENTS = ['#6B50FF', '#0EA5E9', '#16A34A', '#F59E0B'];
const SUMMARY_START_ROW = 7; // 1-based
const MAX_CATEGORIES = 10;

/** Quote a sheet name for formula use when it needs it. */
function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export function buildQuickDashboard(input: WorkbookSpec): QuickDashboardResult {
  const sheet = pickDatasetSheet(input);
  if (!sheet) {
    return { ok: false, reason: 'Tidak ada sheet dataset di workbook ini — dashboard tidak bisa dibuat dari dataset ini.' };
  }
  const wb: WorkbookSpec = JSON.parse(JSON.stringify(input)) as WorkbookSpec;
  const data = wb.sheets.find((s) => s.name === sheet.name) as SheetSpec;
  const profile = profileSheet(data);
  const measure = mainNumericColumn(profile);
  if (!measure) {
    return { ok: false, reason: `Sheet "${data.name}" tidak punya kolom numerik — dashboard butuh setidaknya satu kolom angka.` };
  }
  if (profile.rowCount === 0) {
    return { ok: false, reason: `Sheet "${data.name}" tidak punya baris data — dashboard tidak bisa dibuat.` };
  }

  const group = profile.columns.find((c) => profile.groupCandidates.includes(c.name))
    ?? profile.columns.find((c) => c.type === 'text')
    ?? null;

  const measureColLetter = indexToCol(measure.index);
  const lastDataRow1 = profile.rowCount + 1; // 1-based, header = row 1
  const sheetRef = quoteSheetName(data.name);
  const range = `${sheetRef}!${measureColLetter}$2:${measureColLetter}$${lastDataRow1}`;

  const isCurrency = measure.type === 'currency';
  const intFmt = isCurrency ? '"Rp" #,##0' : '#,##0';
  const decFmt = isCurrency ? '"Rp" #,##0.##' : '#,##0.##';

  const kpis: QuickDashboardKpi[] = [
    { label: `Total ${measure.name}`, formula: `=SUM(${range})`, column: measure.name },
    { label: `Rata-rata ${measure.name}`, formula: `=AVERAGE(${range})`, column: measure.name },
    { label: `Tertinggi ${measure.name}`, formula: `=MAX(${range})`, column: measure.name },
    { label: `Terendah ${measure.name}`, formula: `=MIN(${range})`, column: measure.name },
  ];
  const fmts = [intFmt, decFmt, intFmt, intFmt];
  const taken = new Set<string>();
  const tiles: DashboardTileSpec[] = kpis.map((kpi, i) => {
    const tile: DashboardTileSpec = {
      id: tileSlug(kpi.label, taken),
      label: kpi.label,
      formula: kpi.formula,
      fmt: fmts[i],
      // No anchor: layoutTileAnchors flows the tiles from B2.
      anchor: '',
      cols: 3,
      rows: 3,
      accent: TILE_ACCENTS[i % TILE_ACCENTS.length],
    };
    taken.add(tile.id);
    return tile;
  });

  // Per-category summary: top N groups by total, computed in code
  // (deterministic); the displayed numbers stay live formulas.
  let categories: string[] = [];
  let groupColLetter = '';
  if (group) {
    groupColLetter = indexToCol(group.index);
    const totals = new Map<string, number>();
    for (let r = 1; r <= profile.rowCount; r += 1) {
      const label = data.cells[formatCellRef(group.index, r)]?.v;
      if (label === undefined || label === '') continue;
      const n = toNumber(data.cells[formatCellRef(measure.index, r)]?.v);
      if (n === null) continue;
      const key = String(label);
      totals.set(key, (totals.get(key) ?? 0) + n);
    }
    categories = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CATEGORIES)
      .map(([label]) => label);
  }

  const groupRange = group ? `${sheetRef}!${groupColLetter}$2:${groupColLetter}$${lastDataRow1}` : '';
  const tableRows = 1 + categories.length; // header + categories
  const chartAnchorRow = SUMMARY_START_ROW + tableRows + 2;
  const blueprint: BlueprintDashboard = {
    sheet: 'Dashboard',
    tiles,
    charts: categories.length > 0 ? [{
      id: 'chart-quick-1',
      type: 'column',
      range: `Dashboard!A${SUMMARY_START_ROW}:D${SUMMARY_START_ROW + tableRows - 1}`,
      anchor: `A${chartAnchorRow}`,
      sheet: 'Dashboard',
      title: `Total ${measure.name} per ${group?.name ?? 'kategori'}`,
    }] : [],
  };

  const notes = composeDashboard(wb, blueprint);
  const dash = wb.sheets.find((s) => s.name === 'Dashboard') as SheetSpec;

  // Materialize the summary table under the tiles (A7): category
  // names are literal inputs; every number is a live formula.
  if (group && categories.length > 0) {
    const headerRow = SUMMARY_START_ROW - 1; // 0-based
    const headers = [group.name, 'Jumlah', `Total ${measure.name}`, `Rata-rata ${measure.name}`];
    headers.forEach((h, c) => {
      dash.cells[formatCellRef(c, headerRow)] = { v: h, bold: true, fill: '#6B50FF', color: '#FFFFFF' };
    });
    categories.forEach((label, i) => {
      const r0 = headerRow + 1 + i; // 0-based data row
      const row1 = r0 + 1; // 1-based for formulas
      const critRef = `$A$${row1}`;
      dash.cells[formatCellRef(0, r0)] = { v: label };
      dash.cells[formatCellRef(1, r0)] = { f: `=COUNTIF(${groupRange},${critRef})`, fmt: '#,##0' };
      dash.cells[formatCellRef(2, r0)] = { f: `=SUMIF(${groupRange},${critRef},${range})`, fmt: intFmt };
      dash.cells[formatCellRef(3, r0)] = { f: `=AVERAGEIF(${groupRange},${critRef},${range})`, fmt: decFmt };
    });
    dash.colWidths = { ...(dash.colWidths ?? {}), A: 24, B: 12, C: 18, D: 18 };
  }

  const structural = validateWorkbook(wb).filter((i) => i.severity === 'error');
  if (structural.length > 0) {
    return { ok: false, reason: `Dashboard gagal divalidasi: ${structural.map((i) => i.message).join('; ')}` };
  }

  const parts = [
    `Dashboard dibuat dari sheet "${data.name}" (${profile.rowCount.toLocaleString('id-ID')} baris)`,
    `4 kartu KPI atas kolom "${measure.name}" (formula hidup)`,
    categories.length > 0
      ? `tabel ringkasan ${categories.length} kategori "${group?.name}" + chart kolom`
      : 'tanpa tabel kategori (tidak ada kolom teks)',
  ];
  return {
    ok: true,
    workbook: wb,
    dashboardSheet: 'Dashboard',
    measureColumn: measure.name,
    groupColumn: group?.name ?? null,
    kpis,
    categories,
    summary: `${parts.join('; ')}.`,
    notes,
  };
}
