import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  deckPaths,
  exportDeckToPptx,
  extractPptxPages,
  fillDeckSlidesStage,
  generateDeckOutlineStage,
  getPptxTemplate,
  newDeck,
  pptxTemplatesDir,
  readDeck,
  savePptxTemplate,
  templatePageImageSlots,
  templatePageTextSlots,
  type LLMProvider,
  type Message,
  type Slide,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 1x1 emerald PNG — the template's original picture bytes. */
const PNG_ORIGINAL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** 1x1 red PNG — the user's clicked replacement inside the group. */
const PNG_CHOSEN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

const CX = 12192000;
const CY = 6858000;

function relsXml(entries: Array<[string, string, string]>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function slideXml(body: string, bg = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
}

function textShape(id: number, x: number, y: number, w: number, h: number, paras: string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T${id}"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${paras.join('')}</p:txBody></p:sp>`;
}

const run = (text: string, sz = 1400, extra = ''): string =>
  `<a:r><a:rPr sz="${sz}"${extra}><a:solidFill><a:srgbClr val="1E3D2F"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>${text}</a:t></a:r>`;

/**
 * The grouped info card, mirroring Farid's Roadmaps TOC page: the card
 * body + its two text shapes + a picture live inside ONE grpSp whose
 * child space is twice the slide box (scale 0.5), and a second group
 * nests inside it (group-in-group).
 *
 * Group G: off (0.1CX, 0.25CY), ext (0.6CX, 0.5CY), chOff (0,0),
 * chExt (1.2CX, 1.0CY) → child→slide scale 0.5 on both axes.
 */
const CARD_DECOR = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Kartu"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="243840" y="342900"/><a:ext cx="6096000" cy="1371600"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill></p:spPr></p:sp>`;
const CARD_TITLE = textShape(12, 487680, 514350, 5486400, 514350, [
  `<a:p>${run('Project ', 2000, ' b="1"')}${run('Progress A', 2000, ' b="1"')}</a:p>`,
]);
const CARD_BODY = textShape(13, 487680, 1028700, 5486400, 857250, [
  `<a:p>${run('Lorem ipsum dolor sit amet')}</a:p>`,
]);
const CARD_PIC = `<p:pic><p:nvPicPr><p:cNvPr id="14" name="IkonKartu"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="6400800" y="342900"/><a:ext cx="1219200" cy="1028700"/></a:xfrm></p:spPr></p:pic>`;
const INNER_TEXT = textShape(16, 182880, 182880, 3291840, 685800, [`<a:p>${run('Label Dalam')}</a:p>`]);
const INNER_GROUP = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="15" name="GrupDalam"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="7315200" y="2057400"/><a:ext cx="3657600" cy="1714500"/><a:chOff x="0" y="0"/><a:chExt cx="3657600" cy="1714500"/></a:xfrm></p:grpSpPr>${INNER_TEXT}</p:grpSp>`;
const GROUP_G = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="GrupKartu"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1219200" y="1714500"/><a:ext cx="7315200" cy="3429000"/><a:chOff x="0" y="0"/><a:chExt cx="14630400" cy="6858000"/></a:xfrm></p:grpSpPr>${CARD_DECOR}${CARD_TITLE}${CARD_BODY}${CARD_PIC}${INNER_GROUP}</p:grpSp>`;

/**
 * Four pages: cover, a TOC whose cards are grouped (Farid's case), a
 * content page whose picture sits in an identity group, closing.
 */
async function groupedPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${[1, 2, 3, 4].map((i) => `<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...[1, 2, 3, 4].map((i): [string, string, string] => [`rId${i + 1}`, 'slide', `slides/slide${i}.xml`])]));
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8F7FF"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Peta"><a:themeElements><a:clrScheme name="Peta"><a:dk1><a:srgbClr val="1E3D2F"/></a:dk1><a:lt1><a:srgbClr val="F8F7FF"/></a:lt1><a:dk2><a:srgbClr val="232323"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="4F46E5"/></a:accent1><a:accent2><a:srgbClr val="FACC15"/></a:accent2><a:accent3><a:srgbClr val="68D8B2"/></a:accent3><a:accent4><a:srgbClr val="2E5941"/></a:accent4><a:accent5><a:srgbClr val="FF6B9D"/></a:accent5><a:accent6><a:srgbClr val="7AC74F"/></a:accent6><a:hlink><a:srgbClr val="4F46E5"/></a:hlink><a:folHlink><a:srgbClr val="4F46E5"/></a:folHlink></a:clrScheme><a:fontScheme name="PetaFonts"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/media/image1.png', PNG_ORIGINAL);
  zip.file('ppt/media/image2.png', PNG_ORIGINAL);

  const cover = slideXml(
    textShape(2, 1219200, 2057400, 9753600, 1371600, [`<a:p>${run('Judul Sampel Lama', 4400, ' b="1"')}</a:p>`])
    + textShape(3, 2438400, 3771900, 7315200, 685800, [`<a:p>${run('Subjudul sampel', 1800)}</a:p>`]),
  );
  const tocTitle = textShape(2, 731520, 342900, 6096000, 822960, [`<a:p>${run('Daftar Isi', 3200, ' b="1"')}</a:p>`]);
  const toc = slideXml(tocTitle + GROUP_G);
  const contentGroup = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="GrupIsi"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6096000" y="1371600"/><a:ext cx="5486400" cy="4114800"/><a:chOff x="6096000" y="1371600"/><a:chExt cx="5486400" cy="4114800"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="21" name="FotoIsi"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="1371600"/><a:ext cx="5486400" cy="4114800"/></a:xfrm></p:spPr></p:pic></p:grpSp>`;
  const content = slideXml(
    textShape(2, 731520, 411480, 7315200, 822960, [`<a:p>${run('Judul Konten', 2800, ' b="1"')}</a:p>`])
    + textShape(3, 731520, 1508760, 4876800, 2743200, [`<a:p>${run('Isi konten sampel yang cukup panjang')}</a:p>`])
    + contentGroup,
  );
  const closing = slideXml(textShape(2, 1828800, 2606040, 8534400, 1371600, [`<a:p>${run('Terima Kasih', 4000, ' b="1"')}</a:p>`]));

  [cover, toc, content, closing].forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    const entries: Array<[string, string, string]> = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    if (i === 1 || i === 2) entries.push(['rId8', 'image', `../media/image${i === 1 ? 1 : 2}.png`]);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relsXml(entries));
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------- parser */

describe('grouped template pages (parser)', () => {
  test('slots inside grpSp get slide-space rects through the child-space transform', async () => {
    const extract = await extractPptxPages(await groupedPptx());
    expect(extract.pages.map((page) => page.kind)).toEqual(['cover', 'toc', 'content', 'closing']);

    const tocPage = extract.pages[1]!;
    const text = templatePageTextSlots(tocPage);
    expect(text.map((slot) => slot.key)).toEqual(['s0', 's1', 's2', 's4']);
    expect(text[0]!.sampleText).toBe('Daftar Isi');

    // Card title: child (487680, 514350, 5486400, 514350) at scale 0.5
    // from group off (1219200, 1714500).
    const cardTitle = text[1]!;
    expect(cardTitle.sampleText).toBe('Project Progress A');
    expect(cardTitle.rect.x).toBeCloseTo(1463040 / CX, 4);
    expect(cardTitle.rect.y).toBeCloseTo(1971675 / CY, 4);
    expect(cardTitle.rect.w).toBeCloseTo(2743200 / CX, 4);
    expect(cardTitle.rect.h).toBeCloseTo(257175 / CY, 4);
    expect(cardTitle.fontSizePt).toBe(20);
    expect(cardTitle.bold).toBe(true);
    expect(cardTitle.fontFamily).toBe('Georgia');
    expect(cardTitle.maxChars).toBeGreaterThanOrEqual(cardTitle.sampleText.length);

    const cardBody = text[2]!;
    expect(cardBody.sampleText).toBe('Lorem ipsum dolor sit amet');
    expect(cardBody.rect.x).toBeCloseTo(1463040 / CX, 4);
    expect(cardBody.rect.y).toBeCloseTo((1714500 + 1028700 / 2) / CY, 4);

    // Group-in-group: inner label lands where the composed transform puts it.
    const inner = text[3]!;
    expect(inner.sampleText).toBe('Label Dalam');
    expect(inner.rect.x).toBeCloseTo(4968240 / CX, 4);
    expect(inner.rect.y).toBeCloseTo(2834640 / CY, 4);
    expect(inner.rect.w).toBeCloseTo(1645920 / CX, 4);

    // The picture inside the group is an image slot with stored bytes.
    const images = templatePageImageSlots(tocPage);
    expect(images).toHaveLength(1);
    expect(images[0]!.key).toBe('s3');
    expect(images[0]!.imageFile).toBe('page-1.pic-0.png');
    expect(images[0]!.rect.x).toBeCloseTo(4419600 / CX, 4);
    expect(images[0]!.rect.w).toBeCloseTo(609600 / CX, 4);

    // The card body is decor at its transformed rect, behind the slots.
    const decor = tocPage.shapes ?? [];
    const card = decor.find((shape) => shape.type === 'shape');
    expect(card).toBeDefined();
    if (card && card.type === 'shape') {
      expect(card.geom).toBe('roundRect');
      expect(card.fill).toBe('#4f46e5');
      expect(card.rect.x).toBeCloseTo((1219200 + 243840 / 2) / CX, 4);
      expect(card.rect.y).toBeCloseTo((1714500 + 342900 / 2) / CY, 4);
      expect(card.rect.w).toBeCloseTo(3048000 / CX, 4);
    }

    // The content page's grouped picture resolves at its identity box.
    const contentImages = templatePageImageSlots(extract.pages[2]!);
    expect(contentImages).toHaveLength(1);
    expect(contentImages[0]!.rect.x).toBeCloseTo(6096000 / CX, 4);
    expect(contentImages[0]!.imageFile).toBe('page-2.pic-0.png');
  });

  test('stored addresses carry shape paths into (and out of) groups', async () => {
    const root = temp('daedalus-ppt-groups-addr-');
    const template = await savePptxTemplate(root, { fileName: 'PetaJalan.pptx', bytes: await groupedPptx() });
    const toc = template.sourceAddresses![1]!;
    const byKey = new Map(toc.slots.map((slot) => [slot.key, slot]));
    expect(byKey.get('s1')?.shapePath).toEqual([1, 1]); // group(1) → card title(1)
    expect(byKey.get('s1')?.shapeKey).toBe('id-12');
    expect(byKey.get('s1')?.paragraphs).toBe(1);
    expect(byKey.get('s3')?.shapePath).toEqual([1, 3]); // group(1) → pic(3)
    expect(byKey.get('s3')?.mediaPart).toBe('ppt/media/image1.png');
    expect(byKey.get('s4')?.shapePath).toEqual([1, 4, 0]); // group → inner group → text
  });
});

/* ------------------------------------------------- generation + export */

function templateSlide(id: string, templateId: string, page: number, slots: Record<string, string>): Slide {
  return { id, layout: 'template-page', content: { slots }, templateRef: { templateId, page } };
}

function ts(xml: string): string[] {
  return [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]!);
}

async function unzip(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

describe('grouped template pages (export)', () => {
  test('clone export rewrites words inside groups; untouched group bytes stay identical', async () => {
    const root = temp('daedalus-ppt-groups-export-');
    const template = await savePptxTemplate(root, { fileName: 'PetaJalan.pptx', bytes: await groupedPptx() });
    const assetsDir = deckPaths(root).assetsDir;
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'pilihan.png'), PNG_CHOSEN);

    const deck = newDeck('Sejarah Filsafat');
    deck.slides = [
      templateSlide('a', template.id, 0, { s0: 'Lintas Zaman Filsafat', s1: 'Dari Yunani ke Nusantara' }),
      // Group slots on the TOC page: card title, card body, nested label
      // filled; the in-group picture clicked to the user's image.
      templateSlide('b', template.id, 1, { s0: 'Daftar Isi', s1: 'Kemajuan Bab Satu', s2: 'Ringkasan isi bab pertama', s3: 'pilihan.png', s4: 'Bab 01' }),
      templateSlide('c', template.id, 3, { s0: 'Terima Kasih' }),
    ];
    const result = await exportDeckToPptx(deck, root);
    expect(result.note).toBeUndefined();

    const out = await unzip(readFileSync(join(root, 'deck', 'sejarah-filsafat.pptx')));
    const tocXml = await out.file('ppt/slides/slide2.xml')!.async('string');
    // Group words replaced — the sample lorem is gone from the export.
    expect(tocXml).not.toContain('Project Progress A');
    expect(tocXml).not.toContain('Lorem ipsum');
    expect(tocXml).not.toContain('Label Dalam');
    expect(ts(tocXml)).toEqual(expect.arrayContaining(['Daftar Isi', 'Kemajuan Bab Satu', 'Ringkasan isi bab pertama', 'Bab 01']));
    // First-run properties of the replaced runs survive (size + bold).
    expect(tocXml).toContain('sz="2000"');
    expect(tocXml).toContain('<a:latin typeface="Georgia"/>');
    // The decorative card inside the same group keeps its exact bytes.
    expect(tocXml).toContain(CARD_DECOR);
    // Clicked in-group picture: new media part, chosen bytes.
    const swapped = await out.file('ppt/media/daedalus-swap-1.png')!.async('nodebuffer');
    expect(Buffer.compare(swapped, PNG_CHOSEN)).toBe(0);
    const rels2 = await out.file('ppt/slides/_rels/slide2.xml.rels')!.async('string');
    expect(rels2).toContain('daedalus-swap-1.png');
    const original = await out.file('ppt/media/image1.png')!.async('nodebuffer');
    expect(Buffer.compare(original, PNG_ORIGINAL)).toBe(0);
  });

  test('addresses stored before shape paths (shapeKey only) still rewrite group text', async () => {
    const root = temp('daedalus-ppt-groups-legacy-');
    const template = await savePptxTemplate(root, { fileName: 'PetaJalan.pptx', bytes: await groupedPptx() });
    // Simulate a pre-group stored record: same JSON minus shapePath.
    const jsonPath = join(pptxTemplatesDir(root), `${template.id}.json`);
    const stored = JSON.parse(readFileSync(jsonPath, 'utf8')) as { sourceAddresses: Array<{ slots: Array<Record<string, unknown>> }> };
    for (const page of stored.sourceAddresses) {
      for (const slot of page.slots) delete slot.shapePath;
    }
    writeFileSync(jsonPath, JSON.stringify(stored, null, 2));

    const deck = newDeck('Warisan Grup');
    deck.slides = [templateSlide('b', template.id, 1, { s0: 'Daftar Isi', s1: 'Diganti Lewat Kunci', s2: 'Isi lama diganti', s3: '', s4: 'Bab' })];
    await exportDeckToPptx(deck, root);
    const out = await unzip(readFileSync(join(root, 'deck', 'warisan-grup.pptx')));
    const tocXml = await out.file('ppt/slides/slide2.xml')!.async('string');
    expect(tocXml).toContain('Diganti Lewat Kunci');
    expect(tocXml).not.toContain('Project Progress A');
    expect(tocXml).not.toContain('Lorem ipsum');
  });

  test('generation pours AI words into group slots (pipeline end to end)', async () => {
    const root = temp('daedalus-ppt-groups-gen-');
    const template = await savePptxTemplate(root, { fileName: 'PetaJalan.pptx', bytes: await groupedPptx() });
    const textOf = (m: Message | undefined): string => (typeof m?.content === 'string' ? m.content : '');
    const provider: LLMProvider = {
      name: 'groups-scripted',
      async chat(messages: Message[]) {
        const system = textOf(messages[0]);
        const user = textOf(messages[1]);
        if (system.includes('OUTLINE stage')) {
          const roles = ['cover', 'toc', 'content', 'closing'];
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify(roles.map((role, i) => ({ title: `Judul ${i + 1} filsafat`, keyMessage: `pesan ${i + 1}`, role }))),
            },
            finish_reason: 'stop',
          };
        }
        if (system.includes('FILL stage')) {
          const out: Record<string, string> = {};
          for (const m of user.matchAll(/^- (s\d+):/gm)) out[m[1]!] = `Kata AI ${m[1]}`;
          return { message: { role: 'assistant' as const, content: JSON.stringify(out) }, finish_reason: 'stop' };
        }
        return { message: { role: 'assistant' as const, content: '{}' }, finish_reason: 'stop' };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };

    await generateDeckOutlineStage(provider, root, { topic: 'sejarah filsafat', slideCount: 4, customTemplateId: template.id });
    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.failures).toEqual([]);
    const deck = (await readDeck(root))!;
    const tocSlide = deck.slides[1]!;
    expect(tocSlide.templateRef?.page).toBe(1);
    const slots = tocSlide.content.slots as Record<string, string>;
    // Group card title/body/nested label were slots the AI could fill.
    expect(slots.s1).toBe('Kata AI s1');
    expect(slots.s2).toBe('Kata AI s2');
    expect(slots.s4).toBe('Kata AI s4');
    expect(slots.s3).toBe(''); // in-group picture: AI never fills it

    // And the exported file carries those words inside the group XML.
    const storedTemplate = await getPptxTemplate(root, template.id);
    expect(storedTemplate?.pages?.[1]?.kind).toBe('toc');
    const out = await unzip(readFileSync(join(root, fill.exported!.path)));
    const tocXml = await out.file('ppt/slides/slide2.xml')!.async('string');
    expect(tocXml).toContain('Kata AI s1');
    expect(tocXml).not.toContain('Project Progress A');
    expect(tocXml).toContain(CARD_DECOR);
  });
});
