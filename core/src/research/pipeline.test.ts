import { describe, expect, test } from 'vitest';
import {
  runResearchPipeline,
  executeStage,
  ResearchPipelineError,
  type ResearchFetchHooks,
  type ResearchPipelineInput,
} from './pipeline.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { ResearchPlan } from './types.ts';

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

function plan(): ResearchPlan {
  return {
    planId: 'p1',
    question: 'Apa itu Sinta?',
    language: 'id',
    subQuestions: [{ id: 'sq1', text: 'Apa itu Sinta Kemdikbud?' }],
    sourceStrategy: 'sumber resmi Kemdikbud',
    budget: { maxQueries: 4, maxSources: 8 },
    createdAt: '2026-10-12T00:00:00.000Z',
  };
}

const PAGE_TEXT = 'Portal resmi: Sinta memeringkat jurnal dari 1 sampai 6.';

function fetchHooks(): ResearchFetchHooks {
  return {
    async searchWeb() {
      return [{ url: 'https://sinta.kemdikbud.go.id/tentang', title: 'Tentang Sinta' }];
    },
    async fetchPage() {
      return { url: 'https://sinta.kemdikbud.go.id/tentang', status: 200, title: 'Tentang Sinta', text: PAGE_TEXT };
    },
  };
}

const EXTRACT_OK = JSON.stringify({
  claims: [{
    text: 'Sinta memeringkat jurnal dari 1 sampai 6.',
    sourceIds: ['s1'],
    excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
  }],
});

const SYNTH_OK = JSON.stringify({
  sections: [{ id: 'sec1', title: 'Gambaran Sinta', claimIds: ['c1'] }],
  conflicts: [],
  limitations: ['Hanya satu sumber ter-fetch dalam uji ini.'],
  summary: 'Sinta adalah indeks jurnal Indonesia dengan peringkat 1 sampai 6.',
});

describe('runResearchPipeline', () => {
  test('pipeline beku end-to-end menghasilkan laporan lolos gate', async () => {
    const provider = scriptedProvider({
      'extract atomic factual claims': EXTRACT_OK,
      'write a research report from VERIFIED claims': SYNTH_OK,
    });
    const progress: string[] = [];
    const { report, gate } = await runResearchPipeline({
      plan: plan(),
      provider,
      fetch: fetchHooks(),
      credibilityFetch: async () => null,
      onProgress: (stage, detail) => progress.push(`${stage}:${detail}`),
    });
    expect(gate.ok).toBe(true);
    expect(report.verification.gatePassed).toBe(true);
    expect(report.claims).toHaveLength(1);
    expect(report.sources).toHaveLength(1);
    expect(report.bibliography.apa).toHaveLength(1);
    expect(report.budget.sourcesFetched).toBe(1);
    // Urutan stage beku tercatat di progress.
    const stages = progress.map((p) => p.split(':')[0]);
    for (const s of ['execute', 'evidence', 'verify', 'synthesize', 'gate', 'compile']) {
      expect(stages).toContain(s);
    }
  });

  test('gagal total bila tidak ada sumber ter-fetch', async () => {
    const provider = scriptedProvider({});
    const fetch: ResearchFetchHooks = {
      async searchWeb() { return []; },
      async fetchPage() { return null; },
    };
    await expect(runResearchPipeline({ plan: plan(), provider, fetch })).rejects.toThrow(ResearchPipelineError);
  });

  test('klaim dengan angka tak terverifikasi di-drop, pipeline tetap mengembalikan laporan (tanpa 422)', async () => {
    // Ekstraksi mengeluarkan angka yang tidak ada di excerpt -> aturan 4:
    // klaim dicoret (aturan 7), laporan dikembalikan dengan claimsDropped.
    const provider = scriptedProvider({
      'extract atomic factual claims': JSON.stringify({
        claims: [{
          text: 'Sinta memeringkat jurnal dan 99% jurnal lolos seleksi.',
          sourceIds: ['s1'],
          excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
        }],
      }),
      'write a research report from VERIFIED claims': SYNTH_OK,
    });
    const { report } = await runResearchPipeline({ plan: plan(), provider, fetch: fetchHooks(), credibilityFetch: async () => null });
    expect(report.claims).toHaveLength(0);
    expect(report.verification.claimsDropped).toBe(1);
    expect(report.verification.gatePassed).toBe(true);
  });

  test('plan tak valid ditolak sebelum execute', async () => {
    const provider = scriptedProvider({});
    const bad = { ...plan(), subQuestions: [] };
    await expect(
      runResearchPipeline({ plan: bad, provider, fetch: fetchHooks() }),
    ).rejects.toThrow(ResearchPipelineError);
  });

  test('executeStage tidak pernah melebihi maxSources walau worker paralel race (live-test 2026-10-12)', async () => {
    const p = plan();
    p.budget = { maxQueries: 4, maxSources: 3 };
    p.subQuestions = [
      { id: 'sq1', text: 'q1' },
      { id: 'sq2', text: 'q2' },
    ];
    // 10 hit per query + fetch lambat agar worker benar-benar interleave di await.
    const fetch: ResearchFetchHooks = {
      async searchWeb() {
        return Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: `T${i}` }));
      },
      async fetchPage(url) {
        await new Promise((r) => setTimeout(r, 5));
        return { url, status: 200, title: 'T', text: PAGE_TEXT };
      },
    };
    const input: ResearchPipelineInput = { plan: p, provider: scriptedProvider({}), fetch };
    const sources = await executeStage(input, p);
    expect(sources.length).toBeLessThanOrEqual(3);
    expect(sources.length).toBeGreaterThan(0);
  });
});
