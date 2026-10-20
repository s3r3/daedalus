/**
 * Canvas-preview fidelity of imported template pages (PR #59 follow-up).
 *
 * The live defect (Farid, Nexora template): the exported .pptx was
 * rich and correct, but the canvas preview of the same template page
 * showed bare text — zero decor. The file paints almost nothing with
 * raw srgb: cards are gradFills over schemeClr stops (bg1→bg2→accent1
 * with lumMod/lumOff), solid accents are schemeClr, the rest comes
 * from style fillRefs into the theme's fill style list. Before this
 * change the parser only read srgb solidFills, so every one of those
 * paints was silently dropped. These fixtures synthetically reproduce
 * each dropped class; the real Nexora file is a commercial download
 * and never enters the repo (audit + proof live in the preview dir).
 *
 * Hand-computed expectations (HSL, ECMA-376 transforms):
 *  gray #808080 has L = 128/255 ≈ 0.50196.
 *  lumMod 60%            → L 0.30118 → byte 77   → #4d4d4d
 *  lumMod 60% + lumOff 20% → L 0.50118 → byte 128 → #808080
 *  dk2 #404040 L = 64/255 ≈ 0.25098; lumMod 20% + lumOff 80%
 *                        → L 0.85020 → byte 217  → #d9d9d9
 *  pure red #ff0000, tint 50%   → #ff8080 (L 0.5 → 0.75)
 *  pure red #ff0000, shade 50%  → #800000 (L 0.5 → 0.25)
 */
import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';
import { extractPptxPages } from '../src/index.ts';

const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CX = 12192000;
const CY = 6858000;

/** 1x1 PNG — the grouped icon's original picture bytes. */
const PNG_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function relsXml(entries: Array<[string, string, string]>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

const THEME = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements>
<a:clrScheme name="Fixture">
<a:dk1><a:srgbClr val="2F2F2F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="404040"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2>
<a:accent1><a:srgbClr val="808080"/></a:accent1><a:accent2><a:srgbClr val="FF0000"/></a:accent2>
<a:accent3><a:srgbClr val="68D8B2"/></a:accent3><a:accent4><a:srgbClr val="2E5941"/></a:accent4>
<a:accent5><a:srgbClr val="FF6B9D"/></a:accent5><a:accent6><a:srgbClr val="7AC74F"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="FixtureFonts"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="FixtureFmt">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectLst/></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements></a:theme>`;

const sp = (id: number, name: string, xfrm: string, spPrExtra: string, extra = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>${xfrm}</a:xfrm>${spPrExtra}</p:spPr>${extra}</p:sp>`;
const at = (x: number, y: number, w: number, h: number): string => `<a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/>`;

/** gradFill over explicit sRGB stops (alpha on the last), 90° linear. */
const GRAD_RECT = sp(4, 'KartuGradasi', at(609600, 685800, 3657600, 2057400),
  `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="102030"/></a:gs><a:gs pos="100000"><a:srgbClr val="F0E0D0"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>`);
/** Solid schemeClr gray, lumMod 60% + lumOff 20% → back to #808080. */
const ELLIPSE_SCHEME = sp(5, 'TitikTerang', at(4876800, 685800, 609600, 480060),
  `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="20000"/></a:schemeClr></a:solidFill>`);
/** Same gray, lumMod 60% alone → #4d4d4d. */
const ELLIPSE_SCHEME_DARK = sp(6, 'TitikGelap', at(5608320, 685800, 609600, 480060),
  `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="60000"/></a:schemeClr></a:solidFill>`);
/** Freeform with a radial (path) gradient over scheme stops incl. aliases bg2/tx2. */
const BLOB = sp(7, 'Gumpalan', at(7315200, 685800, 2438400, 2057400),
  `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="1000" h="1000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1000" y="0"/></a:lnTo><a:lnTo><a:pt x="500" y="1000"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="bg2"/></a:gs><a:gs pos="100000"><a:schemeClr val="tx2"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect r="100000" b="100000"/></a:path></a:gradFill>`);
/** Paint only via style fillRef idx 2 (theme gradient of phClr), ref names accent2 red. */
const STYLE_REF_GRAD = sp(8, 'KartuReferensi', at(609600, 3429000, 2438400, 1371600),
  `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>`,
  `<p:style><a:lnRef idx="0"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="2"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent2"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style>`);
/** fillRef idx 1 (solid phClr) with the ref's own lum transform applied. */
const STYLE_REF_SOLID = sp(9, 'PaletReferensi', at(3352800, 3429000, 1219200, 1371600),
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
  `<p:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"><a:lumMod val="60000"/></a:schemeClr></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style>`);
/** A native chart frame: footprint only on canvas; export keeps the real chart. */
const CHART_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Bagan 1"/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5181600" y="3429000"/><a:ext cx="3352800" cy="2057400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS}" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`;
/** A group whose icon is a blip-filled shape (no <p:pic> anywhere). */
const GROUP_ICON = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="GrupIkon"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="9144000" y="3429000"/><a:ext cx="1219200" cy="1219200"/><a:chOff x="9144000" y="3429000"/><a:chExt cx="1219200" cy="1219200"/></a:xfrm></p:grpSpPr>${sp(12, 'IkonGrup', at(9144000, 3429000, 1219200, 1219200), `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdImg"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`)}</p:grpSp>`;
/** Line-only shape: noFill fill with a stroke — must stay invisible decor-wise. */
const LINE_ONLY = sp(13, 'GarisSaja', at(609600, 5486400, 10972800, 91440),
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:solidFill><a:srgbClr val="404040"/></a:solidFill></a:ln>`);
/** Text slot whose run color is a shaded scheme color (shade 50% on red → #800000). */
const YEAR_TEXT = `<p:sp><p:nvSpPr><p:cNvPr id="14" name="Tahun"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>${at(609600, 1028700 + 4800600, 1219200, 685800)}</a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"><a:solidFill><a:schemeClr val="accent2"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:rPr><a:t>1185</a:t></a:r></a:p></p:txBody></p:sp>`;

async function fixturePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml']]));
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  zip.file('ppt/theme/theme1.xml', THEME);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/media/icon.png', PNG_ICON);
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${GRAD_RECT}${ELLIPSE_SCHEME}${ELLIPSE_SCHEME_DARK}${BLOB}${STYLE_REF_GRAD}${STYLE_REF_SOLID}${CHART_FRAME}${GROUP_ICON}${LINE_ONLY}${YEAR_TEXT}</p:spTree></p:cSld></p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide);
  zip.file('ppt/slides/_rels/slide1.xml.rels', relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rIdImg', 'image', '../media/icon.png'], ['rId9', 'chart', '../charts/chart1.xml']]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('canvas fidelity: theme-resolved decor of imported template pages', () => {
  test('gradFill shapes yield gradient decor (stops, alpha, OOXML angle) — never dropped for fill reasons', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const shapes = pages[0]!.shapes ?? [];
    const card = shapes.find((s) => s.type === 'shape' && s.geom === 'roundRect' && s.fill === '#102030');
    expect(card).toBeDefined();
    expect(card?.type === 'shape' && card.gradient).toMatchObject({
      kind: 'linear',
      angleDeg: 90, // lin ang 5400000 (60000ths of a degree)
      stops: [
        { pos: 0, color: '#102030' },
        { pos: 1, color: '#f0e0d0', alpha: 0.5 },
      ],
    });
  });

  test('schemeClr fills resolve through the clrScheme with hand-computed luminance math', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const shapes = pages[0]!.shapes ?? [];
    const fills = shapes.filter((s) => s.type === 'shape').map((s) => (s as { fill: string }).fill);
    expect(fills).toContain('#808080'); // accent1 lumMod 60% + lumOff 20% roundtrip
    expect(fills).toContain('#4d4d4d'); // accent1 lumMod 60%
  });

  test('radial path gradient over aliased scheme names (bg2→lt2, tx2→dk2 lum) lands on the freeform', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const blob = (pages[0]!.shapes ?? []).find((s) => s.type === 'path');
    expect(blob?.type === 'path' && blob.gradient).toMatchObject({
      kind: 'radial',
      stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#d9d9d9' }],
    });
    expect(blob?.type === 'path' && blob.fill).toBe('#ffffff'); // representative = first stop
  });

  test('style fillRef paints resolve via the theme fill style list (phClr = the ref color)', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const shapes = pages[0]!.shapes ?? [];
    const refGrad = shapes.find((s) => s.type === 'shape' && s.gradient && s.gradient.stops.some((stop) => stop.color === '#ff8080'));
    expect(refGrad?.type === 'shape' && refGrad.gradient).toMatchObject({
      kind: 'linear',
      stops: [{ pos: 0, color: '#ff8080' }, { pos: 1, color: '#ff0000' }],
    });
    const fills = shapes.filter((s) => s.type === 'shape').map((s) => (s as { fill: string }).fill);
    expect(fills).toContain('#4d4d4d'); // fillRef idx 1: solid phClr with ref-side lumMod
  });

  test('graphicFrame leaves a frame footprint decor entry', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const frames = (pages[0]!.shapes ?? []).filter((s) => s.type === 'frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.rect.w).toBeGreaterThan(0.2);
  });

  test('a blip-filled shape inside a group becomes image decor with its own extracted asset', async () => {
    const { pages, assets } = await extractPptxPages(await fixturePptx());
    const icon = (pages[0]!.shapes ?? []).find((s) => s.type === 'image');
    expect(icon).toBeDefined();
    expect(icon?.type === 'image' && icon.imageFile).toBe('page-0.decor-0.png');
    const asset = assets.find((a) => a.file === 'page-0.decor-0.png');
    expect(asset?.bytes).toEqual(new Uint8Array(PNG_ICON));
  });

  test('noFill line-only shapes stay invisible; text slot run colors resolve through the scheme', async () => {
    const { pages } = await extractPptxPages(await fixturePptx());
    const shapes = pages[0]!.shapes ?? [];
    // 7 painted decor entries + 1 frame; the line-only rect is NOT decor.
    expect(shapes).toHaveLength(8);
    expect(shapes.some((s) => 'fill' in s && s.fill === '#404040')).toBe(false);
    const year = pages[0]!.slots.find((s) => s.kind === 'text' && s.sampleText === '1185');
    expect(year?.kind === 'text' && year.color).toBe('#800000');
  });
});
