import { describe, expect, test } from 'vitest';
import { assessCredibility, type CredibilityFetcher } from './credibility.ts';

function fakeFetch(routes: Record<string, { status: number; text: string }>): CredibilityFetcher {
  return async (url: string) => {
    for (const [prefix, res] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return res;
    }
    return null;
  };
}

describe('assessCredibility', () => {
  test('domain Garuda -> tier garuda, heuristic (verified false)', async () => {
    const c = await assessCredibility(
      { url: 'https://garuda.kemdikbud.go.id/documents/detail/123', title: 'X' },
      fakeFetch({}),
    );
    expect(c.tier).toBe('garuda');
    expect(c.verified).toBe(false);
  });

  test('Sinta rank dari halaman resmi -> verified true', async () => {
    const fetch = fakeFetch({
      'https://api.crossref.org': {
        status: 200,
        text: JSON.stringify({ message: { 'container-title': ['Jurnal Contoh'], ISSN: ['1234-5678'], publisher: 'UI' } }),
      },
      'https://sinta.kemdikbud.go.id': {
        status: 200,
        text: '<html><body>Jurnal Contoh ... Sinta 2 ...</body></html>',
      },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/a', title: 'Artikel', doi: '10.1/x' },
      fetch,
    );
    expect(c.tier).toBe('sinta2');
    expect(c.verified).toBe(true);
  });

  test('DOAJ via ISSN -> tier doaj verified true', async () => {
    const fetch = fakeFetch({
      'https://sinta.kemdikbud.go.id': { status: 200, text: '<html>tidak ada peringkat</html>' },
      'https://doaj.org': { status: 200, text: JSON.stringify({ total: 1, results: [{}] }) },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/b', title: 'Artikel', issn: '1234-5678' },
      fetch,
    );
    expect(c.tier).toBe('doaj');
    expect(c.verified).toBe(true);
  });

  test('default: web umum, tidak pernah klaim Scopus tanpa key', async () => {
    const c = await assessCredibility(
      { url: 'https://blog.example.com/post', title: 'Opini' },
      fakeFetch({}),
    );
    expect(c.tier).toBe('web');
    expect(c.verified).toBe(false);
    expect(c.tier).not.toBe('scopus');
  });

  test('fetch gagal total -> tetap web, tidak throw', async () => {
    const c = await assessCredibility(
      { url: 'https://example.com/x', title: 'X' },
      async () => { throw new Error('boom'); },
    );
    expect(c.tier).toBe('web');
  });

  test('SJR: kuartil Scopus dari scimagojr.com -> scopus-qN verified true', async () => {
    const fetch = fakeFetch({
      'https://www.scimagojr.com': {
        status: 200,
        text: '<html><body>Journal of Testing ISSN 1234-5678 SJR Quartiles: Q3 (2022), Q2 (2023)</body></html>',
      },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/c', title: 'Journal of Testing', issn: '1234-5678' },
      fetch,
    );
    expect(c.tier).toBe('scopus-q2');
    expect(c.verified).toBe(true);
    expect(c.detail).toContain('scimagojr.com');
  });

  test('SJR diblokir (Cloudflare) -> jatuh ke Sinta, bukan klaim palsu', async () => {
    const fetch = fakeFetch({
      'https://www.scimagojr.com': { status: 403, text: '<html><title>Just a moment...</title></html>' },
      'https://sinta.kemdikbud.go.id': { status: 200, text: '<html><body>Jurnal Contoh Sinta 3</body></html>' },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/d', title: 'Jurnal Contoh', issn: '1234-5678' },
      fetch,
    );
    expect(c.tier).toBe('sinta3');
    expect(c.verified).toBe(true);
  });

  test('SJR: halaman tak menyebut jurnal -> null, tidak false positive', async () => {
    const fetch = fakeFetch({
      'https://www.scimagojr.com': { status: 200, text: '<html><body>Random page Q1 quartile stuff</body></html>' },
      'https://sinta.kemdikbud.go.id': { status: 200, text: '<html>tidak ada peringkat</html>' },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/e', title: 'Zebra Quantum Review', issn: '9999-0000' },
      fetch,
    );
    expect(c.tier).toBe('web');
    expect(c.verified).toBe(false);
  });

  test('Elsevier API + key -> Scopus Q1 verified true (prioritas tertinggi)', async () => {
    const fetch = fakeFetch({
      'https://api.elsevier.com': {
        status: 200,
        text: JSON.stringify({
          'serial-metadata-response': {
            entry: [{
              'dc:title': 'Journal of Testing',
              'prism:issn': '1234-5678',
              subjectAreaList: { subjectArea: [{ quartile: 'Q1', $: 'Medicine' }] },
            }],
          },
        }),
      },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/f', title: 'Journal of Testing', issn: '1234-5678', elsevierApiKey: 'KEY' },
      fetch,
    );
    expect(c.tier).toBe('scopus-q1');
    expect(c.verified).toBe(true);
    expect(c.detail).toContain('api.elsevier.com');
  });

  test('Elsevier API: terindeks tapi kuartil tak ada -> tier scopus polos', async () => {
    const fetch = fakeFetch({
      'https://api.elsevier.com': {
        status: 200,
        text: JSON.stringify({
          'serial-metadata-response': { entry: [{ 'dc:title': 'Journal of Testing', 'prism:issn': '1234-5678' }] },
        }),
      },
    });
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/g', title: 'Journal of Testing', issn: '1234-5678', elsevierApiKey: 'KEY' },
      fetch,
    );
    expect(c.tier).toBe('scopus');
    expect(c.verified).toBe(true);
  });

  test('tanpa API key -> Elsevier tidak pernah dipanggil', async () => {
    let elsevierHit = false;
    const fetch: CredibilityFetcher = async (url: string) => {
      if (url.includes('api.elsevier.com')) elsevierHit = true;
      return null;
    };
    const c = await assessCredibility(
      { url: 'https://jurnal.example.id/h', title: 'Journal of Testing', issn: '1234-5678' },
      fetch,
    );
    expect(elsevierHit).toBe(false);
    expect(c.tier).toBe('web');
  });
});
