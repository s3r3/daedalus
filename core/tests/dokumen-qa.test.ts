import { describe, expect, test } from 'vitest';
import { answerDocumentQuestion, type DocumentState, type ExtractRecord } from '../src/index.ts';

/**
 * Fase C — Q&A dokumen: jawab dari HASIL EKSTRAKSI, jangan halusinasi.
 * Kalau tidak ada di data → found:false dengan jawaban jujur.
 */

function fv(value: string | number | null, confidence = 0.95): ExtractRecord['fields'][string] {
  return { value, confidence, status: 'auto', ...(typeof value === 'string' ? { provenance: { page: 1, quote: `…${value}…` } } : {}) };
}

function invoiceDoc(): DocumentState {
  const records: ExtractRecord[] = [
    {
      id: 'rec-1', sourceId: 'src-1',
      fields: { vendor: fv('CV Sinar Abadi'), invoice_number: fv('INV-001'), date: fv('2026-03-12'), total: fv(1110000) },
      checks: [], decision: 'auto-clear',
    },
  ];
  return {
    version: 1, id: 'd1', kind: 'extract', title: 'Invoice', createdAt: '', updatedAt: '',
    sources: [], records, sections: [], styleOps: [], exports: [], citations: {},
    schema: {
      version: 1, approved: true, extractionTarget: 'per_doc',
      fields: [
        { name: 'vendor', type: 'string', required: true },
        { name: 'invoice_number', type: 'string', required: true },
        { name: 'date', type: 'date' },
        { name: 'total', type: 'money', required: true },
      ],
    },
  };
}

describe('answerDocumentQuestion (Fase C Q&A)', () => {
  test('"berapa total di invoice ini?" dijawab dari field total', () => {
    const a = answerDocumentQuestion(invoiceDoc(), 'berapa total di invoice ini?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('1.110.000');
    expect(a.source?.field).toBe('total');
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  test('alias: "nomor fakturnya berapa?" → invoice_number', () => {
    const a = answerDocumentQuestion(invoiceDoc(), 'nomor fakturnya berapa?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('INV-001');
    expect(a.source?.field).toBe('invoice_number');
  });

  test('alias: "siapa vendornya?" → vendor', () => {
    const a = answerDocumentQuestion(invoiceDoc(), 'siapa vendornya?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('CV Sinar Abadi');
  });

  test('"kapan tanggalnya?" → date', () => {
    const a = answerDocumentQuestion(invoiceDoc(), 'kapan tanggalnya?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('2026-03-12');
  });

  test('JUJUR: pertanyaan di luar data → found:false, tanpa halusinasi', () => {
    const a = answerDocumentQuestion(invoiceDoc(), 'apa warna mobil direktur?');
    expect(a.found).toBe(false);
    expect(a.answer).toMatch(/tidak menemukan/);
    expect(a.confidence).toBe(0);
  });

  test('JUJUR: dokumen tanpa records → minta ekstraksi dulu', () => {
    const doc = invoiceDoc();
    doc.records = [];
    const a = answerDocumentQuestion(doc, 'berapa totalnya?');
    expect(a.found).toBe(false);
    expect(a.answer).toMatch(/ekstraksi/);
  });

  test('banyak record numerik + "berapa total" → dijumlahkan eksplisit', () => {
    const doc = invoiceDoc();
    doc.records.push({
      id: 'rec-2', sourceId: 'src-2',
      fields: { vendor: fv('PT Lain'), total: fv(890000) },
      checks: [], decision: 'auto-clear',
    });
    const a = answerDocumentQuestion(doc, 'berapa total semuanya?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('2 record');
    expect(a.answer).toContain('2.000.000');
  });

  test('banyak nilai berbeda tanpa agregasi → daftar nilai', () => {
    const doc = invoiceDoc();
    doc.records.push({
      id: 'rec-2', sourceId: 'src-2',
      fields: { vendor: fv('PT Lain'), total: fv(890000) },
      checks: [], decision: 'auto-clear',
    });
    const a = answerDocumentQuestion(doc, 'siapa saja vendornya?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('CV Sinar Abadi');
    expect(a.answer).toContain('PT Lain');
  });

  test('tanpa skema: nama field record tetap bisa dicocokkan', () => {
    const doc = invoiceDoc();
    doc.schema = undefined;
    const a = answerDocumentQuestion(doc, 'berapa totalnya?');
    expect(a.found).toBe(true);
    expect(a.answer).toContain('1.110.000');
  });
});
