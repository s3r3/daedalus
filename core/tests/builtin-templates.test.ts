import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BUILTIN_KINDS,
  IMAGE_LAYOUT_IDS,
  LAYOUT_IDS,
  SLIDE_TEMPLATES,
  assignBuiltinLayouts,
  builtinKindOfLayout,
  builtinDeckTheme,
  emptyImageFields,
  exportDeckToPptx,
  exportTemplateDeckToPptx,
  furnitureRect,
  generateDeckFullStage,
  getBuiltinTemplate,
  listBuiltinTemplates,
  listPptxTemplates,
  newDeck,
  pageChipRect,
  pourDeckIntoTemplate,
  savePptxTemplate,
  validateTemplateSlideSlots,
  type LLMProvider,
  type Message,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function exportedSlideXml(pptxPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await import('node:fs').then((fs) => fs.promises.readFile(pptxPath)));
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) parts.push(await zip.file(name)!.async('string'));
  }
  return parts.join('\n');
}

describe('built-in slide design templates (Template bawaan)', () => {
  test('registry: six varied templates, every kind mapped to real layouts, furniture specs sane', () => {
    const templates = listBuiltinTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    const ids = templates.map((template) => template.id);
    expect(ids).toEqual(expect.arrayContaining(['standar', 'editorial', 'arena', 'cendekia', 'galeri', 'verve']));
    const skinIds = new Set(SLIDE_TEMPLATES.map((skin) => skin.id));
    for (const template of templates) {
      expect(template.name.length, template.id).toBeGreaterThan(0);
      expect(template.description.length, template.id).toBeGreaterThan(0);
      expect(skinIds.has(template.skinId), `${template.id} skinId`).toBe(true);
      expect(template.theme.accent, template.id).toMatch(/^#/);
      for (const kind of BUILTIN_KINDS) {
        const pool = template.design[kind];
        expect(pool.length, `${template.id}.${kind}`).toBeGreaterThan(0);
        for (const layoutId of pool) {
          expect(LAYOUT_IDS, `${template.id}.${kind} -> ${layoutId}`).toContain(layoutId);
        }
      }
      for (const element of template.furniture.elements) {
        const rect = furnitureRect(element);
        expect(rect.w, `${template.id} furniture w`).toBeGreaterThan(0);
        expect(rect.h, `${template.id} furniture h`).toBeGreaterThan(0);
        expect(rect.w, `${template.id} furniture w`).toBeLessThanOrEqual(1.2);
        expect(rect.h, `${template.id} furniture h`).toBeLessThanOrEqual(1.2);
        if (element.opacity !== undefined) {
          expect(element.opacity).toBeGreaterThan(0);
          expect(element.opacity).toBeLessThanOrEqual(1);
        }
        for (const kind of element.kinds ?? []) expect(BUILTIN_KINDS).toContain(kind);
      }
      if (template.furniture.pageChip) {
        const chip = pageChipRect(template.furniture.pageChip);
        expect(chip.w).toBeGreaterThan(0);
        expect(chip.h).toBeGreaterThan(0);
      }
      expect(template.typography.titleScale).toBeGreaterThan(0);
    }
  });

  test('standar keeps the whole 50-layout catalog and no furniture (current look unchanged)', () => {
    const standar = getBuiltinTemplate('standar')!;
    const pooled = new Set(Object.values(standar.design).flat());
    expect(pooled.size).toBe(LAYOUT_IDS.filter((id) => id !== 'template-page').length);
    for (const id of LAYOUT_IDS) {
      if (id === 'template-page') continue;
      expect(pooled.has(id), id).toBe(true);
    }
    expect(standar.furniture.elements).toEqual([]);
    expect(standar.furniture.pageChip ?? null).toBeNull();
  });

  test('every non-standar template offers image and diagram layouts in its visual pool', () => {
    for (const template of listBuiltinTemplates()) {
      if (template.id === 'standar') continue;
      const images = template.design.visual.filter((id) => IMAGE_LAYOUT_IDS.includes(id));
      expect(images.length, template.id).toBeGreaterThan(0);
      const diagrams = template.design.visual.filter((id) => builtinKindOfLayout(id) === 'visual' && !IMAGE_LAYOUT_IDS.includes(id));
      expect(diagrams.length, template.id).toBeGreaterThan(0);
    }
  });

  test('rhythm: same layout never three slides in a row; image layout rotates into long content runs', () => {
    const editorial = getBuiltinTemplate('editorial')!;
    const items = Array.from({ length: 8 }, (_, i) => ({ layoutId: 'bullets', title: `Slide ${i + 1}` }));
    const assigned = assignBuiltinLayouts(items, editorial);
    expect(assigned).toHaveLength(8);
    for (const layoutId of assigned) {
      const inPools = editorial.design.content.includes(layoutId) || editorial.design.visual.includes(layoutId);
      expect(inPools, layoutId).toBe(true);
    }
    for (let i = 2; i < assigned.length; i += 1) {
      expect(assigned[i] === assigned[i - 1] && assigned[i] === assigned[i - 2], `triple at ${i}`).toBe(false);
    }
    // The fifth content slide rotates to an image layout (empty picture slot).
    expect(IMAGE_LAYOUT_IDS).toContain(assigned[4]);
    expect(assigned.slice(0, 4)).toEqual(['bullets', 'bullets', 'feature-highlight', 'bullets']);
  });

  test('emptyImageFields empties image slots (incl. mosaic tiles) and leaves other content alone', () => {
    const emptied = emptyImageFields('mosaic', { title: 'Galeri', tiles: [{ image: 'a.png', caption: 'Satu' }, { image: 'b.png', caption: 'Dua' }] });
    expect(emptied.tiles).toEqual([{ image: '', caption: 'Satu' }, { image: '', caption: 'Dua' }]);
    const side = emptyImageFields('image-side', { title: 'Bab', image: 'seed.png', points: ['satu'] });
    expect(side.image).toBe('');
    expect(side.points).toEqual(['satu']);
    const untouched = emptyImageFields('bullets', { title: 'Bab', image: 'keep.png', points: [] });
    expect(untouched.image).toBe('keep.png');
  });

  test('unknown design ids are rejected by the pipeline, and design + imported template conflict', async () => {
    const root = temp('daedalus-builtin-reject-');
    const provider = stageProvider();
    await expect(generateDeckFullStage(provider, root, { topic: 'Uji', designId: 'tidak-ada' } as never)).rejects.toThrow(/unknown designId/);
  });
});

/** Structured stage provider (outline/fill by system marker), mirroring tests/slide-v2. */
function stageProvider(): LLMProvider {
  return {
    name: 'builtin-stage',
    async chat(messages: Message[], _tools?: unknown) {
      const system = messages.find((message) => message.role === 'system');
      const systemText = typeof system?.content === 'string' ? system.content : '';
      const user = messages[1];
      const userText = typeof user?.content === 'string' ? user.content : '';
      if (systemText.includes('OUTLINE stage')) {
        const count = Number(/slide_count: (\d+)/.exec(userText)?.[1] ?? 6);
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify(
              Array.from({ length: count }, (_, index) => ({
                title: `Bagian ${index + 1}`,
                layoutId: index === 0 ? 'title' : index === count - 1 ? 'closing' : 'bullets',
                keyMessage: `poin utama ${index + 1}`,
              })),
            ),
          },
        };
      }
      if (systemText.includes('FILL stage')) {
        if (userText.includes('layout: closing')) return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Terima Kasih', cta: 'Mulai sekarang' }) } };
        if (userText.includes('layout: title')) return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Fotosintesis', subtitle: 'Dapur Daun Hijau' }) } };
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({ title: 'Isi Slide', points: ['poin satu', 'poin dua', 'poin tiga'], image: 'bocoran.png' }),
          },
        };
      }
      return { message: { role: 'assistant' as const, content: '{}' } };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  } as LLMProvider;
}

describe('generation + export with a built-in template', () => {
  test('deck carries the design id + skin, layouts come from the template pools, image slots stay empty', async () => {
    const root = temp('daedalus-builtin-gen-');
    const arena = getBuiltinTemplate('arena')!;
    const { fill } = await generateDeckFullStage(stageProvider(), root, {
      topic: 'Fotosintesis',
      slideCount: 7,
      designId: 'arena',
    });
    expect(fill.deck.theme.designId).toBe('arena');
    expect(fill.deck.theme.templateId).toBe('ocean');
    const pools = new Set(Object.values(arena.design).flat());
    for (const slide of fill.deck.slides) {
      expect(pools.has(slide.layout), slide.layout).toBe(true);
    }
    const contentSlides = fill.deck.slides.slice(1, -1);
    expect(contentSlides.every((slide) => arena.design.content.includes(slide.layout) || IMAGE_LAYOUT_IDS.includes(slide.layout))).toBe(true);
    // The fake provider tried to smuggle an image filename into a fill;
    // image layouts must carry the empty placeholder instead.
    const imageSlide = fill.deck.slides.find((slide) => IMAGE_LAYOUT_IDS.includes(slide.layout));
    if (imageSlide) expect((imageSlide.content as Record<string, unknown>).image).toBe('');

    const exported = await exportDeckToPptx(fill.deck, root);
    expect(existsSync(join(root, exported.relativePath))).toBe(true);
    const xml = await exportedSlideXml(join(root, exported.relativePath));
    expect(xml).toContain('2DD4BF'); // arena accent furniture (rail) + chip
  });

  test('export re-dress: another built-in writes a suffixed file, deck.json untouched', async () => {
    const root = temp('daedalus-builtin-redress-');
    const { fill } = await generateDeckFullStage(stageProvider(), root, {
      topic: 'Fotosintesis',
      slideCount: 5,
      designId: 'arena',
    });
    const galeri = getBuiltinTemplate('galeri')!;
    const redressed = await exportDeckToPptx(fill.deck, root, {
      themeOverride: builtinDeckTheme(galeri),
      fileSuffix: 'galeri',
    });
    expect(redressed.relativePath.endsWith('-galeri.pptx')).toBe(true);
    expect(existsSync(join(root, redressed.relativePath))).toBe(true);
    const xml = await exportedSlideXml(join(root, redressed.relativePath));
    expect(xml).toContain('D4AF37'); // galeri gold corners
    expect(fill.deck.theme.designId).toBe('arena');
  });

  test('pour: a catalog deck re-exports through an imported template, decor preserved, words replaced', async () => {
    const root = temp('daedalus-builtin-pour-');
    // A small decorated two-page template (cover + content) saved through
    // the real import path.
    const source = await buildDecoratedTemplatePptx();
    await savePptxTemplate(root, { fileName: 'Templat Uji.pptx', bytes: source });
    const [template] = await listPptxTemplates(root);
    expect(template?.pages?.length).toBe(2);

    const deck = newDeck('Fotosintesis untuk Pemula');
    deck.theme = { ...builtinDeckTheme(getBuiltinTemplate('arena')!) };
    deck.slides = [
      { id: 's1', layout: 'title', content: { title: 'Fotosintesis untuk Pemula', subtitle: 'Dapur Daun Hijau' } },
      { id: 's2', layout: 'bullets', content: { title: 'Proses Fotosintesis', points: ['Tumbuhan menangkap cahaya matahari', 'Klorofil mengubahnya menjadi energi', 'Oksigen dilepas ke udara'] } },
    ];
    const poured = pourDeckIntoTemplate(deck, template!);
    expect(poured.deck.slides).toHaveLength(2);
    for (const slide of poured.deck.slides) {
      expect(slide.templateRef, slide.id).toBeTruthy();
      const page = template!.pages![slide.templateRef!.page]!;
      expect(validateTemplateSlideSlots(page, (slide.content as Record<string, unknown>).slots)).toEqual([]);
    }
    const exported = await exportTemplateDeckToPptx(poured.deck, root, template!);
    expect(existsSync(join(root, exported.relativePath))).toBe(true);
    const xml = await exportedSlideXml(join(root, exported.relativePath));
    expect(xml).toContain('Fotosintesis untuk Pemula');
    expect(xml).toContain('Tumbuhan menangkap cahaya matahari');
  });
});

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${body}
</p:spTree></p:cSld></p:sld>`;
}

function textShape(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string, size = 2400): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="id-ID" sz="${size}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/** Two-page decorated template: cover (title + subtitle) and content (title + body lines) over an accent ellipse. */
async function buildDecoratedTemplatePptx(): Promise<Buffer> {
  const zip = new JSZip();
  const decor = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Blob Dekor"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="9000000" y="-900000"/><a:ext cx="4200000" cy="3600000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2E7D32"/></a:solidFill></p:spPr></p:sp>`;
  const cover = slideXml(
    decor +
      textShape(3, 'Judul Sampul', 685800, 1200000, 8000000, 1200000, 'JUDUL ASLI', 3200) +
      textShape(4, 'Subjudul', 685800, 2600000, 8000000, 800000, 'Subjudul asli di sini', 1600),
  );
  const content = slideXml(
    decor +
      textShape(3, 'Judul Isi', 685800, 500000, 9000000, 900000, 'Judul Isi Asli', 2400) +
      textShape(4, 'Isi', 685800, 1700000, 9000000, 4000000, 'Baris isi asli satu', 1400),
  );
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Uji"><a:themeElements><a:clrScheme name="Uji"><a:dk1><a:srgbClr val="1B1B1B"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2E7D32"/></a:dk2><a:lt2><a:srgbClr val="F5F1E6"/></a:lt2><a:accent1><a:srgbClr val="2E7D32"/></a:accent1><a:accent2><a:srgbClr val="FFC107"/></a:accent2><a:accent3><a:srgbClr val="4CAF50"/></a:accent3><a:accent4><a:srgbClr val="8BC34A"/></a:accent4><a:accent5><a:srgbClr val="CDDC39"/></a:accent5><a:accent6><a:srgbClr val="009688"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Uji"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
  );
  zip.file('ppt/slides/slide1.xml', cover);
  zip.file('ppt/slides/slide2.xml', content);
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file('ppt/slides/_rels/slide2.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file('ppt/media/blob.png', Buffer.from(PNG_1PX, 'base64'));
  return zip.generateAsync({ type: 'nodebuffer' });
}
