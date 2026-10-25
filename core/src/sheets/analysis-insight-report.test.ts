import { describe, expect, test } from 'vitest';
import {
  synthesizeInsightReport,
  toComputedMetrics,
  validateInsightReport,
  type ComputedMetric,
} from './insight-report.ts';
import { evaluateWorkbook } from './evaluator.ts';
import { formatCellRef } from './workbook.ts';
import { newSheet, newWorkbook } from './store.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { VerifyReport } from './workbook.ts';

function computed(): ComputedMetric[] {
  return [
    { metricId: 'total', label: 'Total Pendapatan', value: '21,000', cellRef: 'Ringkasan!B2' },
    { metricId: 'rata2', label: 'Rata-rata Biaya', value: '1,050', cellRef: 'Ringkasan!B3' },
  ];
}

function okVerify(): VerifyReport {
  return {
    at: new Date().toISOString(),
    path: 'core',
    ok: true,
    formulasChecked: 2,
    unsupported: 0,
    errors: [],
    warnings: [],
    summary: 'Verify (core): 2 formula dievaluasi di core · 0 error',
  };
}

function scriptedReportProvider(content: string, seen: string[]): LLMProvider {
  return {
    name: 'fake',
    async chat(messages: Message[]) {
      seen.push(String(messages[0]?.content ?? ''));
      return { message: { role: 'assistant', content } };
    },
  } as unknown as LLMProvider;
}

describe('validateInsightReport', () => {
  test('accepts grounded findings and recommendations', () => {
    const verdict = validateInsightReport(
      {
        findings: [{ text: 'Total pendapatan mencapai 21,000 dengan rata-rata biaya 1,050.', refs: ['Ringkasan!B2', 'Ringkasan!B3'] }],
        recommendations: ['Pertahankan kanal dengan kontribusi terbesar.'],
      },
      computed(),
    );
    expect(verdict.ok).toBe(true);
  });

  test('rejects refs outside the computed cells', () => {
    const verdict = validateInsightReport(
      { findings: [{ text: 'Total pendapatan 21,000.', refs: ['Ringkasan!B9'] }], recommendations: [] },
      computed(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('Ringkasan!B9');
  });

  test('rejects numbers in prose that are not computed values', () => {
    const verdict = validateInsightReport(
      { findings: [{ text: 'Total pendapatan 21,000, naik 5% dari target.', refs: ['Ringkasan!B2'] }], recommendations: [] },
      computed(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('angka');
  });

  test('rejects numbers invented in recommendations', () => {
    const verdict = validateInsightReport(
      {
        findings: [{ text: 'Total pendapatan 21,000.', refs: ['Ringkasan!B2'] }],
        recommendations: ['Kejar target 50,000 bulan depan.'],
      },
      computed(),
    );
    expect(verdict.ok).toBe(false);
  });

  test('percent-form numbers match their computed decimal', () => {
    const withPct: ComputedMetric[] = [{ metricId: 'm', label: 'Margin', value: '12.0%', cellRef: 'Ringkasan!B2' }];
    const verdict = validateInsightReport(
      { findings: [{ text: 'Margin tercatat 12%.', refs: ['Ringkasan!B2'] }], recommendations: [] },
      withPct,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('toComputedMetrics', () => {
  test('resolves evaluated display values after verify', () => {
    const wb = newWorkbook('t', { createdBy: 'test' });
    const data = newSheet('Data');
    data.cells['A1'] = { v: 'N', bold: true };
    data.cells['A2'] = { v: 10 };
    data.cells['A3'] = { v: 20 };
    const ring = newSheet('Ringkasan');
    ring.cells['A1'] = { v: 'Metrik', bold: true };
    ring.cells['A2'] = { v: 'Total' };
    ring.cells['B2'] = { f: '=SUM(Data!A2:A3)', fmt: '#,##0' };
    wb.sheets.push(data, ring);
    const evaluation = evaluateWorkbook(wb);
    const out = toComputedMetrics(wb, evaluation, [{ metricId: 'total', label: 'Total', cellRef: 'Ringkasan!B2' }]);
    expect(out).toEqual([{ metricId: 'total', label: 'Total', cellRef: 'Ringkasan!B2', value: '30' }]);
  });
});

describe('synthesizeInsightReport', () => {
  test('builds the report with engine-set metadata', async () => {
    const seen: string[] = [];
    const provider = scriptedReportProvider(
      JSON.stringify({
        findings: [{ text: 'Total pendapatan mencapai 21,000.', refs: ['Ringkasan!B2'] }],
        recommendations: ['Fokus pada kanal Online.'],
      }),
      seen,
    );
    const report = await synthesizeInsightReport(
      provider,
      {
        question: 'Berapa total pendapatan?',
        plan: { question: 'q', metrics: [], groupBys: [], comparisons: [], charts: [], assumptions: [], steps: [] },
        computed: computed(),
        verify: okVerify(),
      },
    );
    expect(report.question).toBe('Berapa total pendapatan?');
    expect(report.findings).toHaveLength(1);
    expect(report.verifySummary).toContain('Verify (core)');
    expect(new Date(report.verifiedAt).toString()).not.toBe('Invalid Date');
    expect(seen[0]).toContain('insight section');
  });

  test('retries invalid model JSON, then throws without fabricating', async () => {
    const seen: string[] = [];
    const provider = scriptedReportProvider('{"findings": []}', seen);
    await expect(
      synthesizeInsightReport(provider, { question: 'q', plan: { question: 'q', metrics: [], groupBys: [], comparisons: [], charts: [], assumptions: [], steps: [] }, computed: computed(), verify: okVerify() }),
    ).rejects.toThrow(/invalid after 3 attempts/);
    expect(seen).toHaveLength(3);
  });
});
