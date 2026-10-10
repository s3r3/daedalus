import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { evaluateWorkbook, displayValue } from './evaluator.ts';
import {
  formatCellRef,
  parseCellRef,
  slugifyTitle,
  workbookPaths,
  type ChartSpec,
  type PivotSpec,
  type SheetExportRecord,
  type SlicerSpec,
  type WorkbookSpec,
} from './workbook.ts';

/**
 * Export stage. exceljs writes values, live formulas, number formats,
 * merges, frozen panes, conditional formats, data validations and
 * named ranges, and sets fullCalcOnLoad so Excel/LibreOffice recompute
 * on open — the file is the artifact; workbook.json stays the truth.
 * Native charts/pivots/slicers are NOT exceljs's to write: when the
 * blueprint carries chart/pivot specs, the Go sidecar (Excelize) may
 * inject them into the exported file. Sidecar absent → the export
 * proceeds WITHOUT natives and the record says so, plus a formula
 * summary fallback so the numbers still exist in the file.
 */

function argb(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return undefined;
  return `FF${clean.toUpperCase()}`;
}

export async function buildExcelJsWorkbook(workbook: WorkbookSpec): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.title = workbook.title;
  wb.calcProperties.fullCalcOnLoad = true;
  // Cached formula results (from the in-core evaluator): viewers show
  // values immediately, and the Go sidecar reads real numbers when it
  // builds pivot caches. fullCalcOnLoad still forces Excel/LibreOffice
  // to recompute the live formulas on open — the cache is a snapshot,
  // never the source of truth.
  const evaluation = evaluateWorkbook(workbook);
  for (const sheet of workbook.sheets) {
    const ws = wb.addWorksheet(sheet.name);
    if (sheet.tabColor) {
      const color = argb(sheet.tabColor);
      if (color) ws.properties.tabColor = { argb: color };
    }
    if (sheet.hidden) ws.state = 'hidden';
    for (const [letter, width] of Object.entries(sheet.colWidths ?? {})) {
      ws.getColumn(letter).width = width;
    }
    for (const [row, height] of Object.entries(sheet.rowHeights ?? {})) {
      const n = Number(row);
      if (Number.isInteger(n) && n >= 1) ws.getRow(n).height = height;
    }
    if (sheet.printArea) ws.pageSetup = { ...ws.pageSetup, printArea: sheet.printArea };
    if (sheet.kind === 'dashboard') {
      // A dashboard is meant to be read (and printed) as one page:
      // landscape, fitted to a single sheet of paper.
      ws.pageSetup = { ...ws.pageSetup, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
    }
    for (const [refText, cell] of Object.entries(sheet.cells)) {
      const out = ws.getCell(refText);
      if (cell.f) {
        const cached = evaluation.results.get(sheet.name)?.get(refText);
        const formula = cell.f.replace(/^=/, '');
        out.value = cached && cached.kind === 'value' && cached.value !== null
          ? { formula, result: cached.value }
          : { formula };
      }
      else if (cell.v !== undefined) out.value = cell.v;
      if (cell.fmt) out.numFmt = cell.fmt;
      if (cell.bold || cell.fill || cell.color || cell.size) {
        out.font = {
          ...(cell.bold ? { bold: true } : {}),
          ...(cell.size ? { size: cell.size } : {}),
          ...(cell.color && argb(cell.color) ? { color: { argb: argb(cell.color) as string } } : {}),
        };
        const fill = argb(cell.fill);
        if (fill) out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
    }
    for (const merge of sheet.merges ?? []) ws.mergeCells(merge);
    if (sheet.frozen && (sheet.frozen.row > 0 || sheet.frozen.col > 0)) {
      ws.views = [{ state: 'frozen', xSplit: sheet.frozen.col, ySplit: sheet.frozen.row }];
    }
    (sheet.conditionalFormats ?? []).forEach((cf, cfIndex) => {
      const operator = ['equal', 'greaterThan', 'lessThan', 'between', 'notEqual', 'greaterThanOrEqual', 'lessThanOrEqual'].includes(cf.operator) ? cf.operator : 'greaterThan';
      ws.addConditionalFormatting({
        ref: cf.range,
        rules: [{
          type: 'cellIs',
          priority: cfIndex + 1,
          operator: operator as 'greaterThan',
          formulae: [cf.value],
          style: {
            ...(cf.fill && argb(cf.fill) ? { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(cf.fill) as string } } } : {}),
            ...(cf.color && argb(cf.color) ? { font: { color: { argb: argb(cf.color) as string } } } : {}),
          },
        }],
      });
    });
    const dataValidations = (ws as unknown as { dataValidations: { add: (address: string, validation: Record<string, unknown>) => void } }).dataValidations;
    for (const dv of sheet.dataValidations ?? []) {
      dataValidations.add(dv.range, { type: 'list', allowBlank: true, formulae: [dv.formula1], showErrorMessage: false });
    }
  }
  for (const [name, ref] of Object.entries(workbook.namedRanges ?? {})) {
    try {
      wb.definedNames.add(ref.replace(/'/g, ''), name);
    } catch { /* invalid name for exceljs: export continues without it */ }
  }
  // Open the file on the dashboard when one is composed — that is
  // the sheet the reader is meant to land on (Excel/LibreOffice honor
  // the workbook view's active tab).
  const dashIndex = workbook.sheets.findIndex((s) => s.kind === 'dashboard' && !s.hidden);
  if (dashIndex > 0) {
    try {
      const view = { x: 0, y: 0, width: 16000, height: 9000, firstSheet: 0, activeTab: dashIndex, visibility: 'visible' as const };
      wb.views = [view];
    } catch { /* view preferences are cosmetic: export continues */ }
  }
  return wb;
}

export async function exportWorkbookToXlsx(
  workbook: WorkbookSpec,
  root: string,
  opts: { sidecar?: boolean } = {},
): Promise<SheetExportRecord> {
  const paths = workbookPaths(root);
  await mkdir(paths.dir, { recursive: true });
  const outPath = join(paths.dir, `${slugifyTitle(workbook.title)}.xlsx`);
  const wb = await buildExcelJsWorkbook(workbook);
  await wb.xlsx.writeFile(outPath);
  let record: SheetExportRecord = {
    at: new Date().toISOString(),
    path: outPath,
    format: 'xlsx',
    bytes: (await stat(outPath)).size,
    via: 'exceljs',
  };
  const charts = workbook.sheets.flatMap((s) => (s.charts ?? []).map((c) => ({ ...c, sheet: c.sheet ?? s.name })));
  const pivots = workbook.sheets.flatMap((s) => s.pivots ?? []).map((p) => ({ ...p, name: p.name ?? p.id }));
  const slicers = workbook.sheets.flatMap((s) => (s.slicers ?? []).map((sl) => ({ ...sl, sheet: sl.sheet ?? s.name })));
  const dashboard = dashboardComposition(workbook, charts);
  if (dashboard) record = { ...record, dashboard };
  if ((charts.length > 0 || pivots.length > 0 || slicers.length > 0) && opts.sidecar !== false) {
    const sidecar = await runSheetSidecar(outPath, workbook, { charts, pivots, slicers });
    if (sidecar.applied) {
      record = { ...record, via: 'exceljs+sidecar', bytes: (await stat(outPath)).size, note: sidecar.note };
    } else {
      record = {
        ...record,
        note: `native ${charts.length ? 'chart' : ''}${charts.length && pivots.length ? '+' : ''}${pivots.length ? 'pivot' : ''} tidak disuntikkan (${sidecar.reason}); ekspor lanjut tanpa native + ringkasan formula sebagai fallback`,
      };
      await appendFormulaSummaryFallback(root, workbook, outPath);
      record = { ...record, bytes: (await stat(outPath)).size };
    }
  } else if (charts.length > 0 || pivots.length > 0) {
    record = { ...record, note: 'sidecar dinonaktifkan; ekspor tanpa chart/pivot native' };
  }
  return record;
}

/**
 * What the composed dashboard contributes to one export: KPI tiles,
 * charts anchored on the dashboard sheet(s), slicers floating there.
 * Named in the export record so the report states composition counts,
 * not just that a file exists.
 */
export function dashboardComposition(workbook: WorkbookSpec, charts?: Array<{ sheet?: string }>): SheetExportRecord['dashboard'] | undefined {
  const dashSheets = workbook.sheets.filter((s) => s.kind === 'dashboard');
  if (dashSheets.length === 0) return undefined;
  const names = new Set(dashSheets.map((s) => s.name));
  const allCharts = charts ?? workbook.sheets.flatMap((s) => (s.charts ?? []).map((c) => ({ ...c, sheet: c.sheet ?? s.name })));
  return {
    sheet: dashSheets.map((s) => s.name).join(', '),
    tiles: dashSheets.reduce((n, s) => n + (s.tiles ?? []).length, 0),
    charts: allCharts.filter((c) => c.sheet && names.has(c.sheet)).length,
    slicers: dashSheets.reduce((n, s) => n + (s.slicers ?? []).length, 0),
  };
}

/**
 * Fallback when natives can't be injected: a "Ringkasan" sheet whose
 * cells are LIVE formulas (SUMIFS over the pivot/chart sources), so the
 * exported file still computes the same numbers a pivot would show.
 */
export async function appendFormulaSummaryFallback(root: string, workbook: WorkbookSpec, xlsxPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const pivots = workbook.sheets.flatMap((s) => s.pivots ?? []);
  if (pivots.length === 0) return;
  const ws = wb.getWorksheet('Ringkasan') ?? wb.addWorksheet('Ringkasan');
  let row = 1;
  ws.getCell(`A${row}`).value = 'Ringkasan (fallback formula — pivot native tidak tersedia)';
  ws.getCell(`A${row}`).font = { bold: true };
  row += 2;
  for (const pivot of pivots) {
    ws.getCell(`A${row}`).value = `Pivot: ${pivot.rows.join(' × ')} dari ${pivot.source}`;
    ws.getCell(`A${row}`).font = { bold: true };
    row += 1;
    const sourceSheet = pivot.source.split('!')[0]?.replace(/'/g, '') ?? '';
    const source = workbook.sheets.find((s) => s.name === sourceSheet);
    if (!source) continue;
    const headers = new Map<number, string>();
    for (const [refText, cell] of Object.entries(source.cells)) {
      const ref = parseCellRef(refText);
      if (ref && ref.row === 0 && typeof cell.v === 'string') headers.set(ref.col, cell.v);
    }
    const colOf = (field: string): number | null => {
      for (const [idx, name] of headers) if (name.toLowerCase() === field.toLowerCase()) return idx;
      return null;
    };
    const rowField = pivot.rows[0];
    const valueField = pivot.values[0]?.field;
    if (!rowField || !valueField) continue;
    const rowCol = colOf(rowField);
    const valCol = colOf(valueField);
    if (rowCol === null || valCol === null) continue;
    const rangeRef = pivot.source.includes('!') ? pivot.source.split('!')[1] as string : 'A1:Z1000';
    const rowsCount = rangeRef.split(':')[1]?.replace(/[^0-9]/g, '') ?? '1000';
    const rowLetter = formatCellRef(rowCol, 0).replace(/[0-9]/g, '');
    const valLetter = formatCellRef(valCol, 0).replace(/[0-9]/g, '');
    const categories = new Set<string>();
    for (const [refText, cell] of Object.entries(source.cells)) {
      const ref = parseCellRef(refText);
      if (ref && ref.col === rowCol && ref.row > 0 && typeof cell.v === 'string') categories.add(cell.v);
    }
    ws.getCell(`A${row}`).value = rowField;
    ws.getCell(`B${row}`).value = `${pivot.values[0]?.agg ?? 'sum'} ${valueField}`;
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`B${row}`).font = { bold: true };
    row += 1;
    for (const category of [...categories].sort()) {
      ws.getCell(`A${row}`).value = category;
      const criteriaRange = `'${sourceSheet}'!$${rowLetter}$2:$${rowLetter}$${rowsCount}`;
      const sumRange = `'${sourceSheet}'!$${valLetter}$2:$${valLetter}$${rowsCount}`;
      ws.getCell(`B${row}`).value = {
        formula: `SUMIF(${criteriaRange},A${row},${sumRange})`,
      };
      row += 1;
    }
    row += 1;
  }
  wb.calcProperties.fullCalcOnLoad = true;
  await wb.xlsx.writeFile(xlsxPath);
  void root;
}

export function exportSheetToCsvText(workbook: WorkbookSpec, sheetName: string): { ok: true; text: string } | { ok: false; issues: string[] } {
  const sheet = workbook.sheets.find((s) => s.name === sheetName);
  if (!sheet) return { ok: false, issues: [`sheet "${sheetName}" does not exist`] };
  const evaluation = evaluateWorkbook(workbook);
  let maxRow = 0;
  let maxCol = 0;
  for (const refText of Object.keys(sheet.cells)) {
    const ref = parseCellRef(refText);
    if (!ref) continue;
    maxRow = Math.max(maxRow, ref.row);
    maxCol = Math.max(maxCol, ref.col);
  }
  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const fields: string[] = [];
    for (let c = 0; c <= maxCol; c += 1) {
      const ref = formatCellRef(c, r);
      const text = displayValue(workbook, evaluation, sheet, ref);
      fields.push(/["\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(fields.join(','));
  }
  return { ok: true, text: `${lines.join('\n')}\n` };
}

export async function exportWorkbookCsv(
  workbook: WorkbookSpec,
  root: string,
  sheetName?: string,
): Promise<SheetExportRecord[]> {
  const paths = workbookPaths(root);
  await mkdir(paths.dir, { recursive: true });
  const records: SheetExportRecord[] = [];
  const targets = sheetName ? workbook.sheets.filter((s) => s.name === sheetName) : workbook.sheets;
  for (const sheet of targets) {
    const csv = exportSheetToCsvText(workbook, sheet.name);
    if (!csv.ok) continue;
    const outPath = join(paths.dir, `${slugifyTitle(workbook.title)}-${slugifyTitle(sheet.name)}.csv`);
    await writeFile(outPath, csv.text, 'utf8');
    records.push({ at: new Date().toISOString(), path: outPath, format: 'csv', bytes: Buffer.byteLength(csv.text), via: 'exceljs', note: 'nilai formula dievaluasi core saat ekspor CSV' });
  }
  return records;
}

/* ------------------------------------------------------- Go sidecar */

export type SidecarSpec = {
  charts: ChartSpec[];
  pivots: PivotSpec[];
  slicers: SlicerSpec[];
};

export type SidecarRunResult =
  | { applied: true; note: string }
  | { applied: false; reason: string };

export type SidecarProbe = { available: boolean; path: string | null; version: string | null };

/**
 * Sidecar discovery mirrors how the server finds Pratinjau Asli
 * engines: explicit env override first, then PATH. Bundled-at-install
 * copies land on PATH (see sheet-sidecar/README.md); a missing binary
 * is a normal, honestly-reported state, never an error.
 */
export function sidecarCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.DAEDALUS_SHEET_SIDECAR) out.push(env.DAEDALUS_SHEET_SIDECAR);
  out.push('daedalus-sheet-sidecar');
  return out;
}

function spawnCapture(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    // A sidecar that exits before the payload flushes (instant
    // --version, early death) must not take the export down with an
    // unhandled stdin EPIPE — the exit code carries the verdict.
    child.stdin.on('error', () => undefined);
    child.on('error', () => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

export async function probeSheetSidecar(env: NodeJS.ProcessEnv = process.env): Promise<SidecarProbe> {
  for (const candidate of sidecarCandidates(env)) {
    const result = await spawnCapture(candidate, ['--version'], '', 8000).catch(() => null);
    if (result && result.code === 0) {
      return { available: true, path: candidate, version: result.stdout.trim().slice(0, 80) || null };
    }
  }
  return { available: false, path: null, version: null };
}

/**
 * Inject native charts/pivots/slicers into an already-exported xlsx.
 * Contract (sheet-sidecar): JSON on stdin {input, output, charts,
 * pivots, slicers}; exit 0 = written; the input file is never modified
 * in place — output replaces it only after a successful run. A slicer
 * bound to a pivot (`pivot` = PivotSpec.id) resolves here to the
 * pivot's native name + target sheet, which is how Excelize attaches
 * a slicer to a pivot table instead of a source table.
 */
export async function runSheetSidecar(
  xlsxPath: string,
  workbook: WorkbookSpec,
  spec: SidecarSpec,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<SidecarRunResult> {
  if (spec.charts.length === 0 && spec.pivots.length === 0 && spec.slicers.length === 0) return { applied: false, reason: 'no-native-specs' };
  const probe = await probeSheetSidecar(opts.env);
  if (!probe.available || !probe.path) return { applied: false, reason: 'sidecar-tidak-terdeteksi' };
  const tmpOut = `${xlsxPath}.sidecar-tmp.xlsx`;
  const slicerPayload = spec.slicers.map((sl) => {
    const pivot = sl.pivot ? spec.pivots.find((p) => p.id === sl.pivot) : undefined;
    return {
      field: sl.field,
      source: sl.source,
      target: sl.sheet ?? '',
      cell: sl.anchor,
      ...(sl.kind ? { kind: sl.kind } : {}),
      ...(pivot ? { pivot: pivot.name ?? pivot.id, pivotSheet: pivot.target } : {}),
    };
  });
  const payload = JSON.stringify({ input: xlsxPath, output: tmpOut, title: workbook.title, charts: spec.charts, pivots: spec.pivots, slicers: slicerPayload });
  const result = await spawnCapture(probe.path, ['inject'], payload, opts.timeoutMs ?? 120000);
  if (result.code !== 0) {
    return { applied: false, reason: `sidecar gagal (exit ${String(result.code)}): ${(result.stderr || result.stdout).trim().slice(0, 200)}` };
  }
  // The sidecar reports what it ACTUALLY injected (a spec it cannot
  // honor is skipped with a note) — the export record quotes that,
  // never the request. Unparseable output is treated as: file written,
  // counts unknown.
  type SidecarCounts = { charts?: number; pivots?: number; slicers?: number; notes?: string[] };
  let actual: SidecarCounts | null = null;
  try {
    actual = JSON.parse(result.stdout) as SidecarCounts;
  } catch { actual = null; }
  const injectedCharts = actual?.charts ?? spec.charts.length;
  const injectedPivots = actual?.pivots ?? spec.pivots.length;
  const injectedSlicers = actual?.slicers ?? 0;
  const skipNotes = (actual?.notes ?? []).filter((n) => n.includes('skipped') || n.includes('timeline'));
  if (injectedCharts + injectedPivots + injectedSlicers === 0) {
    const { rm } = await import('node:fs/promises');
    await rm(tmpOut, { force: true }).catch(() => undefined);
    return { applied: false, reason: `sidecar tidak menyuntikkan apa pun: ${skipNotes.join('; ') || 'hasil kosong'}` };
  }
  try {
    const { rename } = await import('node:fs/promises');
    await rename(tmpOut, xlsxPath);
  } catch (err) {
    return { applied: false, reason: `sidecar output tidak bisa dipasang: ${err instanceof Error ? err.message : String(err)}` };
  }
  const kinds = [
    injectedCharts ? `${injectedCharts} chart native` : '',
    injectedPivots ? `${injectedPivots} pivot native` : '',
    injectedSlicers ? `${injectedSlicers} slicer native` : '',
  ].filter(Boolean).join(' + ');
  return { applied: true, note: `${kinds} disuntikkan Go sidecar (${probe.version ?? probe.path})${skipNotes.length ? `; dilewati: ${skipNotes.join('; ')}` : ''}` };
}
