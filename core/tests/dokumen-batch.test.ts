import { describe, expect, test } from 'vitest';
import { mergeBatchToCsv, writeBatchCsv, type BatchDocInput, type DokumenSchema, type ExtractRecord } from '../src/index.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fase C (desain 4.3): batch ekstrak → 1 CSV gabungan. Jujur: field
 * confidence rendah / gagal ikut CSV tapi ditandai "perlu review";
 * file yang gagal diproses dilaporkan, tidak dihilangkan diam-diam.
 */

const schema = (fields: Array<{ name: string; required?: boolean }>): DokumenSchema => ({
  version: 1,
  approved: true,
  extractionTarget: 'per_doc',
  fields: fields.map((f) => ({ name: f.name, type: 'string' as const, required: f.required })),
});

function rec(id: string, fields: Record<string, { value: string | number | null; confidence?: number; status?: 'auto' | 'flagged' | 'escalated' }>): ExtractRecord {
  return {
    id,
    sourceId: 'src-1',
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, f]) => [name, { value: f.value, confidence: f.confidence ?? 0.95, status: f.status ?? 'auto' }]),
    ),
    checks: [],
    decision: 'auto-clear',
  };
}

const inv1: BatchDocInput = {
  ok: true,
  docId: 'd1',
  filename: 'inv-001.pdf',
  schema: schema([{ name: 'vendor', required: true }, { name: 'total', required: true }]),
  records: [rec('r1', { vendor: { value: 'CV Sinar' }, total: { value: 555000 } })],
};

const inv2: BatchDocInput = {
  ok: true,
  docId: 'd2',
  filename: 'inv-002.pdf',
  schema: schema([{ name: 'vendor', required: true }, { name: 'total', required: true }, { name: 'tanggal' }]),
  records: [
    rec('r2', { vendor: { value: 'PT Maju', confidence: 0.4 }, total: { value: 100000 }, tanggal: { value: '2026-01-01' } }),
    rec('r3', { vendor: { value: 'PT Mundur', status: 'flagged' }, total: { value: null } }),
  ],
};

describe('mergeBatchToCsv (Fase C 4.3)', () => {
  test('merges records from many docs into one CSV with union columns', () => {
    const r = mergeBatchToCsv([inv1, inv2]);
    expect(r.fileCount).toBe(2);
    expect(r.recordCount).toBe(3);
    expect(r.columns).toEqual(['_file', 'vendor', 'total', 'tanggal', '_decision', '_review']);
    expect(r.fieldCount).toBe(3 * 3); // 3 record × 3 kolom field
    const lines = r.csv.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 baris
    expect(lines[0]).toBe('_file,vendor,total,tanggal,_decision,_review');
    expect(lines[1]).toContain('inv-001.pdf');
    expect(lines[1]).toContain('CV Sinar');
    expect(lines[1]).toMatch(/,ok$/);
  });

  test('low-confidence and flagged fields are marked for review, not dropped', () => {
    const r = mergeBatchToCsv([inv1, inv2]);
    // r2.vendor confidence 0.4 → review; r3.vendor flagged → review; r3.total wajib kosong → review
    expect(r.review.length).toBe(3);
    const reasons = r.review.map((x) => x.reason).join(' | ');
    expect(reasons).toMatch(/confidence rendah/);
    expect(reasons).toMatch(/flagged/);
    expect(reasons).toMatch(/wajib kosong/);
    const lines = r.csv.trim().split('\n');
    expect(lines[2]).toMatch(/perlu review$/);
    expect(lines[3]).toMatch(/perlu review$/);
    expect(lines[1]).toMatch(/,ok$/);
  });

  test('failed files are reported and counted separately', () => {
    const r = mergeBatchToCsv([inv1, { ok: false, docId: 'd9', filename: 'rusak.pdf', error: 'gagal dibaca' }]);
    expect(r.fileCount).toBe(1);
    expect(r.recordCount).toBe(1);
    expect(r.failed).toEqual([{ file: 'rusak.pdf', error: 'gagal dibaca' }]);
  });

  test('CSV escapes commas, quotes, and newlines', () => {
    const r = mergeBatchToCsv([{
      ok: true,
      docId: 'd1',
      filename: 'a.pdf',
      schema: schema([{ name: 'vendor' }]),
      records: [rec('r1', { vendor: { value: 'PT "Maju", Bersama\nJaya' } })],
    }]);
    expect(r.csv).toContain('"PT ""Maju"", Bersama\nJaya"');
  });

  test('empty input yields header-only CSV', () => {
    const r = mergeBatchToCsv([]);
    expect(r.fileCount).toBe(0);
    expect(r.recordCount).toBe(0);
    expect(r.fieldCount).toBe(0);
    expect(r.csv.trim().split('\n')).toHaveLength(1);
  });
});

describe('writeBatchCsv', () => {
  test('writes under .daedalus/documents/batch/exports and returns the relative path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daedalus-batch-'));
    const { relPath, filename } = await writeBatchCsv(root, '_file\n');
    expect(relPath).toBe(`.daedalus/documents/batch/exports/${filename}`);
    expect(readFileSync(join(root, relPath), 'utf8')).toBe('_file\n');
  });
});
