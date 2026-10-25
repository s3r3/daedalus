import { describe, expect, test } from 'vitest';
import { answerDataQuestion, qaCapabilities, toNumber } from './qa.ts';
import { formatCellRef } from './workbook.ts';
import { newSheet, newWorkbook } from './store.ts';

/**
 * qa.ts: deterministic Q&A over a dataset sheet. Every number comes
 * from the fixture's cells (same data → same answer), never from a
 * model. Tests cover intents, month/year filters, named-value
 * filters, top-N, and the honest "tidak bisa dihitung" path.
 */

function fixtureWorkbook() {
  const wb = newWorkbook('Penjualan 2026', { createdBy: 'qa-test' });
  const sheet = newSheet('Data');
  const headers = ['Tanggal', 'Produk', 'Kanal', 'Qty', 'Total'];
  headers.forEach((h, i) => { sheet.cells[formatCellRef(i, 0)] = { v: h, bold: true }; });
  const products = ['Kopi Tubruk', 'Teh Manis', 'Pisang Goreng'];
  const channels = ['Online', 'Toko'];
  for (let i = 0; i < 12; i += 1) {
    const r = i + 1; // 0-based data row index
    const month = i < 6 ? '01' : '02'; // Jan: rows 0-5, Feb: rows 6-11
    const prodIdx = i % 3;
    // Kopi Tubruk sells 2 extra per row → clear top-N winner (18 vs 10 vs 10).
    const qty = ((i % 4) + 1) + (prodIdx === 0 ? 2 : 0);
    sheet.cells[formatCellRef(0, r)] = { v: `2026-${month}-${String((i % 6) + 1).padStart(2, '0')}` };
    sheet.cells[formatCellRef(1, r)] = { v: products[prodIdx] as string };
    sheet.cells[formatCellRef(2, r)] = { v: channels[i % 2] as string };
    sheet.cells[formatCellRef(3, r)] = { v: qty };
    sheet.cells[formatCellRef(4, r)] = { v: qty * 25000 };
  }
  wb.sheets.push(sheet);
  return wb;
}

describe('toNumber', () => {
  test('parses Indonesian formats deterministically', () => {
    expect(toNumber(123)).toBe(123);
    expect(toNumber('Rp 25.000')).toBe(25000);
    expect(toNumber('1.240')).toBe(1240);
    expect(toNumber('1,5')).toBe(1.5);
    expect(toNumber('')).toBe(null);
    expect(toNumber(undefined)).toBe(null);
  });
});

describe('answerDataQuestion', () => {
  test('sum: total penjualan', () => {
    // Qty total 38 → Total = 38 * 25000 = 950000.
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan?');
    expect(a.ok).toBe(true);
    expect(a.intent).toBe('sum');
    expect(a.column).toBe('Total');
    expect(a.value).toBe(950000);
    expect(a.method).toContain('12 baris');
    expect(a.method).toContain('kolom "Total"');
  });

  test('sum with month filter via date column', () => {
    // January rows 0-5: Qty 3,2,3,6,1,2 → sum 17 → Total 425000.
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan bulan Januari?');
    expect(a.ok).toBe(true);
    expect(a.intent).toBe('sum');
    expect(a.value).toBe(425000);
    expect(a.method).toContain('6 baris');
    expect(a.method).toContain('bulan januari');
  });

  test('avg: rata-rata qty', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa rata-rata qty?');
    expect(a.ok).toBe(true);
    expect(a.intent).toBe('avg');
    expect(a.value).toBeCloseTo(38 / 12, 10);
  });

  test('max/min over Total', () => {
    const mx = answerDataQuestion(fixtureWorkbook(), 'Berapa penjualan tertinggi?');
    expect(mx.ok).toBe(true);
    expect(mx.intent).toBe('max');
    expect(mx.value).toBe(150000);
    const mn = answerDataQuestion(fixtureWorkbook(), 'Berapa penjualan terendah?');
    expect(mn.ok).toBe(true);
    expect(mn.value).toBe(25000);
  });

  test('count rows without a column mention', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa banyak baris data?');
    expect(a.ok).toBe(true);
    expect(a.intent).toBe('count');
    expect(a.value).toBe(12);
  });

  test('count distinct values of a named column', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa produk yang ada?');
    expect(a.ok).toBe(true);
    expect(a.value).toBe(3);
    expect(a.column).toBe('Produk');
  });

  test('top-N: produk paling laris', () => {
    // "laris" → Qty per product: Kopi 18, Teh 10, Pisang 10.
    const a = answerDataQuestion(fixtureWorkbook(), 'Produk apa yang paling laris?');
    expect(a.ok).toBe(true);
    expect(a.intent).toBe('topn');
    expect(a.column).toBe('Qty');
    expect(a.topRows).toHaveLength(3);
    expect(a.topRows?.[0]).toEqual({ label: 'Kopi Tubruk', value: 18 });
    expect(a.method).toContain('kolom "Qty"');
  });

  test('named value filter: kanal Online', () => {
    // Online rows: i even → Qty 3,3,1,5,1,3 = 16 → Total 400000.
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan kanal Online?');
    expect(a.ok).toBe(true);
    expect(a.value).toBe(400000);
    expect(a.method).toContain('6 baris');
  });

  test('quoted value filter', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan untuk "Teh Manis"?');
    expect(a.ok).toBe(true);
    expect(a.value).toBe(250000);
  });

  test('year filter', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan tahun 2026?');
    expect(a.ok).toBe(true);
    expect(a.value).toBe(950000);
    expect(a.method).toContain('tahun 2026');
  });

  test('filter matching nothing → honest zero-rows note', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Berapa total penjualan bulan Maret?');
    expect(a.ok).toBe(false);
    expect(a.answer).toContain('tidak bisa dihitung dari dataset ini');
  });

  test('unrecognized question → honest capabilities hint', () => {
    const a = answerDataQuestion(fixtureWorkbook(), 'Siapa nama direktur perusahaan ini?');
    expect(a.ok).toBe(false);
    expect(a.answer).toContain('tidak mengenali maksud');
  });

  test('empty workbook → honest failure', () => {
    const wb = newWorkbook('Kosong', { createdBy: 'qa-test' });
    wb.sheets.push(newSheet('Data'));
    const a = answerDataQuestion(wb, 'Berapa total penjualan?');
    expect(a.ok).toBe(false);
    expect(a.answer).toContain('tidak bisa dihitung dari dataset ini');
  });

  test('no numeric column → honest failure', () => {
    const wb = newWorkbook('Teks', { createdBy: 'qa-test' });
    const sheet = newSheet('Data');
    sheet.cells['A1'] = { v: 'Nama' };
    sheet.cells['A2'] = { v: 'Budi' };
    wb.sheets.push(sheet);
    const a = answerDataQuestion(wb, 'Berapa total penjualan?');
    expect(a.ok).toBe(false);
    expect(a.answer).toContain('kolom numerik');
  });

  test('helper sheets are skipped when picking the dataset', () => {
    const wb = fixtureWorkbook();
    const helper = newSheet('Ringkasan');
    helper.cells['A1'] = { v: 'x' };
    wb.sheets.unshift(helper);
    const a = answerDataQuestion(wb, 'Berapa banyak baris data?');
    expect(a.ok).toBe(true);
    expect(a.sheet).toBe('Data');
    expect(a.value).toBe(12);
  });

  test('deterministic: same question → identical answer', () => {
    const wb = fixtureWorkbook();
    expect(answerDataQuestion(wb, 'Berapa rata-rata qty?')).toEqual(answerDataQuestion(wb, 'Berapa rata-rata qty?'));
  });
});

describe('qaCapabilities', () => {
  test('lists answerable question kinds', () => {
    const caps = qaCapabilities(fixtureWorkbook());
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.some((c) => c.includes('Total'))).toBe(true);
    expect(caps.some((c) => c.includes('bulan'))).toBe(true);
  });
});
