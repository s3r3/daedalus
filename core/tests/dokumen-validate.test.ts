import { describe, expect, test } from 'vitest';
import {
  isVerified,
  normalizeValue,
  parseDate,
  parseNumber,
  validateRecord,
  type DokumenSchema,
  type ExtractRecord,
  type FieldValue,
} from '../src/index.ts';

/**
 * Deterministic validation (design decision 4): the model reads, code
 * does the math. These tests pin the honesty rules — a wrong total is
 * FLAGGED (never silently passed), an unreadable value ESCALATES, a
 * missing total is DERIVED BY CODE and flagged, and the export gate
 * only lets verified records out.
 */

const invoiceSchema: DokumenSchema = {
  version: 1,
  approved: true,
  extractionTarget: 'per_doc',
  fields: [
    { name: 'vendor', type: 'string', required: true },
    { name: 'invoice_number', type: 'string', required: true },
    { name: 'date', type: 'date', required: true },
    { name: 'subtotal', type: 'money' },
    { name: 'tax', type: 'money' },
    { name: 'total', type: 'money', required: true },
  ],
};

function fv(value: FieldValue['value'], confidence = 0.95, extra: Partial<FieldValue> = {}): FieldValue {
  return { value, confidence, status: 'auto', ...extra };
}

function record(fields: Record<string, FieldValue>): ExtractRecord {
  return { id: 'rec-1', sourceId: 'src-1', fields, checks: [], decision: 'auto-clear' };
}

describe('parseNumber (Indonesian + US formats)', () => {
  test('parses thousand separators both ways', () => {
    expect(parseNumber('1.234.567')).toBe(1234567);
    expect(parseNumber('1,234,567')).toBe(1234567);
    expect(parseNumber('Rp 1.500.000,50')).toBe(1500000.5);
    expect(parseNumber('$1,234.56')).toBe(1234.56);
    expect(parseNumber('150000')).toBe(150000);
    expect(parseNumber('bukan angka')).toBeNull();
  });
});

describe('parseDate', () => {
  test('normalizes dd/mm/yyyy and Indonesian long dates to ISO', () => {
    expect(parseDate('12/03/2026')).toBe('2026-03-12');
    expect(parseDate('5 Oktober 2026')).toBe('2026-10-05');
    expect(parseDate('2026-01-31')).toBe('2026-01-31');
    expect(parseDate('kapan-kapan')).toBeNull();
  });
});

describe('validateRecord decisions', () => {
  test('clean invoice auto-clears and arithmetic check passes', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar Abadi'),
      invoice_number: fv('INV-001'),
      date: fv('12/03/2026'),
      subtotal: fv(1000000),
      tax: fv(110000),
      total: fv(1110000),
    }), invoiceSchema);
    expect(rec.decision).toBe('auto-clear');
    expect(rec.fields.date!.value).toBe('2026-03-12');
    expect(rec.checks.find((c) => c.rule === 'arithmetic-total')?.passed).toBe(true);
    expect(isVerified(rec)).toBe(true);
  });

  test('HONESTY: a total that contradicts the arithmetic is FLAGGED, never auto-cleared', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar Abadi'),
      invoice_number: fv('INV-002'),
      date: fv('2026-03-12'),
      subtotal: fv(1000000),
      tax: fv(110000),
      total: fv(999999), // model misread — code must catch it
    }), invoiceSchema);
    expect(rec.decision).toBe('flag');
    expect(rec.fields.total!.status).toBe('flagged');
    expect(rec.checks.find((c) => c.rule === 'arithmetic-total')?.passed).toBe(false);
    expect(isVerified(rec)).toBe(false);
  });

  test('a missing total is DERIVED BY CODE and flagged as derived (not read)', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar Abadi'),
      invoice_number: fv('INV-003'),
      date: fv('2026-03-12'),
      subtotal: fv(200000),
      tax: fv(22000),
      total: fv(null, 0),
    }), invoiceSchema);
    expect(rec.fields.total!.value).toBe(222000);
    expect(rec.fields.total!.status).toBe('flagged');
    expect(rec.fields.total!.note).toContain('diturunkan oleh kode');
    expect(rec.decision).toBe('flag');
  });

  test('HONESTY: an unreadable required value ESCALATES the whole record', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar Abadi'),
      invoice_number: fv('INV-004'),
      date: fv('2026-03-12'),
      subtotal: fv(100000),
      tax: fv(11000),
      total: { value: 'samar tidak terbaca', raw: 'samar tidak terbaca', confidence: 0.95, status: 'auto' },
    }), invoiceSchema);
    expect(rec.decision).toBe('escalate');
    expect(rec.fields.total!.status).toBe('escalated');
    expect(isVerified(rec)).toBe(false);
  });

  test('low-confidence reads escalate instead of passing silently', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar', 0.3),
      invoice_number: fv('INV-005', 0.95),
      date: fv('2026-03-12'),
      subtotal: fv(100000),
      tax: fv(11000),
      total: fv(111000),
    }), invoiceSchema);
    expect(rec.fields.vendor!.status).toBe('escalated');
    expect(rec.decision).toBe('escalate');
  });

  test('a human correction verifies a flagged record (export gate opens)', () => {
    const rec = validateRecord(record({
      vendor: fv('CV Sinar Abadi'),
      invoice_number: fv('INV-006'),
      date: fv('2026-03-12'),
      subtotal: fv(1000000),
      tax: fv(110000),
      total: fv(999999),
    }), invoiceSchema);
    expect(isVerified(rec)).toBe(false);
    rec.fields.total = { value: 1110000, confidence: 1, status: 'corrected', originalValue: 999999, note: 'dikoreksi pengguna' };
    expect(isVerified(rec)).toBe(true);
  });

  test('normalizeValue marks unparseable money as escalated with the raw text kept', () => {
    const out = normalizeValue({ type: 'money' }, { value: 'satu juta rupiah', confidence: 0.9, status: 'auto' });
    expect(out.value).toBeNull();
    expect(out.status).toBe('escalated');
    expect(out.raw).toBe('satu juta rupiah');
  });
});

describe('native PDF parsing (pdf.js worker resolution)', () => {
  test('a born-digital PDF yields text blocks with page + bbox provenance', async () => {
    const { parseSourceBytes, findProvenance } = await import('../src/index.ts');
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(new URL('./fixtures/tiny-invoice.pdf', import.meta.url));
    const parsed = await parseSourceBytes(bytes, '.pdf');
    expect(parsed.pages).toBe(1);
    expect(parsed.text).toContain('Invoice INV-7');
    const provenance = findProvenance(parsed, 'Total: Rp 42.000');
    expect(provenance?.page).toBe(1);
    expect(provenance?.bbox).toBeDefined();
    expect(provenance!.bbox![2]).toBeGreaterThan(10);
  });
});
