import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  deckPaths,
  exportDeckToPptx,
  fillDeckSlidesStage,
  generateDeckOutlineStage,
  newDeck,
  pptxTemplatesDir,
  readDeck,
  savePptxTemplate,
  type DeckSpec,
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

/* ------------------------------------------------------------ fixture */

/** 1x1 emerald PNG — the template's original picture bytes. */
const PNG_ORIGINAL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** 1x1 red PNG — the user's clicked replacement (same format, other bytes). */
const PNG_CHOSEN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

const CX = 12192000;
const CY = 6858000;
const emu = (v: number): number => Math.round(v * 1000000);

function relsXml(entries: Array<[string, string, string]>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Distinctive decorative shapes — asserted byte-identical after export. */
const DECOR_ELLIPSE = `<p:sp><p:nvSpPr><p:cNvPr id="20" name="BlobElips"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="-${emu(1.2)}" y="-${emu(1.6)}"/><a:ext cx="${emu(6)}" cy="${emu(4)}"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="0E7A5F"/></a:solidFill></p:spPr></p:sp>`;
const DECOR_ROUND = `<p:sp><p:nvSpPr><p:cNvPr id="21" name="PitaEmas"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(9.8)}" y="${emu(0.4)}"/><a:ext cx="${emu(2.6)}" cy="${emu(0.9)}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 20000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></p:spPr></p:sp>`;
const DECOR_BLOB = `<p:sp><p:nvSpPr><p:cNvPr id="22" name="BlobBebas"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(8.6)}" y="${emu(4.4)}"/><a:ext cx="${emu(4.2)}" cy="${emu(2.8)}"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst><a:path w="4200000" h="2800000"><a:moveTo><a:pt x="0" y="1400000"/></a:moveTo><a:cubicBezTo><a:pt x="900000" y="0"/><a:pt x="3300000" y="200000"/><a:pt x="4200000" y="1400000"/></a:cubicBezTo><a:cubicBezTo><a:pt x="3400000" y="2800000"/><a:pt x="800000" y="2600000"/><a:pt x="0" y="1400000"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="68D8B2"/></a:solidFill></p:spPr></p:sp>`;
const DECOR_GROUP = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="30" name="GrupBintang"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${emu(0.6)}" y="${emu(5.6)}"/><a:ext cx="${emu(2.4)}" cy="${emu(1.2)}"/><a:chOff x="${emu(0.6)}" y="${emu(5.6)}"/><a:chExt cx="${emu(2.4)}" cy="${emu(1.2)}"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="31" name="Plus1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(0.7)}" y="${emu(5.7)}"/><a:ext cx="${emu(0.5)}" cy="${emu(0.5)}"/></a:xfrm><a:prstGeom prst="plus"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF6B9D"/></a:solidFill></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="32" name="TeksGrup"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(1.3)}" y="${emu(5.8)}"/><a:ext cx="${emu(1.6)}" cy="${emu(0.6)}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>TeksDiGrup</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>`;
const CHART_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="40" name="GrafikAsli"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(7.4)}" y="${emu(2.2)}"/><a:ext cx="${emu(5.2)}" cy="${emu(3.4)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS}" r:id="rId7"/></a:graphicData></a:graphic></p:graphicFrame>`;

function textShape(id: number, name: string, x: number, y: number, w: number, h: number, paras: string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${paras.join('')}</p:txBody></p:sp>`;
}

function slideXml(body: string, bg = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
}

/**
 * A decorated 3-page template in the shape of Farid's downloads: cream
 * cover with big vector blobs + a grouped star cluster + a two-run serif
 * title, a section page, and a content page carrying a picture slot and
 * a native chart frame.
 */
async function hutanPptx(): Promise<Buffer> {
  const zip = new JSZip();
  const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    '<Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
    '</Types>'].join('');
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml'], ['rId4', 'slide', 'slides/slide3.xml']]));
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5EFDB"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Hutan"><a:themeElements><a:clrScheme name="Hutan"><a:dk1><a:srgbClr val="1E3D2F"/></a:dk1><a:lt1><a:srgbClr val="F5EFDB"/></a:lt1><a:dk2><a:srgbClr val="0B3D2E"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="0E7A5F"/></a:accent1><a:accent2><a:srgbClr val="FFC000"/></a:accent2><a:accent3><a:srgbClr val="68D8B2"/></a:accent3><a:accent4><a:srgbClr val="2E5941"/></a:accent4><a:accent5><a:srgbClr val="FF6B9D"/></a:accent5><a:accent6><a:srgbClr val="7AC74F"/></a:accent6><a:hlink><a:srgbClr val="0E7A5F"/></a:hlink><a:folHlink><a:srgbClr val="0E7A5F"/></a:folHlink></a:clrScheme><a:fontScheme name="HutanFonts"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/media/image1.png', PNG_ORIGINAL);
  zip.file('ppt/charts/chart1.xml', `<?xml version="1.0"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:catAx/><c:valAx/></c:plotArea></c:chart><!-- DATA-CAT-ASLI --></c:chartSpace>`);

  const creamBg = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5EFDB"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';
  const titleRun = (text: string, extra = ''): string => `<a:r><a:rPr lang="id-ID" sz="4400" b="1" dirty="0"${extra}><a:solidFill><a:srgbClr val="0B3D2E"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>${text}</a:t></a:r>`;
  const coverTitle = textShape(2, 'JudulCover', 1.4, 2.2, 10.4, 1.8, [
    `<a:p><a:pPr algn="ctr"/>${titleRun('Judul Lama')}${titleRun(' Berwarna', ' i="1"')}</a:p>`,
  ]);
  const coverSub = textShape(3, 'SubJudul', 2.6, 4.3, 8, 0.9, [
    `<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="2E5941"/></a:solidFill><a:latin typeface="Verdana"/></a:rPr><a:t>Subjudul contoh lama</a:t></a:r></a:p>`,
  ]);
  zip.file('ppt/slides/slide1.xml', slideXml(DECOR_ELLIPSE + DECOR_BLOB + coverTitle + coverSub + DECOR_GROUP + DECOR_ROUND, creamBg));
  zip.file('ppt/slides/_rels/slide1.xml.rels', relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));

  const sectionTitle = textShape(2, 'JudulBab', 1, 3, 11.3, 1.6, [
    `<a:p><a:r><a:rPr sz="4800" b="1"><a:solidFill><a:srgbClr val="0B3D2E"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Bab Contoh</a:t></a:r></a:p>`,
  ]);
  const band = `<p:sp><p:nvSpPr><p:cNvPr id="20" name="PitaBawah"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="${emu(6.6)}"/><a:ext cx="${CX}" cy="${emu(0.9)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="0E7A5F"/></a:solidFill></p:spPr></p:sp>`;
  zip.file('ppt/slides/slide2.xml', slideXml(band + sectionTitle, creamBg));
  zip.file('ppt/slides/_rels/slide2.xml.rels', relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));

  const contentTitle = textShape(2, 'JudulIsi', 0.7, 0.5, 7.4, 1, [
    `<a:p><a:r><a:rPr sz="2800" b="1"><a:solidFill><a:srgbClr val="0B3D2E"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Judul Konten Lama</a:t></a:r></a:p>`,
  ]);
  const bodyRun = (text: string): string => `<a:p><a:pPr><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="333333"/></a:solidFill><a:latin typeface="Verdana"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`;
  const contentBody = textShape(3, 'IsiKonten', 0.7, 1.8, 6.4, 3.4, [bodyRun('Poin lama satu'), bodyRun('Poin lama dua')]);
  const contentPic = `<p:pic><p:nvPicPr><p:cNvPr id="9" name="FotoBuku"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${emu(7.6)}" y="${emu(0.6)}"/><a:ext cx="${emu(5)}" cy="${emu(1.4)}"/></a:xfrm></p:spPr></p:pic>`;
  zip.file('ppt/slides/slide3.xml', slideXml(contentTitle + contentBody + contentPic + CHART_FRAME, creamBg));
  zip.file('ppt/slides/_rels/slide3.xml.rels', relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId7', 'chart', '../charts/chart1.xml'], ['rId8', 'image', '../media/image1.png']]));

  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------ helpers */

function ts(xml: string): string[] {
  return [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]!);
}

async function unzip(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

async function partText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  expect(file, `part ${path} exists`).toBeTruthy();
  return file!.async('string');
}

function templateSlide(id: string, templateId: string, page: number, slots: Record<string, string>): Slide {
  return { id, layout: 'template-page', content: { slots }, templateRef: { templateId, page } };
}

/* ------------------------------------------------------------ tests */

describe('Template dari PPT v3 — storage', () => {
  test('save keeps the source .pptx and per-page slot→shape addresses', async () => {
    const root = temp('daedalus-ppt-fidelity-store-');
    const template = await savePptxTemplate(root, { fileName: 'HutanBelajar.pptx', bytes: await hutanPptx() });

    expect(template.sourceFileName).toBe(`${template.id}.source.pptx`);
    const dir = pptxTemplatesDir(root);
    expect(existsSync(join(dir, template.sourceFileName!))).toBe(true);
    expect(readFileSync(join(dir, template.sourceFileName!)).length).toBeGreaterThan(0);

    expect(template.sourceAddresses).toHaveLength(3);
    expect(template.sourceAddresses![0]!.slidePart).toBe('ppt/slides/slide1.xml');
    const coverText = template.sourceAddresses![0]!.slots.filter((s) => s.kind === 'text').map((s) => s.key);
    expect(coverText).toEqual(['s0', 's1']);
    expect(template.sourceAddresses![0]!.slots.find((s) => s.key === 's0')?.shapeKey).toBe('id-2');
    const contentImage = template.sourceAddresses![2]!.slots.find((s) => s.kind === 'image');
    expect(contentImage?.mediaPart).toBe('ppt/media/image1.png');

    // Decor preview capture: solid preset shapes and the converted
    // custGeom blob, in paint order; grouped children honestly stay out.
    const coverShapes = template.pages![0]!.shapes ?? [];
    expect(coverShapes.map((s) => (s.type === 'shape' ? s.geom : s.type))).toEqual(['ellipse', 'path', 'roundRect']);
    expect(coverShapes[0]).toMatchObject({ type: 'shape', fill: '#0e7a5f' });
    expect(coverShapes[1]).toMatchObject({ type: 'path', fill: '#68d8b2' });
    expect((coverShapes[1] as { d: string }).d).toContain('C');

    // The persisted JSON carries the new fields too.
    const stored = JSON.parse(readFileSync(join(dir, `${template.id}.json`), 'utf8')) as { sourceFileName?: string; sourceAddresses?: unknown[] };
    expect(stored.sourceFileName).toBe(template.sourceFileName);
    expect(stored.sourceAddresses).toHaveLength(3);
  });
});

describe('Template dari PPT v3 — clone-and-rewrite export', () => {
  test('decorations stay byte-identical, only slot words and clicked images change', async () => {
    const root = temp('daedalus-ppt-fidelity-export-');
    const template = await savePptxTemplate(root, { fileName: 'HutanBelajar.pptx', bytes: await hutanPptx() });

    // The user's clicked image for the reused content page's second use.
    const assetsDir = deckPaths(root).assetsDir;
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'pilihan.png'), PNG_CHOSEN);

    const deck = newDeck('Fotosintesis Seru');
    deck.slides = [
      templateSlide('s-cover', template.id, 0, { s0: 'Fotosintesis untuk Pemula', s1: 'Panduan hijau kelas enam' }),
      templateSlide('s-bab', template.id, 1, { s0: 'Bab Satu' }),
      templateSlide('s-isi-1', template.id, 2, { s0: 'Apa Itu Fotosintesis', s1: 'Daun menangkap cahaya matahari\nKlorofil mengubahnya jadi gula\nAkar menyerap air dari tanah', s2: '' }),
      templateSlide('s-isi-2', template.id, 2, { s0: 'Faktor yang Memengaruhi', s1: 'Cahaya dan air yang cukup', s2: 'pilihan.png' }),
    ];
    const result = await exportDeckToPptx(deck, root);
    expect(result.slideCount).toBe(4);
    expect(result.note).toBeUndefined();

    const out = await unzip(readFileSync(join(root, 'deck', 'fotosintesis-seru.pptx')));
    const presRels = await partText(out, 'ppt/_rels/presentation.xml.rels');
    const slideTargets = [...presRels.matchAll(/Type="[^"]*\/slide" Target="slides\/(slide\d+\.xml)"/g)].map((m) => m[1]!);
    expect(slideTargets).toEqual(['slide1.xml', 'slide2.xml', 'slide3.xml', 'slide4.xml']);

    const cover = await partText(out, 'ppt/slides/slide1.xml');
    // Decorations: byte-identical to the source shapes.
    expect(cover).toContain(DECOR_ELLIPSE);
    expect(cover).toContain(DECOR_BLOB);
    expect(cover).toContain(DECOR_GROUP);
    expect(cover).toContain('TeksDiGrup');
    // Words: exactly the AI's, first-run properties preserved.
    expect(ts(cover)).toEqual(['Fotosintesis untuk Pemula', 'Panduan hijau kelas enam', 'TeksDiGrup']);
    expect(ts(cover)).not.toContain('Berwarna');
    expect(ts(cover)).not.toContain('Judul Lama');
    expect(ts(cover)).not.toContain('Subjudul contoh lama');
    expect(cover).toContain('sz="4400" b="1"');
    expect(cover).toContain('<a:latin typeface="Georgia"/>');

    const content1 = await partText(out, 'ppt/slides/slide3.xml');
    expect(ts(content1)).toEqual(['Apa Itu Fotosintesis', 'Daun menangkap cahaya matahari', 'Klorofil mengubahnya jadi gula', 'Akar menyerap air dari tanah']);
    expect(content1).toContain(CHART_FRAME);

    const content2 = await partText(out, 'ppt/slides/slide4.xml');
    expect(ts(content2)).toEqual(['Faktor yang Memengaruhi', 'Cahaya dan air yang cukup']);
    expect(content2).toContain(CHART_FRAME);
    // The duplicated part carries its own rels (layout + chart + image).
    const rels4 = await partText(out, 'ppt/slides/_rels/slide4.xml.rels');
    expect(rels4).toContain('slideLayout');
    expect(rels4).toContain('chart1.xml');

    // Chart part survives as the original.
    const chart = await partText(out, 'ppt/charts/chart1.xml');
    expect(chart).toContain('DATA-CAT-ASLI');

    // Clicked image swapped per-slide: the choice becomes a new media
    // part retargeted from the clicking slide's rels; the original part
    // (and the other use of the same page) keep the original bytes.
    const original = await out.file('ppt/media/image1.png')!.async('nodebuffer');
    expect(Buffer.compare(original, PNG_ORIGINAL)).toBe(0);
    const swapped = await out.file('ppt/media/daedalus-swap-1.png')!.async('nodebuffer');
    expect(Buffer.compare(swapped, PNG_CHOSEN)).toBe(0);
    expect(rels4).toContain('daedalus-swap-1.png');
    const rels3 = await partText(out, 'ppt/slides/_rels/slide3.xml.rels');
    expect(rels3).toContain('image1.png');
    expect(rels3).not.toContain('daedalus-swap');
  });

  test('untouched image slots keep the original bytes; sldIdLst follows deck order', async () => {
    const root = temp('daedalus-ppt-fidelity-untouched-');
    const template = await savePptxTemplate(root, { fileName: 'HutanBelajar.pptx', bytes: await hutanPptx() });
    const deck = newDeck('Urutan Terbalik');
    deck.slides = [
      templateSlide('a', template.id, 2, { s0: 'Konten Dulu', s1: 'Isi tunggal', s2: '' }),
      templateSlide('b', template.id, 0, { s0: 'Sampul Kemudian', s1: 'Subjudul baru' }),
    ];
    const result = await exportDeckToPptx(deck, root);
    expect(result.slideCount).toBe(2);
    const out = await unzip(readFileSync(join(root, 'deck', 'urutan-terbalik.pptx')));
    const media = await out.file('ppt/media/image1.png')!.async('nodebuffer');
    expect(Buffer.compare(media, PNG_ORIGINAL)).toBe(0);
    const first = await partText(out, 'ppt/slides/slide3.xml');
    expect(ts(first)[0]).toBe('Konten Dulu');
    const pres = await partText(out, 'ppt/presentation.xml');
    const ids = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(Math.min(...ids)).toBeGreaterThan(255);
  });

  test('mixed decks and pre-v3 templates fall back with an honest note', async () => {
    const root = temp('daedalus-ppt-fidelity-fallback-');
    const template = await savePptxTemplate(root, { fileName: 'HutanBelajar.pptx', bytes: await hutanPptx() });

    const mixed = newDeck('Campuran');
    mixed.slides = [
      templateSlide('a', template.id, 0, { s0: 'Sampul', s1: 'Sub' }),
      { id: 'b', layout: 'bullets', content: { title: 'Slide Biasa', bullets: ['satu'] } },
    ];
    const mixedResult = await exportDeckToPptx(mixed, root);
    expect(mixedResult.note).toContain('aproksimasi');
    expect(existsSync(join(root, 'deck', 'campuran.pptx'))).toBe(true);

    // Pre-v3 stored template: same JSON without the v3 fields.
    const dir = pptxTemplatesDir(root);
    const jsonPath = join(dir, `${template.id}.json`);
    const stored = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
    delete stored.sourceFileName;
    delete stored.sourceAddresses;
    writeFileSync(jsonPath, JSON.stringify(stored, null, 2));

    const pure = newDeck('Murni Template');
    pure.slides = [templateSlide('a', template.id, 0, { s0: 'Sampul', s1: 'Sub' })];
    const pureResult = await exportDeckToPptx(pure, root);
    expect(pureResult.note).toContain('diimpor sebelum ekspor fidelitas penuh');
    expect(existsSync(join(root, 'deck', 'murni-template.pptx'))).toBe(true);
    expect(readdirSync(join(root, 'deck')).filter((f) => f.endsWith('.pptx')).length).toBe(2);
  });
});

describe('Template dari PPT v3 — pipeline integration', () => {
  test('outline → fill → the exported file keeps the template decorations', async () => {
    const root = temp('daedalus-ppt-fidelity-pipeline-');
    const template = await savePptxTemplate(root, { fileName: 'HutanBelajar.pptx', bytes: await hutanPptx() });
    const textOf = (m: Message | undefined): string =>
      !m ? '' : typeof m.content === 'string' ? m.content : m.content.map((part) => ('text' in part ? part.text : '')).join('');
    const provider: LLMProvider = {
      name: 'fidelity-scripted',
      async chat(messages: Message[]) {
        const system = textOf(messages[0]);
        const user = textOf(messages[1]);
        if (system.includes('OUTLINE stage')) {
          const roles = ['cover', 'section', 'content', 'content'];
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify(roles.map((role, i) => ({ title: `Judul ${i + 1} fotosintesis`, keyMessage: `pesan ${i + 1}`, role }))),
            },
            finish_reason: 'stop',
          };
        }
        if (system.includes('FILL stage')) {
          const out: Record<string, string> = {};
          for (const m of user.matchAll(/^- (s\d+):/gm)) out[m[1]!] = `Kata AI untuk ${m[1]}`;
          return { message: { role: 'assistant' as const, content: JSON.stringify(out) }, finish_reason: 'stop' };
        }
        return { message: { role: 'assistant' as const, content: '{}' }, finish_reason: 'stop' };
      },
      async *stream() { yield { type: 'delta', content: '' }; },
    };

    const staged = await generateDeckOutlineStage(provider, root, { topic: 'fotosintesis', slideCount: 4, customTemplateId: template.id });
    expect(staged.deck.slides.map((s) => s.templateRef?.page)).toEqual([0, 1, 2, 2]);
    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.failures).toEqual([]);
    expect(fill.exported?.slides).toBe(4);
    expect(fill.exported?.note).toBeUndefined();

    const deck = (await readDeck(root))!;
    const exportedPath = join(root, fill.exported!.path);
    const out = await unzip(readFileSync(exportedPath));
    const cover = await partText(out, 'ppt/slides/slide1.xml');
    expect(cover).toContain(DECOR_ELLIPSE);
    expect(cover).toContain(DECOR_GROUP);
    expect(ts(cover)).toContain('Kata AI untuk s0');
    const reused = await partText(out, 'ppt/slides/slide4.xml');
    expect(ts(reused)).toContain('Kata AI untuk s0');
    void deck;
  });
});
