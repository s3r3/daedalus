import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORMULA_CATALOG,
  MAX_RECOMPUTE_ATTEMPTS,
  SUMMARY_SHEET_NAME,
  runAnalysisPipeline,
} from './analysis-pipeline.ts';
import { SheetPipelineError } from './pipeline.ts';
import { formatCellRef } from './workbook.ts';
import { newSheet, newWorkbook } from './store.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { AnalysisPlan } from './analysis-plan.ts';
import type { WorkbookSpec } from './workbook.ts';

/**
 * analysis-pipeline: the frozen stage order, the verify gate as the
 * only path to a report, and the DataInterpreter revise loop.
 */

const tmps: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-analis-test-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

/** 20-row sales dataset: Kanal | Pendapatan | Biaya. */
function dataset(): WorkbookSpec {
  const wb = newWorkbook('Penjualan', { createdBy: 'test' });
  wb.stage = 'ready';
  const data = newSheet('Data');
  ['Kanal', 'Pendapatan', 'Biaya'].forEach((h, i) => { data.cells[formatCellRef(i, 0)] = { v: h, bold: true }; });
  for (let i = 0; i < 20; i += 1) {
    data.cells[formatCellRef(0, i + 1)] = { v: i % 2 === 0 ? 'Online' : 'Toko' };
    data.cells[formatCellRef(1, i + 1)] = { v: (i + 1) * 100 };
    data.cells[formatCellRef(2, i + 1)] = { v: (i + 1) * 10 };
  }
  wb.sheets.push(data);
  return wb;
}

const TOTAL = Array.from({ length: 20 }, (_, i) => (i + 1) * 100).reduce((a, b) => a + b, 0); // 21000

function validPlan(): AnalysisPlan {
  return {
    question: 'Berapa total pendapatan per kanal?',
    metrics: [
      { id: 'total-pendapatan', label: 'Total Pendapatan', formulaTemplate: '=SUM(Data!B2:B21)', format: '#,##0' },
      { id: 'rata2-biaya', label: 'Rata-rata Biaya', formulaTemplate: '=AVERAGE(Data!C2:C21)' },
    ],
    groupBys: ['Kanal'],
    comparisons: [],
    charts: [{ type: 'column', title: 'Pendapatan per Kanal', categoryField: 'Kanal', valueField: 'Pendapatan' }],
    assumptions: [],
    steps: ['Hitung total pendapatan', 'Kelompokkan per kanal'],
  };
}

/** Fake provider: records system prompts; scripts repair vs report calls. */
function scriptedProvider(opts: { repair?: string; report?: string; seen: string[] }): LLMProvider {
  return {
    name: 'fake',
    async chat(messages: Message[]) {
      const system = String(messages[0]?.content ?? '');
      opts.seen.push(system);
      if (system.includes('repair an analysis plan')) return { message: { role: 'assistant', content: opts.repair ?? '{}' } };
      if (system.includes('insight section')) return { message: { role: 'assistant', content: opts.report ?? '{}' } };
      return { message: { role: 'assistant', content: '{}' } };
    },
  } as unknown as LLMProvider;
}

function reportJson(): string {
  return JSON.stringify({
    findings: [{ text: `Total pendapatan mencapai ${TOTAL.toLocaleString('en-US')}.`, refs: ['Ringkasan!B2'] }],
    recommendations: ['Pertahankan momentum kanal Online.'],
  });
}

describe('FORMULA_CATALOG re-export', () => {
  test('the pipeline exposes the catalog as its action-space bound', () => {
    expect(FORMULA_CATALOG.length).toBeGreaterThan(10);
    expect(new Set(FORMULA_CATALOG.map((f) => f.name)).has('SUMIF')).toBe(true);
  });
});

describe('runAnalysisPipeline happy path', () => {
  test('stages run in order: compute → verify → synthesize → export', async () => {
    const seen: string[] = [];
    const provider = scriptedProvider({ report: reportJson(), seen });
    const root = tempWorkspace();
    const result = await runAnalysisPipeline({ question: 'Berapa total pendapatan per kanal?', dataset: dataset(), plan: validPlan(), provider, workspaceRoot: root });

    // compute: Ringkasan sheet materialized with LIVE formulas, never frozen numbers
    const ring = result.workbook.sheets.find((s) => s.name === SUMMARY_SHEET_NAME);
    expect(ring).toBeDefined();
    expect(ring?.cells['B2']?.f).toBe('=SUM(Data!B2:B21)');
    expect(ring?.cells['A2']?.v).toBe('Total Pendapatan');
    // group block derived deterministically: SUM → SUMIF
    const groupFormulas = Object.values(ring?.cells ?? {}).map((c) => c.f).filter(Boolean);
    expect(groupFormulas.some((f) => f?.startsWith('=SUMIF('))).toBe(true);
    expect(groupFormulas.some((f) => f?.startsWith('=AVERAGEIF('))).toBe(true);
    expect(ring?.charts).toHaveLength(1);
    expect(ring?.charts?.[0]?.range).toContain('Ringkasan!');

    // verify: the gate ran on the computed sheet and passed
    expect(result.verify.ok).toBe(true);
    expect(result.verify.path).toBe('core');
    expect(result.verify.formulasChecked).toBeGreaterThan(0);

    // synthesize: only verified numbers reached the report (after verify)
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.refs).toEqual(['Ringkasan!B2']);
    expect(result.report.question).toBe('Berapa total pendapatan per kanal?');
    expect(result.report.verifiedAt >= result.verify.at).toBe(true);

    // export: xlsx written to the workspace
    expect(result.exported?.bytes).toBeGreaterThan(0);
    expect(existsSync(result.exported?.path ?? '')).toBe(true);
  });

  test('invalid staged plan throws before any model call', async () => {
    const seen: string[] = [];
    const provider = scriptedProvider({ seen });
    const bad = { ...validPlan(), groupBys: ['Wilayah'] };
    await expect(runAnalysisPipeline({ question: 'q', dataset: dataset(), plan: bad, provider, workspaceRoot: tempWorkspace() }))
      .rejects.toThrow(SheetPipelineError);
    expect(seen).toHaveLength(0);
  });
});

describe('verify failure: no report without a passing gate', () => {
  function brokenPlan(): AnalysisPlan {
    return {
      question: 'q',
      metrics: [{ id: 'm1', label: 'M', formulaTemplate: '=SUM(Hilang!B2:B21)' }],
      groupBys: [],
      comparisons: [],
      charts: [],
      assumptions: [],
      steps: ['hitung'],
    };
  }

  test('unfixable-after-retries → throws SheetPipelineError, synthesize never runs', async () => {
    const seen: string[] = [];
    const provider = scriptedProvider({ seen }); // repair returns '{}' → invalid 3x
    await expect(runAnalysisPipeline({ question: 'q', dataset: dataset(), plan: brokenPlan(), provider, workspaceRoot: tempWorkspace() }))
      .rejects.toThrow(SheetPipelineError);
    expect(seen.some((s) => s.includes('repair an analysis plan'))).toBe(true);
    expect(seen.some((s) => s.includes('insight section'))).toBe(false);
    expect(MAX_RECOMPUTE_ATTEMPTS).toBe(2);
  });

  test('DataInterpreter loop: fixable formula issue → revised spec → passing run', async () => {
    const seen: string[] = [];
    const fixed = JSON.stringify({
      ...brokenPlan(),
      metrics: [{ id: 'm1', label: 'M', formulaTemplate: '=SUM(Data!B2:B21)' }],
    });
    const provider = scriptedProvider({ repair: fixed, report: reportJson(), seen });
    const result = await runAnalysisPipeline({ question: 'q', dataset: dataset(), plan: brokenPlan(), provider, workspaceRoot: tempWorkspace() });
    expect(result.verify.ok).toBe(true);
    const ring = result.workbook.sheets.find((s) => s.name === SUMMARY_SHEET_NAME);
    expect(ring?.cells['B2']?.f).toBe('=SUM(Data!B2:B21)');
    expect(result.report.findings).toHaveLength(1);
    expect(seen.filter((s) => s.includes('repair an analysis plan'))).toHaveLength(1);
  });
});
