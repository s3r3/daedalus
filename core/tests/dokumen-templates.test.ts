import { describe, expect, test } from 'vitest';
import {
  DOCUMENT_TEMPLATES,
  getDocumentTemplate,
  listDocumentTemplates,
  templateOutlineSections,
} from '../src/index.ts';

/**
 * Fase C (desain 4.1): template dokumen bawaan — makalah, laporan,
 * proposal, surat resmi. Tiap template = daftar section dengan judul +
 * prompt isi; pilih template → kerangka otomatis terisi mengikuti template.
 */

describe('document templates (Fase C 4.1)', () => {
  test('exactly the 4 built-in templates exist, with unique ids', () => {
    const templates = listDocumentTemplates();
    expect(templates).toHaveLength(4);
    const ids = templates.map((t) => t.id).sort();
    expect(ids).toEqual(['laporan', 'makalah', 'proposal', 'surat-resmi']);
    expect(new Set(ids).size).toBe(4);
  });

  test('every template has name, description, and non-empty sections with title + content prompt', () => {
    for (const t of listDocumentTemplates()) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.sections.length).toBeGreaterThanOrEqual(5);
      for (const s of t.sections) {
        expect(s.title.trim().length).toBeGreaterThan(0);
        expect(s.contentPrompt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('makalah follows the academic structure (abstrak → daftar pustaka)', () => {
    const titles = getDocumentTemplate('makalah')!.sections.map((s) => s.title);
    expect(titles[0]).toMatch(/Judul/i);
    expect(titles).toContain('Abstrak');
    expect(titles).toContain('Pendahuluan');
    expect(titles).toContain('Penutup');
    expect(titles[titles.length - 1]).toMatch(/Pustaka/i);
  });

  test('surat resmi has the formal letter anatomy', () => {
    const titles = getDocumentTemplate('surat-resmi')!.sections.map((s) => s.title);
    expect(titles).toContain('Kop Surat');
    expect(titles).toContain('Alamat Tujuan');
    expect(titles).toContain('Tanda Tangan');
  });

  test('getDocumentTemplate returns undefined for unknown ids', () => {
    expect(getDocumentTemplate('skripsi')).toBeUndefined();
  });

  test('templateOutlineSections maps to the /dokumen/outline row shape', () => {
    const template = getDocumentTemplate('proposal')!;
    const rows = templateOutlineSections(template);
    expect(rows).toHaveLength(template.sections.length);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.title).toBe(template.sections[i]!.title);
      expect(rows[i]!.thesisPoints).toEqual([template.sections[i]!.contentPrompt]);
    }
  });

  test('DOCUMENT_TEMPLATES constant is not mutated by listDocumentTemplates callers', () => {
    const before = JSON.stringify(DOCUMENT_TEMPLATES);
    const listed = listDocumentTemplates();
    listed[0]!.sections[0]!.title = 'DIUBAH';
    expect(JSON.stringify(DOCUMENT_TEMPLATES)).toBe(before);
  });
});
