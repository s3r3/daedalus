import { describe, expect, test } from 'vitest';
import { profileSheet, profileWorkbook } from './analysis-profile.ts';
import { formatCellRef } from './workbook.ts';
import { newSheet } from './store.ts';

/**
 * analysis-profile: the deterministic, zero-LLM profiler. Same
 * cells → same profile; nullRate / cardinality / group candidates
 * are exact on the fixture.
 */

function fixtureSheet() {
  const sheet = newSheet('Data');
  const headers = ['Bulan', 'Kanal', 'Pendapatan', 'Biaya', 'Aktif', 'Tanggal'];
  headers.forEach((h, i) => { sheet.cells[formatCellRef(i, 0)] = { v: h, bold: true }; });
  const kanals = ['Online', 'Toko'];
  for (let i = 0; i < 20; i += 1) {
    const r = i + 2; // 1-based
    sheet.cells[formatCellRef(0, r - 1)] = { v: ['Jan', 'Feb', 'Mar', 'Apr'][i % 4] as string };
    sheet.cells[formatCellRef(1, r - 1)] = { v: kanals[i % 2] as string };
    sheet.cells[formatCellRef(2, r - 1)] = { v: (i + 1) * 100 };
    if (i % 4 !== 3) sheet.cells[formatCellRef(3, r - 1)] = { v: (i + 1) * 10 }; // 5 nulls → nullRate 0.25
    sheet.cells[formatCellRef(4, r - 1)] = { v: i % 2 === 0 };
    sheet.cells[formatCellRef(5, r - 1)] = { v: `2026-01-${String(i + 1).padStart(2, '0')}` };
  }
  return sheet;
}

describe('profileSheet', () => {
  test('deterministic: same input → identical profile', () => {
    expect(profileSheet(fixtureSheet())).toEqual(profileSheet(fixtureSheet()));
  });

  test('rowCount, types, nullRate, cardinality on the fixture', () => {
    const profile = profileSheet(fixtureSheet());
    expect(profile.sheetName).toBe('Data');
    expect(profile.rowCount).toBe(20);
    const byName = new Map(profile.columns.map((c) => [c.name, c]));
    expect(byName.get('Pendapatan')?.type).toBe('number');
    expect(byName.get('Aktif')?.type).toBe('boolean');
    expect(byName.get('Tanggal')?.type).toBe('date');
    expect(byName.get('Kanal')?.type).toBe('text');
    expect(byName.get('Biaya')?.nullRate).toBeCloseTo(0.25, 10);
    expect(byName.get('Pendapatan')?.nullRate).toBe(0);
    expect(byName.get('Kanal')?.cardinality).toBe(2);
    expect(byName.get('Pendapatan')?.cardinality).toBe(20);
    expect(byName.get('Kanal')?.samples).toEqual(['Online', 'Toko']);
    expect(profile.columns.map((c) => c.name)).toEqual(['Bulan', 'Kanal', 'Pendapatan', 'Biaya', 'Aktif', 'Tanggal']);
  });

  test('groupCandidates: text columns below 20% cardinality', () => {
    const profile = profileSheet(fixtureSheet());
    // Kanal: 2 < 0.2*20=4 ✓; Bulan: 4 < 4 ✗ (not strictly below)
    expect(profile.groupCandidates).toEqual(['Kanal']);
  });

  test('empty sheet → zero rows, no crash', () => {
    const profile = profileSheet(newSheet('Kosong'));
    expect(profile).toEqual({ sheetName: 'Kosong', rowCount: 0, columns: [], groupCandidates: [] });
  });

  test('header-only sheet → zero rows', () => {
    const sheet = newSheet('Header');
    sheet.cells['A1'] = { v: 'Nama', bold: true };
    const profile = profileSheet(sheet);
    expect(profile.rowCount).toBe(0);
    expect(profile.columns).toHaveLength(1);
    expect(profile.columns[0]?.nullRate).toBe(0);
  });
});

describe('profileWorkbook', () => {
  test('one profile per sheet, in order', () => {
    const wb = { version: 1 as const, id: 'wb', title: 't', stage: 'ready' as const, sheets: [fixtureSheet(), newSheet('Lain')], meta: { createdBy: 'test' } };
    const profiles = profileWorkbook(wb);
    expect(profiles.map((p) => p.sheetName)).toEqual(['Data', 'Lain']);
    expect(profiles[0]?.rowCount).toBe(20);
    expect(profiles[1]?.rowCount).toBe(0);
  });
});
