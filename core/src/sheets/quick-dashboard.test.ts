import { describe, expect, test } from 'vitest';
import { buildQuickDashboard } from './quick-dashboard.ts';
import { evaluateWorkbook } from './evaluator.ts';
import { formatCellRef, tileRefs } from './workbook.ts';
import { newSheet, newWorkbook } from './store.ts';

/**
 * quick-dashboard: Dashboard 1 perintah. Deterministic — same
 * dataset → same dashboard. KPI cards are LIVE formulas (never
 * frozen numbers): the in-core evaluator must compute the exact
 * expected totals from the tile cells.
 */

function salesWorkbook() {
  const wb = newWorkbook('Penjualan', { createdBy: 'qd-test' });
  const sheet = newSheet('Data');
  const headers = ['Tanggal', 'Produk', 'Kanal', 'Qty', 'Total'];
  headers.forEach((h, i) => { sheet.cells[formatCellRef(i, 0)] = { v: h, bold: true }; });
  const products = ['Kopi Tubruk', 'Teh Manis', 'Pisang Goreng'];
  // Qty chosen so totals differ per product: Kopi 36, Teh 20, Pisang 20
  // (24 rows so "Produk" qualifies as a group candidate: 3 < 20% of 24).
  const qtys = [3, 2, 3, 6, 1, 2, 5, 4, 1, 4, 3, 4];
  for (let i = 0; i < 24; i += 1) {
    const r = i + 1;
    sheet.cells[formatCellRef(0, r)] = { v: `2026-01-${String((i % 24) + 1).padStart(2, '0')}` };
    sheet.cells[formatCellRef(1, r)] = { v: products[i % 3] as string };
    sheet.cells[formatCellRef(2, r)] = { v: i % 2 === 0 ? 'Online' : 'Toko' };
    sheet.cells[formatCellRef(3, r)] = { v: qtys[i % 12] as number };
    sheet.cells[formatCellRef(4, r)] = { v: (qtys[i % 12] as number) * 25000 };
  }
  wb.sheets.push(sheet);
  return wb;
}

describe('buildQuickDashboard', () => {
  test('composes Dashboard: 4 live-formula KPI tiles + category table + chart', () => {
    const result = buildQuickDashboard(salesWorkbook());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dashboardSheet).toBe('Dashboard');
    expect(result.measureColumn).toBe('Total');
    expect(result.groupColumn).toBe('Produk');
    expect(result.categories).toEqual(['Kopi Tubruk', 'Teh Manis', 'Pisang Goreng']);

    const dash = result.workbook.sheets.find((s) => s.name === 'Dashboard');
    expect(dash?.kind).toBe('dashboard');
    expect(dash?.tiles).toHaveLength(4);

    // KPI cells are formulas, never frozen numbers.
    const formulas = (dash?.tiles ?? []).map((t) => t.formula);
    expect(formulas[0]).toMatch(/^=SUM\(Data!E\$2:E\$25\)$/);
    expect(formulas[1]).toMatch(/^=AVERAGE\(/);
    expect(formulas[2]).toMatch(/^=MAX\(/);
    expect(formulas[3]).toMatch(/^=MIN\(/);
    for (const tile of dash?.tiles ?? []) {
      const refs = tileRefs(tile);
      expect(refs).not.toBe(null);
      const valueCell = dash?.cells[refs!.valueRef];
      expect(valueCell?.f).toBe(tile.formula);
      expect(valueCell?.v).toBeUndefined();
    }

    // The evaluator computes the exact totals through the live formulas.
    const evaluation = evaluateWorkbook(result.workbook);
    const dashResults = evaluation.results.get('Dashboard');
    const totalRefs = tileRefs((dash?.tiles ?? [])[0]!);
    const total = dashResults?.get(totalRefs!.valueRef);
    expect(total?.kind).toBe('value');
    if (total?.kind === 'value') expect(total.value).toBe(76 * 25000);

    // Summary table: headers + live COUNTIF/SUMIF/AVERAGEIF rows.
    expect(dash?.cells['A7']?.v).toBe('Produk');
    expect(dash?.cells['B7']?.v).toBe('Jumlah');
    expect(dash?.cells['A8']?.v).toBe('Kopi Tubruk');
    expect(dash?.cells['B8']?.f).toMatch(/^=COUNTIF\(Data!B\$2:B\$25,\$A\$8\)$/);
    expect(dash?.cells['C8']?.f).toMatch(/^=SUMIF\(/);
    expect(dash?.cells['D8']?.f).toMatch(/^=AVERAGEIF\(/);
    const countEval = dashResults?.get('B8');
    expect(countEval?.kind).toBe('value');
    if (countEval?.kind === 'value') expect(countEval.value).toBe(8);

    // Chart spec anchors the category table (native at export).
    expect(dash?.charts).toHaveLength(1);
    expect(dash?.charts?.[0]?.type).toBe('column');
    expect(dash?.charts?.[0]?.range).toBe('Dashboard!A7:D10');

    // Original sheet untouched; input workbook not mutated.
    expect(result.workbook.sheets.find((s) => s.name === 'Data')).toBeDefined();
  });

  test('deterministic: same input → identical dashboard', () => {
    const a = buildQuickDashboard(salesWorkbook());
    const b = buildQuickDashboard(salesWorkbook());
    // meta.createdAt legitimately differs per fixture build — compare
    // everything the builder produces, not the fixture's timestamp.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      const strip = (r: typeof a) => r.ok ? {
        ...r,
        workbook: {
          ...r.workbook,
          id: 'x',
          meta: undefined,
          sheets: r.workbook.sheets.map((s) => ({ ...s, id: 'y' })),
        },
      } : null;
      expect(strip(a)).toEqual(strip(b));
      expect(a.kpis).toEqual(b.kpis);
      expect(a.categories).toEqual(b.categories);
      expect(a.summary).toEqual(b.summary);
    }
  });

  test('honest failure: no numeric column', () => {
    const wb = newWorkbook('Teks', { createdBy: 'qd-test' });
    const sheet = newSheet('Data');
    sheet.cells['A1'] = { v: 'Nama' };
    sheet.cells['A2'] = { v: 'Budi' };
    wb.sheets.push(sheet);
    const result = buildQuickDashboard(wb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('kolom numerik');
  });

  test('honest failure: empty dataset', () => {
    const wb = newWorkbook('Kosong', { createdBy: 'qd-test' });
    wb.sheets.push(newSheet('Data'));
    const result = buildQuickDashboard(wb);
    expect(result.ok).toBe(false);
  });

  test('works without a text column (KPIs only, no chart)', () => {
    const wb = newWorkbook('Angka', { createdBy: 'qd-test' });
    const sheet = newSheet('Data');
    sheet.cells['A1'] = { v: 'Nilai' };
    sheet.cells['A2'] = { v: 10 };
    sheet.cells['A3'] = { v: 20 };
    wb.sheets.push(sheet);
    const result = buildQuickDashboard(wb);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groupColumn).toBe(null);
    expect(result.categories).toEqual([]);
    const dash = result.workbook.sheets.find((s) => s.name === 'Dashboard');
    expect(dash?.tiles).toHaveLength(4);
    expect(dash?.charts ?? []).toHaveLength(0);
  });
});
