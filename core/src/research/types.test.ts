import { describe, expect, test } from 'vitest';
import { validateResearchPlan, validateResearchReport } from './types.ts';

function validSource() {
  return {
    id: 's1',
    url: 'https://example.com/a',
    title: 'Contoh Artikel',
    authors: ['Budi Santoso'],
    year: 2024,
    fetchedAt: '2026-10-12T00:00:00.000Z',
    credibility: { tier: 'web', verified: false },
  };
}

function validReport() {
  return {
    reportId: 'r1',
    question: 'Apa itu Sinta?',
    language: 'id',
    sections: [{ id: 'sec1', title: 'Gambaran', claimIds: ['c1'] }],
    claims: [{
      id: 'c1',
      text: 'Sinta memeringkat jurnal 1 sampai 6.',
      sourceIds: ['s1'],
      excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
      confidence: 'moderate',
      status: 'verified',
    }],
    sources: [validSource()],
    conflicts: [],
    limitations: ['Sumber terbatas pada yang ter-fetch.'],
    summary: 'Sinta adalah indeks jurnal Indonesia.',
    bibliography: { apa: ['Santoso, B. (2024). Contoh Artikel. https://example.com/a'], ieee: ['[1] B. Santoso, "Contoh Artikel," 2024.'] },
    budget: { queriesUsed: 2, sourcesFetched: 1 },
    verification: { claimsVerified: 1, claimsDropped: 0, gatePassed: true },
  };
}

describe('validateResearchReport', () => {
  test('accepts a well-formed report', () => {
    const v = validateResearchReport(validReport());
    expect(v.ok).toBe(true);
  });

  test('rejects a claim whose sourceId is unknown', () => {
    const r = validReport();
    (r.claims[0] as { sourceIds: string[] }).sourceIds = ['s9'];
    const v = validateResearchReport(r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.join(' ')).toContain('s9');
  });

  test('rejects an invalid credibility tier', () => {
    const r = validReport();
    (r.sources[0] as { credibility: { tier: string; verified: boolean } }).credibility = { tier: 'nobel', verified: true };
    const v = validateResearchReport(r);
    expect(v.ok).toBe(false);
  });

  test('rejects empty claims array type errors and bad language', () => {
    const r = validReport() as Record<string, unknown>;
    r.language = 'jp';
    const v = validateResearchReport(r);
    expect(v.ok).toBe(false);
  });

  test('rejects section referencing unknown claim', () => {
    const r = validReport();
    r.sections[0]!.claimIds = ['c99'];
    const v = validateResearchReport(r);
    expect(v.ok).toBe(false);
  });
});

describe('validateResearchPlan', () => {
  test('accepts a well-formed plan and clamps budget', () => {
    const v = validateResearchPlan({
      question: 'Bandingkan framework X dan Y',
      language: 'id',
      subQuestions: [{ id: 'sq1', text: 'Apa itu X?' }, { id: 'sq2', text: 'Apa itu Y?' }],
      sourceStrategy: 'web umum',
      budget: { maxQueries: 99, maxSources: 200 },
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.budget.maxQueries).toBeLessThanOrEqual(12);
      expect(v.value.budget.maxSources).toBeLessThanOrEqual(30);
    }
  });

  test('rejects empty subQuestions', () => {
    const v = validateResearchPlan({
      question: 'Q', language: 'id', subQuestions: [], sourceStrategy: 'web',
    });
    expect(v.ok).toBe(false);
  });
});
