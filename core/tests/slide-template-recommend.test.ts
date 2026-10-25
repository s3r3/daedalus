import { describe, expect, test } from 'vitest';
import { recommendTemplate } from '../src/slides/template-recommend.ts';
import { listBuiltinTemplates } from '../src/slides/builtin-templates.ts';

const bullets = (title: string, points: string[] = ['a']) => ({
  layout: 'bullets',
  content: { title, points },
});

describe('recommendTemplate', () => {
  test('formal keywords recommend Naskah Cendekia', () => {
    const rec = recommendTemplate({
      title: 'Sidang Skripsi',
      slides: [bullets('Latar Belakang'), bullets('Metode Penelitian')],
    });
    expect(rec.templateId).toBe('cendekia');
    expect(rec.reason).toContain('sidang');
  });

  test('image-heavy outline recommends Galeri Mono', () => {
    const rec = recommendTemplate({
      title: 'Portofolio',
      slides: [
        { layout: 'image-side', content: { title: 'Karya 1', points: ['x'], image: 'a.png' } },
        { layout: 'hero-image-caption', content: { image: 'b.png', title: 'Karya 2', caption: 'c' } },
        bullets('Penutup'),
      ],
    });
    expect(rec.templateId).toBe('galeri');
    expect(rec.reason.length).toBeGreaterThan(0);
  });

  test('formal wins over image-heavy (sidang with photos)', () => {
    const rec = recommendTemplate({
      title: 'Sidang Skripsi',
      slides: [
        { layout: 'image-side', content: { title: 'Dokumentasi', points: ['x'], image: 'a.png' } },
        { layout: 'image-side', content: { title: 'Hasil', points: ['y'], image: 'b.png' } },
      ],
    });
    expect(rec.templateId).toBe('cendekia');
  });

  test('tech topic recommends Arena Neon', () => {
    const rec = recommendTemplate({
      title: 'Aplikasi Mobile Baru',
      slides: [bullets('Fitur'), bullets('Arsitektur Software')],
    });
    expect(rec.templateId).toBe('arena');
  });

  test('data-heavy outline recommends Editorial Klasik', () => {
    const rec = recommendTemplate({
      title: 'Laporan',
      slides: [
        { layout: 'chart-bar', content: { title: 'Tren', chart: {} } },
        { layout: 'table', content: { title: 'Data', table: {} } },
        { layout: 'stats', content: { title: 'Angka', stats: [] } },
      ],
    });
    expect(rec.templateId).toBe('editorial');
  });

  test('casual community topic recommends Verve Pop', () => {
    const rec = recommendTemplate({
      title: 'Workshop Komunitas',
      slides: [bullets('Jadwal'), bullets('Materi')],
    });
    expect(rec.templateId).toBe('verve');
  });

  test('plain topic falls back to Standar', () => {
    const rec = recommendTemplate({
      title: 'Rapat Rutin',
      slides: [bullets('Agenda')],
    });
    expect(rec.templateId).toBe('standar');
  });

  test('every recommended id is a real bundled design template', () => {
    const ids = new Set(listBuiltinTemplates().map((t) => t.id));
    const cases = [
      { title: 'Sidang Skripsi', slides: [bullets('A')] },
      { title: 'Portofolio', slides: [{ layout: 'mosaic', content: { title: 'A', tiles: [] } }, bullets('B')] },
      { title: '', slides: [] },
    ];
    for (const c of cases) {
      expect(ids.has(recommendTemplate(c).templateId)).toBe(true);
    }
  });
});
