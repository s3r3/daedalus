import { describe, expect, test } from 'vitest';
import {
  FORMULA_CATALOG,
  classifyAnalysisIntent,
  generateAnalysisPlan,
  validateAnalysisPlan,
  type AnalysisPlan,
} from './analysis-plan.ts';
import { profileSheet } from './analysis-profile.ts';
import { formatCellRef } from './workbook.ts';
import { newSheet } from './store.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { DatasetProfile } from './analysis-profile.ts';

/** Fake provider scripted by system-prompt marker. */
function scriptedProvider(responses: Record<string, string>): LLMProvider {
  return {
    name: 'fake',
    async chat(messages: Message[]) {
      const system = String(messages[0]?.content ?? '');
      const key = Object.keys(responses).find((k) => system.includes(k)) ?? '';
      return { message: { role: 'assistant', content: responses[key] ?? '{}' } };
    },
  } as unknown as LLMProvider;
}

function fixtureProfiles(): DatasetProfile[] {
  const sheet = newSheet('Data');
  ['Kanal', 'Pendapatan', 'Biaya'].forEach((h, i) => { sheet.cells[formatCellRef(i, 0)] = { v: h, bold: true }; });
  for (let i = 0; i < 10; i += 1) {
    sheet.cells[formatCellRef(0, i + 1)] = { v: i % 2 === 0 ? 'Online' : 'Toko' };
    sheet.cells[formatCellRef(1, i + 1)] = { v: (i + 1) * 100 };
    sheet.cells[formatCellRef(2, i + 1)] = { v: (i + 1) * 10 };
  }
  return [profileSheet(sheet)];
}

function validPlan(): Record<string, unknown> {
  return {
    question: 'Berapa total pendapatan per kanal?',
    metrics: [
      { id: 'total-pendapatan', label: 'Total Pendapatan', formulaTemplate: '=SUM(Data!B2:B11)', format: '#,##0' },
      { id: 'rata2-biaya', label: 'Rata-rata Biaya', formulaTemplate: '=AVERAGE(Data!C2:C11)' },
    ],
    groupBys: ['Kanal'],
    comparisons: ['Online vs Toko'],
    charts: [{ type: 'column', title: 'Pendapatan per Kanal', categoryField: 'Kanal', valueField: 'Pendapatan' }],
    assumptions: [{ name: 'Kurs', value: 16000 }],
    steps: ['Hitung total pendapatan', 'Kelompokkan per kanal'],
  };
}

describe('FORMULA_CATALOG', () => {
  test('covers the analysis basics named in the design', () => {
    const names = new Set(FORMULA_CATALOG.map((f) => f.name));
    for (const fn of ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'SUMIF', 'COUNTIF', 'MIN', 'MAX', 'IF', 'ROUND']) {
      expect(names.has(fn)).toBe(true);
    }
    expect(FORMULA_CATALOG.every((f) => ['number', 'text', 'boolean'].includes(f.returns))).toBe(true);
  });
});

describe('validateAnalysisPlan', () => {
  test('accepts a valid plan', () => {
    const verdict = validateAnalysisPlan(validPlan(), fixtureProfiles());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.metrics).toHaveLength(2);
      expect(verdict.value.groupBys).toEqual(['Kanal']);
    }
  });

  test('rejects unknown group-by column', () => {
    const plan = { ...validPlan(), groupBys: ['Wilayah'] };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('Wilayah');
  });

  test('rejects formula template without leading =', () => {
    const plan = { ...validPlan(), metrics: [{ id: 'm1', label: 'M', formulaTemplate: 'SUM(Data!B2:B11)' }] };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain("'='");
  });

  test('rejects duplicate metric ids', () => {
    const plan = {
      ...validPlan(),
      metrics: [
        { id: 'm1', label: 'A', formulaTemplate: '=SUM(Data!B2:B11)' },
        { id: 'M1', label: 'B', formulaTemplate: '=SUM(Data!C2:C11)' },
      ],
    };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ').toLowerCase()).toContain('duplikat');
  });

  test('rejects functions outside FORMULA_CATALOG', () => {
    const plan = { ...validPlan(), metrics: [{ id: 'm1', label: 'M', formulaTemplate: '=STDEV(Data!B2:B11)' }] };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('STDEV');
  });

  test('rejects refs to columns outside the profiled range', () => {
    const plan = { ...validPlan(), metrics: [{ id: 'm1', label: 'M', formulaTemplate: '=SUM(Data!Z2:Z11)' }] };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('Z');
  });

  test('rejects unknown chart fields', () => {
    const plan = { ...validPlan(), charts: [{ type: 'pie', title: 'X', categoryField: 'Kanal', valueField: 'Laba' }] };
    const verdict = validateAnalysisPlan(plan, fixtureProfiles());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.join(' ')).toContain('Laba');
  });

  test('accepts the {r} row placeholder and catalogued grouping formulas', () => {
    const plan = {
      ...validPlan(),
      metrics: [{ id: 'm1', label: 'M', formulaTemplate: '=SUMIF(Data!$A$2:$A$11,$A{r},Data!$B$2:$B$11)' }],
    };
    expect(validateAnalysisPlan(plan, fixtureProfiles()).ok).toBe(true);
  });
});

describe('classifyAnalysisIntent', () => {
  test('cheap call returns a complexity verdict', async () => {
    const provider = scriptedProvider({ 'classify the complexity': '{"complexity":"moderate"}' });
    const result = await classifyAnalysisIntent(provider, 'Berapa total pendapatan?', fixtureProfiles());
    expect(result).toEqual({ complexity: 'moderate' });
  });

  test('invalid JSON is retried then throws', async () => {
    const provider = scriptedProvider({});
    await expect(classifyAnalysisIntent(provider, 'q?', fixtureProfiles())).rejects.toThrow(/invalid after 3 attempts/);
  });
});

describe('generateAnalysisPlan', () => {
  test('emits a validated plan from the model JSON', async () => {
    const provider = scriptedProvider({ 'planner of an agentic spreadsheet analyst': JSON.stringify(validPlan()) });
    const plan: AnalysisPlan = await generateAnalysisPlan(provider, 'Berapa total pendapatan per kanal?', fixtureProfiles());
    expect(plan.metrics.map((m) => m.id)).toEqual(['total-pendapatan', 'rata2-biaya']);
    expect(plan.metrics[0]?.formulaTemplate.startsWith('=')).toBe(true);
  });
});
