import { describe, expect, test } from 'vitest';
import { buildBibliography, exportBibtex, exportRis, formatApa, formatIeee } from './bibliography.ts';
import type { ResearchSource } from './types.ts';

function source(): ResearchSource {
  return {
    id: 's1',
    url: 'https://example.com/a',
    title: 'Contoh Artikel',
    authors: ['Budi Santoso', 'Ani Wijaya'],
    year: 2024,
    doi: '10.1234/contoh',
    fetchedAt: '2026-10-12T00:00:00.000Z',
    credibility: { tier: 'sinta2', verified: true, detail: 'Sinta 2 — sinta.kemdikbud.go.id' },
  };
}

describe('bibliography', () => {
  test('APA memuat penulis, tahun, judul, DOI', () => {
    const apa = formatApa(source());
    expect(apa).toContain('Santoso');
    expect(apa).toContain('(2024)');
    expect(apa).toContain('Contoh Artikel');
    expect(apa).toContain('https://doi.org/10.1234/contoh');
  });

  test('IEEE bernomor dan memuat [Online]', () => {
    const ieee = formatIeee(source(), 1);
    expect(ieee.startsWith('[1]')).toBe(true);
    expect(ieee).toContain('[Online]');
  });

  test('buildBibliography untuk N sumber', () => {
    const b = buildBibliography([source(), { ...source(), id: 's2' }]);
    expect(b.apa).toHaveLength(2);
    expect(b.ieee).toHaveLength(2);
    expect(b.ieee[1]!.startsWith('[2]')).toBe(true);
  });

  test('BibTeX valid untuk Zotero/Mendeley', () => {
    const bib = exportBibtex([source()]);
    expect(bib).toContain('@misc{');
    expect(bib).toContain('author = {Budi Santoso and Ani Wijaya}');
    expect(bib).toContain('doi = {10.1234/contoh}');
  });

  test('RIS valid untuk Zotero/Mendeley', () => {
    const ris = exportRis([source()]);
    expect(ris).toContain('TY  - ELEC');
    expect(ris).toContain('AU  - Budi Santoso');
    expect(ris).toContain('DO  - 10.1234/contoh');
    expect(ris.trimEnd().endsWith('ER  -')).toBe(true);
  });

  test('tanpa penulis/tahun tetap terformat', () => {
    const s = { ...source(), authors: undefined, year: undefined, doi: undefined };
    expect(formatApa(s)).toContain('(t.t.)');
    expect(formatApa(s)).toContain('https://example.com/a');
  });
});
