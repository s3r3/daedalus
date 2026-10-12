import { describe, expect, test } from 'vitest';
import { runVerifyGate, type EvidenceEntry, type VerifyGateInput } from './verify.ts';
import type { ResearchReport } from './types.ts';

function evidenceFor(content: string): Map<string, EvidenceEntry> {
  return new Map([
    ['s1', { sourceId: 's1', url: 'https://example.com/a', status: 200, content }],
    ['s2', { sourceId: 's2', url: 'https://example.com/b', status: 200, content: 'Sinta memeringkat jurnal dari 1 sampai 6 menurut Kemdikbud.' }],
  ]);
}

function baseReport(): ResearchReport {
  return {
    reportId: 'r1',
    question: 'Apa itu Sinta?',
    language: 'id',
    sections: [{ id: 'sec1', title: 'Gambaran', claimIds: ['c1'] }],
    claims: [{
      id: 'c1',
      text: 'Sinta memeringkat jurnal dari 1 sampai 6.',
      sourceIds: ['s1'],
      excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
      confidence: 'moderate',
      status: 'verified',
    }],
    sources: [
      {
        id: 's1', url: 'https://example.com/a', title: 'A',
        fetchedAt: '2026-10-12T00:00:00.000Z',
        credibility: { tier: 'web', verified: false },
      },
    ],
    conflicts: [],
    limitations: ['Terbatas.'],
    summary: 'Ringkasan.',
    bibliography: { apa: [], ieee: [] },
    budget: { queriesUsed: 2, sourcesFetched: 1 },
    verification: { claimsVerified: 0, claimsDropped: 0, gatePassed: false },
  };
}

function input(report: ResearchReport, evidence: Map<string, EvidenceEntry>): VerifyGateInput {
  return { report, evidence, budget: { maxQueries: 12, maxSources: 30 } };
}

describe('runVerifyGate', () => {
  test('aturan 1–6 lolos untuk laporan yang grounded', () => {
    const r = runVerifyGate(input(baseReport(), evidenceFor('Portal resmi: Sinta memeringkat jurnal dari 1 sampai 6.')));
    expect(r.ok).toBe(true);
    expect(r.claimsVerified).toBe(1);
    expect(r.report.verification.gatePassed).toBe(true);
  });

  test('aturan 1: klaim tanpa sourceId gagal (non-low)', () => {
    const report = baseReport();
    report.claims[0]!.sourceIds = [];
    const r = runVerifyGate(input(report, evidenceFor('x')));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 1)).toBe(true);
  });

  test('aturan 2: sumber tidak ter-fetch dalam run ini gagal', () => {
    const report = baseReport();
    const ev = new Map<string, EvidenceEntry>([
      ['s1', { sourceId: 's1', url: 'https://example.com/a', status: 404, content: 'tidak ada' }],
    ]);
    const r = runVerifyGate(input(report, ev));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 2)).toBe(true);
  });

  test('aturan 3: excerpt bukan substring gagal', () => {
    const report = baseReport();
    report.claims[0]!.excerpts = ['kalimat yang tidak ada di sumber sama sekali xyz'];
    const r = runVerifyGate(input(report, evidenceFor('Sinta memeringkat jurnal dari 1 sampai 6.')));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 3)).toBe(true);
  });

  test('aturan 4: angka di teks tanpa verbatim di excerpt -> klaim di-drop, bukan gate gagal', () => {
    const report = baseReport();
    report.claims[0]!.text = 'Sinta memeringkat jurnal dan 99% jurnal lolos.';
    report.claims[0]!.excerpts = ['Sinta memeringkat jurnal dari 1 sampai 6'];
    const r = runVerifyGate(input(report, evidenceFor('Sinta memeringkat jurnal dari 1 sampai 6. Dan 99% jurnal lolos seleksi.')));
    // 99% ada di konten tapi TIDAK di excerpt -> klaim dicoret (aturan 7),
    // laporan tetap lolos tanpa klaim tersebut.
    expect(r.ok).toBe(true);
    expect(r.claimsDropped).toBe(1);
    expect(r.report.claims).toHaveLength(0);
  });

  test('aturan 5: placeholder [CITATION NEEDED] gagal', () => {
    const report = baseReport();
    report.claims[0]!.text = 'Sinta memeringkat jurnal [CITATION NEEDED].';
    const r = runVerifyGate(input(report, evidenceFor('Sinta memeringkat jurnal dari 1 sampai 6.')));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 5)).toBe(true);
  });

  test('aturan 6: budget jebol gagal', () => {
    const report = baseReport();
    report.budget.queriesUsed = 99;
    const r = runVerifyGate(input(report, evidenceFor('Sinta memeringkat jurnal dari 1 sampai 6.')));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 6)).toBe(true);
  });

  test('aturan 7: klaim low tanpa sumber valid di-drop, gate tetap lolos', () => {
    const report = baseReport();
    report.claims[0]!.confidence = 'low';
    report.claims[0]!.sourceIds = [];
    const r = runVerifyGate(input(report, evidenceFor('x')));
    expect(r.ok).toBe(true);
    expect(r.claimsDropped).toBe(1);
    expect(r.report.claims).toHaveLength(0);
    expect(r.report.sections[0]!.claimIds).toHaveLength(0);
  });

  test('aturan 4: klaim dengan angka tak tercakup excerpt di-drop, gate tetap lolos (live-test 2026-10-12)', () => {
    const report = baseReport();
    // Model menulis "2026" padahal excerpt tidak memuatnya — klaim dicoret,
    // run tidak ikut gagal.
    report.claims[0]!.text = 'Sinta memeringkat jurnal dari 1 sampai 6 pada tahun 2026.';
    const r = runVerifyGate(input(report, evidenceFor('Sinta memeringkat jurnal dari 1 sampai 6.')));
    expect(r.ok).toBe(true);
    expect(r.claimsDropped).toBe(1);
    expect(r.report.claims).toHaveLength(0);
  });
});
