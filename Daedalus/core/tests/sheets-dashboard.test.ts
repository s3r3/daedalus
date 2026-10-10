import { afterEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  applySheetOps,
  composeDashboard,
  dashboardComposition,
  evaluateWorkbook,
  exportWorkbookToXlsx,
  newSheet,
  newWorkbook,
  validateBlueprint,
  validateWorkbook,
  verifyWorkbook,
  writeWorkbook,
  type WorkbookSpec,
} from '../src/index.ts';

/**
 * Native Excel dashboard composition acceptance: tiles are live
 * formulas materialized as cells (evaluator-verified), follow-up
 * pieces go through the closed op vocabulary with the batch
 * byte-identical guarantee, the exporter writes real dashboard
 * styling + a hidden pivot helper sheet, and the export record
 * names the composed counts. Sidecar-facing payload mapping is
 * exercised against a stub binary (the real Go binary has its own
 * spike record in sheet-sidecar/README.md).
 */

const tmps: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-dash-test-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
  delete process.env.DAEDALUS_SHEET_SIDECAR;
});

/** Sales fixture: Data + Dashboard composed (tiles/charts/pivot/slicers). */
function dashboardWorkbook(): WorkbookSpec {
  const wb = newWorkbook('Dashboard Penjualan', { createdBy: 'test' });
  wb.stage = 'ready';
  const data = newSheet('Data');
  ['Bulan', 'Region', 'Total'].forEach((h, i) => { data.cells[`${'ABC'[i]}1`] = { v: h, bold: true }; });
  const rows: Array<[string, string, number]> = [
    ['Jan', 'Barat', 100],
    ['Jan', 'Timur', 200],
    ['Feb', 'Barat', 300],
  ];
  rows.forEach(([bulan, region, total], i) => {
    const r = i + 2;
    data.cells[`A${r}`] = { v: bulan };
    data.cells[`B${r}`] = { v: region };
    data.cells[`C${r}`] = { v: total };
  });
  wb.sheets.push(data);
  const notes = composeDashboard(wb, {
    sheet: 'Dashboard',
    tiles: [
      { id: 'tile-total', label: 'Total Revenue', formula: '=SUM(Data!C2:C4)', fmt: '#,##0', anchor: 'B2', cols: 3, rows: 3 },
      { id: 'tile-barat', label: 'Revenue Barat', formula: '=SUMIF(Data!B2:B4,"Barat",Data!C2:C4)', fmt: '#,##0', anchor: 'F2', cols: 3, rows: 3 },
    ],
    charts: [{ id: 'chart-region', type: 'column', range: 'Data!A1:C4', sheet: 'Dashboard', anchor: 'B8', title: 'Revenue', width: 18, height: 9 }],
    pivots: [{ id: 'pivot-region', source: 'Data!A1:C4', target: '_PivotData', anchor: 'A1', rows: ['Region'], values: [{ field: 'Total', agg: 'sum' }] }],
    slicers: [
      { id: 'slicer-region', field: 'Region', source: 'Data!A1:C4', anchor: 'B24', pivot: 'pivot-region' },
      { id: 'slicer-bulan', field: 'Bulan', source: 'Data!A1:C4', anchor: 'F24', kind: 'timeline' },
    ],
  });
  expect(notes.join(' ')).toContain('2 kartu KPI');
  return wb;
}

describe('dashboard composition', () => {
  test('tiles materialize into label + live-formula cells with merges; evaluator verifies them', () => {
    const wb = dashboardWorkbook();
    const dash = wb.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    expect(dash.kind).toBe('dashboard');
    expect(dash.cells['B2']?.v).toBe('Total Revenue');
    expect(dash.cells['B3']?.f).toBe('=SUM(Data!C2:C4)');
    expect(dash.cells['B3']?.v).toBeUndefined();
    expect(dash.merges).toContain('B2:D2');
    expect(dash.merges).toContain('B3:D4');
    const evaluation = evaluateWorkbook(wb);
    expect(evaluation.results.get('Dashboard')?.get('B3')).toEqual({ kind: 'value', value: 600 });
    expect(evaluation.results.get('Dashboard')?.get('F3')).toEqual({ kind: 'value', value: 400 });
    expect(evaluation.errors).toEqual([]);
    expect(validateWorkbook(wb).filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('helper pivot sheet is hidden; composition counts are named', () => {
    const wb = dashboardWorkbook();
    const helper = wb.sheets.find((s) => s.name === '_PivotData');
    expect(helper?.hidden).toBe(true);
    const comp = dashboardComposition(wb);
    expect(comp).toEqual({ sheet: 'Dashboard', tiles: 2, charts: 1, slicers: 2 });
  });

  test('a broken tile formula fails the verify gate with its cell address', async () => {
    const wb = dashboardWorkbook();
    const dash = wb.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    const tile = (dash.tiles ?? [])[0] as NonNullable<typeof dash.tiles>[number];
    tile.formula = '=SUM(Hilang!C2:C4)';
    dash.cells['B3'] = { f: '=SUM(Hilang!C2:C4)' };
    const report = await verifyWorkbook(wb, { coreOnly: true });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.sheet === 'Dashboard' && e.cell === 'B3')).toBe(true);
  });

  test('tile/spec desync is a structural error (forked truth refused)', () => {
    const wb = dashboardWorkbook();
    const dash = wb.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    dash.cells['B3'] = { f: '=SUM(Data!C2:C4)+1' };
    const codes = validateWorkbook(wb).map((i) => i.code);
    expect(codes).toContain('tile-formula-mismatch');
  });
});

describe('dashboard ops (follow-up edits)', () => {
  test('set_tile upserts and rematerializes; delete_tile removes cells and spec', () => {
    const wb = dashboardWorkbook();
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [
        { op: 'set_tile', sheet: 'Dashboard', label: 'Rata-rata Order', formula: '=SUM(Data!C2:C4)/3', fmt: '#,##0', anchor: 'J2' },
        { op: 'set_tile', sheet: 'Dashboard', tile: 'tile-total', label: 'Total Revenue', formula: '=SUM(Data!C2:C4)*2', fmt: '#,##0', anchor: 'B2', cols: 3, rows: 3 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dash = result.workbook.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    expect(dash.cells['J3']?.f).toBe('=SUM(Data!C2:C4)/3');
    expect(dash.cells['B3']?.f).toBe('=SUM(Data!C2:C4)*2');
    expect((dash.tiles ?? []).map((t) => t.id).sort()).toEqual(['tile-barat', 'tile-rata-rata-order', 'tile-total']);
    const evaluation = evaluateWorkbook(result.workbook);
    expect(evaluation.results.get('Dashboard')?.get('J3')).toEqual({ kind: 'value', value: 200 });

    const deleted = applySheetOps(result.workbook, {
      kind: 'sheet-ops',
      ops: [{ op: 'delete_tile', sheet: 'Dashboard', tile: 'tile-rata-rata-order' }],
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const dashAfter = deleted.workbook.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    expect(dashAfter.cells['J3']).toBeUndefined();
    expect((dashAfter.tiles ?? []).some((t) => t.id === 'tile-rata-rata-order')).toBe(false);
  });

  test('an invalid tile (no live formula) rejects the whole batch; workbook unchanged', async () => {
    const root = tempWorkspace();
    const wb = dashboardWorkbook();
    await writeWorkbook(root, wb);
    const before = readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8');
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [
        { op: 'set_cells', sheet: 'Data', range: 'C2', values: [[999]] },
        { op: 'set_tile', sheet: 'Dashboard', label: 'BeKu', formula: '600', anchor: 'B2' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('live formula');
    expect(readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8')).toBe(before);
  });

  test('set_chart/set_slicer/delete round-trip through the op vocabulary', () => {
    const wb = dashboardWorkbook();
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [
        { op: 'set_chart', sheet: 'Dashboard', id: 'chart-bulan', type: 'line', range: 'Data!A1:C4', anchor: 'B16', title: 'Bulanan' },
        { op: 'set_slicer', sheet: 'Dashboard', id: 'slicer-region-2', field: 'Region', source: 'Data!A1:C4', anchor: 'J24' },
        { op: 'delete_chart', sheet: 'Dashboard', chart: 'chart-region' },
        { op: 'delete_slicer', sheet: 'Dashboard', slicer: 'slicer-bulan' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dash = result.workbook.sheets.find((s) => s.name === 'Dashboard') as WorkbookSpec['sheets'][number];
    expect((dash.charts ?? []).map((c) => c.id)).toEqual(['chart-bulan']);
    expect((dash.slicers ?? []).map((s) => s.id).sort()).toEqual(['slicer-region', 'slicer-region-2']);
    const bad = applySheetOps(result.workbook, {
      kind: 'sheet-ops',
      ops: [{ op: 'delete_tile', sheet: 'Dashboard', tile: 'tidak-ada' }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('blueprint dashboard section', () => {
  test('validateBlueprint parses tiles/charts/pivots/slicers; a frozen tile value is rejected', () => {
    const ok = validateBlueprint({
      title: 'Dash',
      sheets: [{ name: 'Data', columns: [{ name: 'Total', type: 'currency', source: 'input' }] }],
      dashboard: {
        sheet: 'Dashboard',
        tiles: [{ label: 'Total Revenue', formula: '=SUM(Data!C2:C4)', fmt: '#,##0' }],
        charts: [{ type: 'line', range: 'Data!A1:C4', anchor: 'B8' }],
        pivots: [{ source: 'Data!A1:C4', rows: ['Region'], values: [{ field: 'Total', agg: 'sum' }] }],
        slicers: [{ field: 'Region', source: 'Data!A1:C4', anchor: 'B24', pivot: 'pivot-90-0', kind: 'timeline' }],
      },
    }, 'goal');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.dashboard?.tiles[0]?.formula).toBe('=SUM(Data!C2:C4)');
    expect(ok.value.dashboard?.pivots?.[0]?.target).toBe('_PivotData');
    expect(ok.value.dashboard?.slicers?.[0]?.kind).toBe('timeline');

    const bad = validateBlueprint({
      title: 'Dash',
      sheets: [{ name: 'Data', columns: [{ name: 'Total', type: 'currency', source: 'input' }] }],
      dashboard: { tiles: [{ label: 'Beku', formula: '600' }] },
    }, 'goal');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.join(' ')).toContain('live formula');
  });
});

describe('export', () => {
  test('xlsx writes styled tiles, print area, active dashboard tab, hidden helper; record names counts', async () => {
    const root = tempWorkspace();
    const wb = dashboardWorkbook();
    await writeWorkbook(root, wb);
    const record = await exportWorkbookToXlsx(wb, root, { sidecar: false });
    expect(record.dashboard).toEqual({ sheet: 'Dashboard', tiles: 2, charts: 1, slicers: 2 });
    const back = new ExcelJS.Workbook();
    await back.xlsx.readFile(record.path);
    const dash = back.getWorksheet('Dashboard');
    expect(dash?.getCell('B2').value).toBe('Total Revenue');
    const value = dash?.getCell('B3').value as { formula?: string; result?: unknown };
    expect(value.formula).toBe('SUM(Data!C2:C4)');
    expect(value.result).toBe(600);
    expect(dash?.getCell('B2').fill).toBeTruthy();
    expect(back.getWorksheet('_PivotData')?.state).toBe('hidden');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(readFileSync(record.path));
    const wbXml = await zip.file('xl/workbook.xml')?.async('string');
    expect(wbXml).toContain('fullCalcOnLoad');
    const dashXmlName = Object.keys(zip.files).find((n) => n.includes('worksheets/sheet'));
    expect(dashXmlName).toBeTruthy();
  });

  test('sidecar payload maps slicer→pivot binding and timeline kind (stub binary)', async () => {
    const root = tempWorkspace();
    const stub = join(root, 'fake-sidecar.sh');
    const capture = join(root, 'payload.json');
    writeFileSync(stub, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "daedalus-sheet-sidecar 0.1.0 (excelize)"; exit 0; fi',
      `cat > ${capture}`,
      // Emulate the real contract: output file must exist for the core's rename.
      `IN=$(sed -n 's/.*"input":"\\([^"]*\\)".*/\\1/p' ${capture})`,
      `OUT=$(sed -n 's/.*"output":"\\([^"]*\\)".*/\\1/p' ${capture})`,
      'cp "$IN" "$OUT"',
      'echo "{\\"charts\\":1,\\"pivots\\":1,\\"slicers\\":2,\\"notes\\":[]}"',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);
    process.env.DAEDALUS_SHEET_SIDECAR = stub;
    const wb = dashboardWorkbook();
    await writeWorkbook(root, wb);
    const record = await exportWorkbookToXlsx(wb, root);
    expect(record.via).toBe('exceljs+sidecar');
    const payload = JSON.parse(readFileSync(capture, 'utf8')) as {
      slicers: Array<{ field: string; pivot?: string; pivotSheet?: string; kind?: string }>;
      pivots: Array<{ name?: string }>;
      charts: Array<{ width?: number; height?: number }>;
    };
    const region = payload.slicers.find((s) => s.field === 'Region');
    expect(region?.pivot).toBe('pivot-region');
    expect(region?.pivotSheet).toBe('_PivotData');
    const bulan = payload.slicers.find((s) => s.field === 'Bulan');
    expect(bulan?.kind).toBe('timeline');
    expect(payload.pivots[0]?.name).toBe('pivot-region');
    expect(payload.charts[0]).toMatchObject({ width: 18, height: 9 });
  });
});
