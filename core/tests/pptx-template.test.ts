import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PptxTemplateError,
  applyPptxTemplateTheme,
  deletePptxTemplate,
  exportDeckToPptx,
  extractPptxDesign,
  getPptxTemplate,
  listPptxTemplates,
  newDeck,
  readDeck,
  readPptxTemplateBackground,
  savePptxTemplate,
  validateDeck,
  writeDeck,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Emerald Gold">
  <a:themeElements>
    <a:clrScheme name="Emerald">
      <a:dk1><a:sysClr val="windowText" lastClr="101418"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="F7F3E8"/></a:lt1>
      <a:dk2><a:srgbClr val="20302A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E0CC"/></a:lt2>
      <a:accent1><a:srgbClr val="C59A46"/></a:accent1>
      <a:accent2><a:srgbClr val="2E7D5C"/></a:accent2>
      <a:accent3><a:srgbClr val="7FB069"/></a:accent3>
      <a:accent4><a:srgbClr val="E0B458"/></a:accent4>
      <a:accent5><a:srgbClr val="4C956C"/></a:accent5>
      <a:accent6><a:srgbClr val="8C6A2F"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Emerald">
      <a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;

function masterXml(bgInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:bg><p:bgPr>${bgInner}<a:effectLst/></p:bgPr></p:bg>
  <p:cSld><p:spTree/></p:cSld>
</p:sldMaster>`;
}

/** A 4x4 solid emerald (#0F2D1E) PNG — a dark master photo stand-in. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPg15WDIwbiOACRhAWhBERxUQAAAABJRU5ErkJggg==', 'base64');

async function syntheticPptx(kind: 'solid-bg' | 'image-bg'): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
</p:presentation>`);
  zip.file('ppt/theme/theme1.xml', THEME_XML);
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    masterXml(
      kind === 'solid-bg'
        ? '<a:solidFill><a:srgbClr val="0F2D1E"/></a:solidFill>'
        : '<a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
    ),
  );
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', MASTER_RELS);
  if (kind === 'image-bg') zip.file('ppt/media/image1.png', PNG_1PX);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractPptxDesign', () => {
  test('extracts theme colors, fonts, slide size, and a solid master background', async () => {
    const design = await extractPptxDesign(await syntheticPptx('solid-bg'));
    expect(design.backgroundColor).toBe('#0f2d1e');
    expect(design.backgroundImage).toBeUndefined();
    expect(design.theme.background).toBe('#0f2d1e');
    expect(design.theme.dark).toBe(true);
    expect(design.theme.text).toBe('#f7f3e8'); // lt1, the opposite pole of the dark master
    expect(design.theme.accent).toBe('#c59a46'); // accent1
    expect(design.theme.series).toEqual(['#c59a46', '#2e7d5c', '#7fb069', '#e0b458', '#4c956c', '#8c6a2f']);
    expect(design.theme.headingFont).toBe('Georgia');
    expect(design.theme.bodyFont).toBe('Verdana');
    expect(design.slideSize).toEqual({ cx: 12192000, cy: 6858000, label: '16:9' });
  });

  test('extracts a master background image with its bytes and samples its dark pole', async () => {
    const design = await extractPptxDesign(await syntheticPptx('image-bg'));
    expect(design.backgroundImage?.extension).toBe('.png');
    expect(Buffer.from(design.backgroundImage?.bytes ?? []).equals(PNG_1PX)).toBe(true);
    expect(design.backgroundSampled).toBe('#0f2d1e');
    // The sampled dark image — not the theme's light slot — decides the
    // pole: tokens pair light text with the emerald background.
    expect(design.theme.background).toBe('#0f2d1e');
    expect(design.theme.dark).toBe(true);
    expect(design.theme.text).toBe('#f7f3e8');
    expect(design.theme.accent).toBe('#c59a46');
  });

  test('rejects garbage and zip-without-presentation honestly', async () => {
    await expect(extractPptxDesign(Buffer.from('this is not a zip at all'))).rejects.toMatchObject({ code: 'not_a_pptx' });
    const zip = new JSZip();
    zip.file('readme.txt', 'hello');
    const notPptx = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(extractPptxDesign(notPptx)).rejects.toBeInstanceOf(PptxTemplateError);
    await expect(extractPptxDesign(notPptx)).rejects.toMatchObject({ code: 'not_a_pptx' });
  });

  test('a theme-less pptx still imports with per-field fallbacks, never a crash', async () => {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
    const bare = await zip.generateAsync({ type: 'nodebuffer' });
    const design = await extractPptxDesign(bare);
    expect(design.theme.background).toBe('#201f26'); // bundled General fallback
    expect(design.theme.accent).toBe('#6b50ff');
    expect(design.slideSize).toBeUndefined();
  });
});

describe('pptx template store', () => {
  test('save → list → get → apply → delete round trip (solid background)', async () => {
    const root = temp('daedalus-ppttpl-');
    const bytes = await syntheticPptx('solid-bg');
    const saved = await savePptxTemplate(root, { fileName: 'Emerald Gold.pptx', bytes });
    expect(saved.id).toBe('emerald-gold');
    expect(saved.name).toBe('Emerald Gold');
    expect(existsSync(join(root, '.daedalus', 'slide-templates', 'emerald-gold.json'))).toBe(true);

    const list = await listPptxTemplates(root);
    expect(list.map((t) => t.id)).toEqual(['emerald-gold']);
    expect((await getPptxTemplate(root, 'emerald-gold'))?.theme.accent).toBe('#c59a46');

    const { theme } = await applyPptxTemplateTheme(root, 'emerald-gold');
    expect(theme.customTemplateId).toBe('emerald-gold');
    expect(theme.templateId).toBeUndefined();
    expect(theme.background).toBe('#0f2d1e');
    expect(theme.backgroundImage).toBeUndefined();

    expect(await deletePptxTemplate(root, 'emerald-gold')).toBe(true);
    expect(await listPptxTemplates(root)).toEqual([]);
    expect(await deletePptxTemplate(root, 'emerald-gold')).toBe(false);
  });

  test('image background is stored beside the JSON and copied into deck/assets on apply', async () => {
    const root = temp('daedalus-ppttpl-img-');
    const saved = await savePptxTemplate(root, { fileName: 'Photo Deck.pptx', bytes: await syntheticPptx('image-bg') });
    expect(saved.backgroundImageFile).toBe('photo-deck.background.png');
    const stored = await readPptxTemplateBackground(root, 'photo-deck');
    expect(stored?.bytes.equals(PNG_1PX)).toBe(true);

    const { theme } = await applyPptxTemplateTheme(root, 'photo-deck');
    expect(theme.backgroundImage).toBe('template-bg-photo-deck.png');
    const copied = readFileSync(join(root, 'deck', 'assets', 'template-bg-photo-deck.png'));
    expect(copied.equals(PNG_1PX)).toBe(true);

    await deletePptxTemplate(root, 'photo-deck');
    expect(existsSync(join(root, '.daedalus', 'slide-templates', 'photo-deck.background.png'))).toBe(false);
  });

  test('the same file uploaded again refreshes its record in place — same id, no duplicate card; non-pptx names refused', async () => {
    const root = temp('daedalus-ppttpl-dup-');
    const bytes = await syntheticPptx('solid-bg');
    const first = await savePptxTemplate(root, { fileName: 'Deck.pptx', bytes });
    const second = await savePptxTemplate(root, { fileName: 'Deck.pptx', bytes });
    expect(first.id).toBe('deck');
    expect(second.id).toBe('deck');
    expect(second.createdAt).toBe(first.createdAt);
    expect((await listPptxTemplates(root)).map((t) => t.id)).toEqual(['deck']);
    await expect(savePptxTemplate(root, { fileName: 'Deck.pdf', bytes })).rejects.toMatchObject({ code: 'not_a_pptx' });
  });

  test('a different file whose name slugs to the same id still gets a suffixed id, never a clobber', async () => {
    const root = temp('daedalus-ppttpl-collision-');
    const bytes = await syntheticPptx('solid-bg');
    const first = await savePptxTemplate(root, { fileName: 'Deck.pptx', bytes });
    const second = await savePptxTemplate(root, { fileName: 'Deck!.pptx', bytes });
    expect(first.id).toBe('deck');
    expect(second.id).toBe('deck-2');
    expect((await listPptxTemplates(root)).map((t) => t.id).sort()).toEqual(['deck', 'deck-2']);
    // …and re-uploading THAT file refreshes deck-2 in place, not deck.
    const third = await savePptxTemplate(root, { fileName: 'Deck!.pptx', bytes });
    expect(third.id).toBe('deck-2');
    expect((await listPptxTemplates(root))).toHaveLength(2);
  });

  test('skin-only imports report hasSource false (no source .pptx is kept when no pages parse)', async () => {
    const root = temp('daedalus-ppttpl-hassource-');
    const saved = await savePptxTemplate(root, { fileName: 'Emerald Gold.pptx', bytes: await syntheticPptx('solid-bg') });
    expect(saved.pages).toBeUndefined();
    expect(saved.hasSource).toBe(false);
    expect((await listPptxTemplates(root))[0]?.hasSource).toBe(false);
    expect((await getPptxTemplate(root, saved.id))?.hasSource).toBe(false);
  });
});

describe('custom-template decks render and export', () => {
  test('exported slides carry the extracted palette, fonts, series, and solid background', async () => {
    const root = temp('daedalus-ppttpl-export-');
    const saved = await savePptxTemplate(root, { fileName: 'Emerald Gold.pptx', bytes: await syntheticPptx('solid-bg') });
    const { theme } = await applyPptxTemplateTheme(root, saved.id);

    const deck = newDeck('Deck Zamrud');
    deck.theme = theme;
    deck.slides.push(
      { id: 's1', layout: 'title', content: { title: 'Judul Zamrud', subtitle: 'Palet impor' } },
      { id: 's2', layout: 'chart-bar', content: { title: 'Angka', data: [{ label: 'Jan', value: 10 }, { label: 'Feb', value: 25 }] } },
    );
    expect(validateDeck(deck, { root }).filter((i) => i.severity === 'error')).toEqual([]);
    await writeDeck(root, deck);

    const result = await exportDeckToPptx(deck, root);
    const out = await JSZip.loadAsync(readFileSync(join(root, result.relativePath)));
    const slide1 = await out.file('ppt/slides/slide1.xml')?.async('string');
    expect(slide1).toContain('0F2D1E'); // extracted master background
    expect(slide1).toContain('F7F3E8'); // extracted text pole
    const chartFiles = Object.keys(out.files).filter((p) => p.startsWith('ppt/charts/') || p.startsWith('ppt/embeddings/') || p.includes('chart'));
    let chartXml = '';
    for (const path of chartFiles) {
      const content = await out.file(path)?.async('string');
      if (content) chartXml += content;
    }
    expect(chartXml).toContain('2E7D5C'); // second series color from the extracted ramp
    const back = await readDeck(root);
    expect(back?.theme.customTemplateId).toBe('emerald-gold');
  });

  test('an applied background image is embedded into the exported slides', async () => {
    const root = temp('daedalus-ppttpl-export-img-');
    const saved = await savePptxTemplate(root, { fileName: 'Photo Deck.pptx', bytes: await syntheticPptx('image-bg') });
    const { theme } = await applyPptxTemplateTheme(root, saved.id);
    const deck = newDeck('Deck Foto');
    deck.theme = theme;
    deck.slides.push({ id: 's1', layout: 'bullets', content: { title: 'Isi', points: ['satu', 'dua'] } });
    await writeDeck(root, deck);

    const result = await exportDeckToPptx(deck, root);
    const out = await JSZip.loadAsync(readFileSync(join(root, result.relativePath)));
    const media = Object.keys(out.files).filter((p) => p.startsWith('ppt/media/') && !out.files[p]?.dir);
    expect(media.length).toBeGreaterThan(0);
    const slide1 = await out.file('ppt/slides/slide1.xml')?.async('string');
    expect(slide1).toContain('blipFill'); // the background paints as a blip fill
  });
});
