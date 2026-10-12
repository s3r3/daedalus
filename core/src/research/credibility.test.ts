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
});
