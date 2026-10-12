import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyDeckOps,
  assignTemplatePages,
  deletePptxTemplate,
  exportDeckToPptx,
  extractPptxPages,
  fillDeckSlidesStage,
  generateDeckOutlineStage,
  getPptxTemplate,
  listPptxTemplates,
  newDeck,
  pptxTemplateAssetFiles,
  pptxTemplatesDir,
  readDeck,
  readPptxTemplateAsset,
  savePptxTemplate,
  slotMaxChars,
  templatePageTextSlots,
  validateDeck,
  validateTemplateSlideSlots,
  writeDeck,
  type DeckSpec,
  type LLMProvider,
  type Message,
  type PptxTemplate,
} from '../src/index.ts';
import { EventBus } from '../src/events.ts';
import { TaskStore } from '../src/persistence.ts';
import { TaskRunner } from '../src/runtime.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------------------ fixture */

/** 1x1 emerald PNG standing in for template artwork. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const CX = 12192000;
const CY = 6858000;
const emuX = (frac: number): number => Math.round(frac * CX);
const emuY = (frac: number): number => Math.round(frac * CY);

type SpOpts = { x?: number; y?: number; w?: number; h?: number; size?: number; bold?: boolean; font?: string; color?: string; align?: string; phType?: string; phIdx?: number; noXfrm?: boolean };

function sp(text: string, o: SpOpts = {}): string {
  const { x = 0.1, y = 0.1, w = 0.5, h = 0.1, size = 1800, bold = false, font = 'Georgia', color = 'FFFFFF', align = 'l' } = o;
  const rPr = `<a:rPr lang="id-ID" sz="${size}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:rPr>`;
  const ph = o.phType ? `<p:nvPr><p:ph type="${o.phType}"${o.phIdx !== undefined ? ` idx="${o.phIdx}"` : ''}/></p:nvPr>` : '<p:nvPr/>';
  const xfrm = o.noXfrm ? '' : `<p:spPr><a:xfrm><a:off x="${emuX(x)}" y="${emuY(y)}"/><a:ext cx="${emuX(w)}" cy="${emuY(h)}"/></a:xfrm></p:spPr>`;
  const paras = text.split('\n').map((line) => `<a:p><a:pPr algn="${align}"/><a:r>${rPr}<a:t>${line}</a:t></a:r></a:p>`).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/>${ph}</p:nvSpPr>${xfrm}<p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
}

function pic(embed: string, x: number, y: number, w: number, h: number): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${emuX(x)}" y="${emuY(y)}"/><a:ext cx="${emuX(w)}" cy="${emuY(h)}"/></a:xfrm></p:spPr></p:pic>`;
}

function slideXml(body: string, bg = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;
}

function relsXml(entries: Array<[string, string, string]>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A six-page Emerald deck: cover (image background + big serif title),
 * agenda, section divider, two different content designs (one with a
 * picture slot), closing — the reference shape for template mode.
 */
async function emeraldPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${[1, 2, 3, 4, 5, 6].map((i) => `<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...[1, 2, 3, 4, 5, 6].map((i): [string, string, string] => [`rId${i + 1}`, 'slide', `slides/slide${i}.xml`])]));
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B3D2E"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Emerald"><a:themeElements><a:clrScheme name="Emerald"><a:dk1><a:srgbClr val="12241C"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0B3D2E"/></a:dk2><a:lt2><a:srgbClr val="F5EFDB"/></a:lt2><a:accent1><a:srgbClr val="0E7A5F"/></a:accent1><a:accent2><a:srgbClr val="C9A227"/></a:accent2><a:accent3><a:srgbClr val="68D8B2"/></a:accent3><a:accent4><a:srgbClr val="2E5941"/></a:accent4><a:accent5><a:srgbClr val="FFD97A"/></a:accent5><a:accent6><a:srgbClr val="7AC74F"/></a:accent6><a:hlink><a:srgbClr val="0E7A5F"/></a:hlink><a:folHlink><a:srgbClr val="0E7A5F"/></a:folHlink></a:clrScheme><a:fontScheme name="EmeraldFonts"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
  // Layout carries a title placeholder WITH geometry: the section slide's
  // slot has no xfrm of its own and must inherit this rect.
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp('Layout title', { x: 0.08, y: 0.3, w: 0.84, h: 0.2, size: 4000, phType: 'title', phIdx: 0 })}</p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/media/image1.png', PNG_1PX);
  zip.file('ppt/media/image2.png', PNG_1PX);

  const bgImage = '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>';
  const slides = [
    slideXml(
      sp('Taksonomi Virus Dunia', { x: 0.1, y: 0.3, w: 0.8, h: 0.25, size: 4400, bold: true, font: 'Georgia', color: 'FFD97A', align: 'ctr' }) +
      sp('Panduan lapangan untuk pemula', { x: 0.2, y: 0.6, w: 0.6, h: 0.12, size: 1800, font: 'Verdana', color: 'FFFFFF', align: 'ctr' }),
      bgImage,
    ),
    slideXml(
      sp('Daftar Isi', { x: 0.08, y: 0.08, w: 0.5, h: 0.12, size: 3200, bold: true }) +
      sp('01 Keluarga virus', { x: 0.1, y: 0.28, w: 0.7, h: 0.08, size: 1600 }) +
      sp('02 Cara penularan', { x: 0.1, y: 0.42, w: 0.7, h: 0.08, size: 1600 }) +
      sp('03 Gejala utama', { x: 0.1, y: 0.56, w: 0.7, h: 0.08, size: 1600 }) +
      sp('04 Pencegahan', { x: 0.1, y: 0.7, w: 0.7, h: 0.08, size: 1600 }),
    ),
    slideXml(sp('Bagian Satu', { size: 4800, bold: true, noXfrm: true, phType: 'title', phIdx: 0 })),
    slideXml(
      sp('Keluarga Coronaviridae', { x: 0.06, y: 0.06, w: 0.6, h: 0.12, size: 2800, bold: true }) +
      sp('Virus RNA untai tunggal dengan amplop lipid dan protein spike di permukaannya.', { x: 0.06, y: 0.25, w: 0.5, h: 0.5, size: 1400, font: 'Verdana' }) +
      pic('rId8', 0.62, 0.2, 0.32, 0.6),
    ),
    slideXml(
      sp('Penularan Antarmanusia', { x: 0.06, y: 0.06, w: 0.88, h: 0.12, size: 2800, bold: true }) +
      sp('Droplet pernapasan adalah jalur utama, disusul kontak permukaan terkontaminasi.', { x: 0.06, y: 0.3, w: 0.88, h: 0.4, size: 1400, font: 'Verdana' }),
    ),
    slideXml(sp('Terima Kasih', { x: 0.15, y: 0.38, w: 0.7, h: 0.2, size: 4000, bold: true, align: 'ctr', color: 'FFD97A' })),
  ];
  slides.forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    const entries: Array<[string, string, string]> = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    if (i === 0) entries.push(['rId9', 'image', '../media/image1.png']);
    if (i === 3) entries.push(['rId8', 'image', '../media/image2.png']);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relsXml(entries));
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------- parser */

describe('extractPptxPages', () => {
  test('parses pages in presentation order: kinds, slots, rects, caps, image slots', async () => {
    const extract = await extractPptxPages(await emeraldPptx());
    expect(extract.pages.map((page) => page.kind)).toEqual(['cover', 'toc', 'section', 'content', 'content', 'closing']);

    const cover = extract.pages[0]!;
    expect(cover.background?.imageFile).toBe('page-0.background.png');
    expect(cover.background?.color).toBeUndefined();
    const coverText = templatePageTextSlots(cover);
    expect(coverText).toHaveLength(2);
    const title = coverText[0]!;
    expect(title.sampleText).toBe('Taksonomi Virus Dunia');
    expect(title.fontSizePt).toBe(44);
    expect(title.bold).toBe(true);
    expect(title.fontFamily).toBe('Georgia');
    expect(title.color).toBe('#ffd97a');
    expect(title.align).toBe('center');
    expect(title.rect.x).toBeCloseTo(0.1);
    expect(title.rect.y).toBeCloseTo(0.3);
    expect(title.rect.w).toBeCloseTo(0.8);
    expect(title.maxChars).toBeGreaterThanOrEqual(title.sampleText.length);
    expect(title.maxChars).toBeLessThanOrEqual(800);

    const toc = extract.pages[1]!;
    expect(toc.background?.color).toBe('#0b3d2e'); // master fallback
    expect(templatePageTextSlots(toc)).toHaveLength(5);

    // Section title inherits the layout placeholder's rect.
    const section = extract.pages[2]!;
    expect(section.slots).toHaveLength(1);
    const sectionSlot = templatePageTextSlots(section)[0]!;
    expect(sectionSlot.rect.x).toBeCloseTo(0.08);
    expect(sectionSlot.rect.y).toBeCloseTo(0.3);
    expect(sectionSlot.fontSizePt).toBe(48);

    // Content page A: title + body + picture slot with original bytes.
    const contentA = extract.pages[3]!;
    expect(contentA.slots.map((slot) => slot.kind)).toEqual(['text', 'text', 'image']);
    const imageSlot = contentA.slots[2]!;
    expect(imageSlot.kind).toBe('image');
    if (imageSlot.kind === 'image') {
      expect(imageSlot.imageFile).toBe('page-3.pic-0.png');
      expect(imageSlot.rect.x).toBeCloseTo(0.62);
    }
    const assetNames = extract.assets.map((asset) => asset.file);
    expect(assetNames).toContain('page-0.background.png');
    expect(assetNames).toContain('page-3.pic-0.png');
  });

  test('slotMaxChars is deterministic, fit-bound, and never below the sample', () => {
    const rect = { x: 0.1, y: 0.1, w: 0.5, h: 0.2 };
    const cap = slotMaxChars(rect, 14, CX, CY, 'short sample');
    expect(cap).toBe(slotMaxChars(rect, 14, CX, CY, 'short sample'));
    expect(cap).toBeGreaterThanOrEqual(10);
    expect(cap).toBeLessThanOrEqual(800);
    // A roomy box at a small size earns a bigger budget than a tight box.
    expect(slotMaxChars({ x: 0, y: 0, w: 0.9, h: 0.8 }, 12, CX, CY, '')).toBeGreaterThan(cap);
    // A long sample the template itself held is always allowed.
    expect(slotMaxChars({ x: 0, y: 0, w: 0.05, h: 0.05 }, 24, CX, CY, 'x'.repeat(120))).toBeGreaterThanOrEqual(120);
  });

  test('validateTemplateSlideSlots speaks repair language (unknown key, over-cap, non-string)', async () => {
    const extract = await extractPptxPages(await emeraldPptx());
    const cover = extract.pages[0]!;
    expect(validateTemplateSlideSlots(cover, { s0: 'Judul Baru', s1: 'Sub baru' })).toEqual([]);
    expect(validateTemplateSlideSlots(cover, { s9: 'x' }).join(' ')).toContain('unknown slot');
    expect(validateTemplateSlideSlots(cover, { s0: 42 }).join(' ')).toContain('must be a string');
    const over = validateTemplateSlideSlots(cover, { s0: 'x'.repeat(900) });
    expect(over.join(' ')).toContain("exceeds this slot's capacity");
  });
});

/* -------------------------------------------------------------- store */

describe('PPT template store with pages (v2)', () => {
  test('save stores pages + assets beside the JSON; delete sweeps every <id>.* file', async () => {
    const root = temp('daedalus-ppt-pages-store-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    expect(template.id).toBe('emeralddeck');
    expect(template.pages).toHaveLength(6);
    expect(template.theme.accent).toBe('#0e7a5f');

    const dir = pptxTemplatesDir(root);
    const files = readdirSync(dir);
    expect(files).toContain('emeralddeck.json');
    expect(files).toContain('emeralddeck.page-0.background.png');
    expect(files).toContain('emeralddeck.page-3.pic-0.png');
    for (const page of template.pages!) {
      for (const file of pptxTemplateAssetFiles({ pages: [page] })) {
        expect(files).toContain(file);
      }
    }

    const got = await getPptxTemplate(root, template.id);
    expect(got?.pages?.map((page) => page.kind)).toEqual(['cover', 'toc', 'section', 'content', 'content', 'closing']);

    // Asset endpoint backing store: referenced files served, others refused.
    const served = await readPptxTemplateAsset(root, template.id, 'emeralddeck.page-3.pic-0.png');
    expect(served?.bytes.length).toBe(PNG_1PX.length);
    expect(await readPptxTemplateAsset(root, template.id, 'emeralddeck.json')).toBeUndefined();
    expect(await readPptxTemplateAsset(root, template.id, '../deck.json')).toBeUndefined();
    expect(await readPptxTemplateAsset(root, template.id, 'other.page-0.background.png')).toBeUndefined();

    expect(await deletePptxTemplate(root, template.id)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith('emeralddeck'))).toEqual([]);
    expect(await getPptxTemplate(root, template.id)).toBeUndefined();
  });

  test('v1-era stored templates without pages still load (skin fallback)', async () => {
    const root = temp('daedalus-ppt-pages-v1-');
    const dir = pptxTemplatesDir(root);
    mkdirSync(dir, { recursive: true });
    const v1: Omit<PptxTemplate, 'pages'> = {
      id: 'warisan',
      name: 'Warisan',
      sourceFile: 'Warisan.pptx',
      createdAt: '2026-10-01T00:00:00.000Z',
      theme: { dark: true, background: '#201f26', text: '#ecebf0', accent: '#6b50ff' },
    };
    writeFileSync(join(dir, 'warisan.json'), JSON.stringify(v1));
    const list = await listPptxTemplates(root);
    expect(list.map((t) => t.id)).toContain('warisan');
    const got = await getPptxTemplate(root, 'warisan');
    expect(got?.pages).toBeUndefined();
  });
});

/* ------------------------------------------------------------ mapping */

describe('assignTemplatePages', () => {
  const pages = [
    { kind: 'cover' as const, slots: [] },
    { kind: 'toc' as const, slots: [] },
    { kind: 'section' as const, slots: [] },
    { kind: 'content' as const, slots: [] },
    { kind: 'content' as const, slots: [] },
    { kind: 'closing' as const, slots: [] },
  ];

  test('first → cover, agenda → toc, section → section, last → closing', () => {
    const roles = [
      { role: 'cover' as const },
      { role: 'toc' as const },
      { role: 'section' as const },
      { role: 'content' as const },
      { role: 'content' as const },
      { role: 'closing' as const },
    ];
    expect(assignTemplatePages(roles, pages)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('content slides cycle distinct variants: reuse beyond 2x only when every variant is there', () => {
    const roles = [{ role: 'cover' as const }, ...Array.from({ length: 5 }, () => ({ role: 'content' as const }))];
    const mapped = assignTemplatePages(roles, pages.slice(0, 5));
    const usage = new Map<number, number>();
    for (const page of mapped.slice(1)) usage.set(page, (usage.get(page) ?? 0) + 1);
    // Two content designs (3,4) over 5 picks: split 3/2, never 4/1.
    expect([...usage.values()].sort()).toEqual([2, 3]);
    expect(Math.min(...usage.values())).toBeGreaterThanOrEqual(2);
  });

  test('missing kinds fall back to the content pool', () => {
    const noToc = [pages[0]!, pages[3]!, pages[5]!];
    const mapped = assignTemplatePages([{ role: 'cover' as const }, { role: 'toc' as const }, { role: 'closing' as const }], noToc);
    expect(mapped[0]).toBe(0);
    expect(mapped[1]).toBe(1); // the only content page
    expect(mapped[2]).toBe(2); // closing exists
  });
});

/* --------------------------------------------------------- generation */

function textOf(message: Message | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

/**
 * Scripted provider for template mode. OUTLINE answers roles; FILL
 * answers the exact slot keys listed in the prompt, with short text —
 * except call `overCapOnCall`, which first returns an over-cap body so
 * the retry path is exercised.
 */
function templateProvider(overCapOnCall = -1): { provider: LLMProvider; calls: Array<{ system: string; user: string; convo: string }> } {
  const calls: Array<{ system: string; user: string; convo: string }> = [];
  const provider: LLMProvider = {
    name: 'template-scripted',
    async chat(messages: Message[]) {
      const system = textOf(messages[0]);
      const user = textOf(messages[1]);
      const convo = messages.map((m) => textOf(m)).join('\n');
      calls.push({ system, user, convo });
      if (system.includes('OUTLINE stage')) {
        const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 6);
        const roles = ['cover', 'toc', 'section', 'content', 'content', 'closing'];
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify(
              Array.from({ length: count }, (_, i) => ({
                title: `Judul ${i + 1} tentang virus`,
                keyMessage: `pesan kunci ${i + 1}`,
                role: roles[Math.min(i, roles.length - 1)],
              })),
            ),
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          finish_reason: 'stop',
        };
      }
      if (system.includes('FILL stage')) {
        const slotKeys = [...user.matchAll(/^- (s\d+):/gm)].map((m) => m[1]!);
        const out: Record<string, string> = {};
        slotKeys.forEach((key, i) => {
          out[key] = calls.length === overCapOnCall && i === slotKeys.length - 1 ? 'x'.repeat(900) : `Isi ${key} tentang virus berbahaya`;
        });
        return {
          message: { role: 'assistant' as const, content: JSON.stringify(out) },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          finish_reason: 'stop',
        };
      }
      return { message: { role: 'assistant' as const, content: '{}' }, finish_reason: 'stop' };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
  return { provider, calls };
}

describe('template-mode generation (pipeline)', () => {
  test('outline → template skeletons → fill only the words; image slots stay untouched', async () => {
    const root = temp('daedalus-ppt-pages-gen-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    const { provider, calls } = templateProvider();

    const staged = await generateDeckOutlineStage(provider, root, {
      topic: 'taksonomi virus berbahaya',
      slideCount: 6,
      customTemplateId: template.id,
    });
    expect(staged.deck.theme.customTemplateId).toBe(template.id);
    expect(staged.deck.slides).toHaveLength(6);
    expect(staged.deck.slides.map((slide) => slide.templateRef?.page)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(staged.deck.slides.every((slide) => slide.layout === 'template-page' && slide.status === 'skeleton')).toBe(true);
    // Skeleton words: the template's own samples, title slot = outline title.
    const coverSlide = staged.deck.slides[0]!;
    const coverSlots = coverSlide.content.slots as Record<string, string>;
    expect(coverSlots.s0).toBe('Judul 1 tentang virus');
    expect(coverSlots.s1).toBe('Panduan lapangan untuk pemula');
    const contentSlide = staged.deck.slides[3]!;
    expect((contentSlide.content.slots as Record<string, string>).s2).toBe('');

    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.failures).toEqual([]);
    expect(fill.exported?.slides).toBe(6);
    const deck = (await readDeck(root))!;
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true);
    const filledContent = deck.slides[3]!.content.slots as Record<string, string>;
    expect(filledContent.s0).toContain('virus berbahaya');
    expect(filledContent.s2).toBe(''); // the image slot: AI never fills it
    expect(calls.filter((call) => call.system.includes('TEMPLATE MODE'))).toHaveLength(7); // 1 outline + 6 fills
    expect(validateDeck(deck, { root }).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('over-cap fill output is rejected and retried with the verbatim issue', async () => {
    const root = temp('daedalus-ppt-pages-retry-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    // Find the call index of the first FILL: outline is call 1, so call 2
    // is the first fill — make it overflow.
    const { provider, calls } = templateProvider(2);
    await generateDeckOutlineStage(provider, root, { topic: 'virus', slideCount: 6, customTemplateId: template.id });
    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.failures).toEqual([]);
    const retried = calls.filter((call) => call.system.includes('FILL stage') && call.convo.includes('exceeds this slot'));
    expect(retried.length).toBeGreaterThanOrEqual(1);
    const deck = (await readDeck(root))!;
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true);
  });

  test('a skin-only stored template (no pages) keeps the v1 catalog path', async () => {
    const root = temp('daedalus-ppt-pages-skin-');
    const dir = pptxTemplatesDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'warisan.json'), JSON.stringify({
      id: 'warisan',
      name: 'Warisan',
      sourceFile: 'Warisan.pptx',
      createdAt: '2026-10-01T00:00:00.000Z',
      theme: { dark: true, background: '#101418', text: '#f7f3e8', accent: '#c59a46' },
    }));
    const catalogProvider: LLMProvider = {
      name: 'catalog-scripted',
      async chat(messages: Message[]) {
        const system = textOf(messages[0]);
        const user = textOf(messages[1]);
        if (system.includes('OUTLINE stage') && !system.includes('TEMPLATE MODE')) {
          const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2);
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify(Array.from({ length: count }, (_, i) => ({ title: `Slide ${i + 1}`, layoutId: i === 0 ? 'title' : 'bullets', keyMessage: 'pesan' }))),
            },
            finish_reason: 'stop',
          };
        }
        return { message: { role: 'assistant' as const, content: JSON.stringify({ title: 'Judul', points: ['satu', 'dua'] }) }, finish_reason: 'stop' };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const staged = await generateDeckOutlineStage(catalogProvider, root, { topic: 'virus', slideCount: 2, customTemplateId: 'warisan' });
    expect(staged.deck.slides.every((slide) => slide.layout !== 'template-page')).toBe(true);
    expect(staged.deck.theme.customTemplateId).toBe('warisan');
    expect(staged.deck.theme.accent).toBe('#c59a46');
  });

  test('unknown or conflicting template selection fails honestly', async () => {
    const root = temp('daedalus-ppt-pages-missing-');
    const { provider } = templateProvider();
    await expect(generateDeckOutlineStage(provider, root, { topic: 'virus', customTemplateId: 'tidak-ada' })).rejects.toThrow(/tidak ditemukan/);
    await expect(generateDeckOutlineStage(provider, root, { topic: 'virus', templateId: 'ocean', customTemplateId: 'emeralddeck' })).rejects.toThrow(/pilih satu/);
  });
});

/* --------------------------------------------------------- validation */

describe('validateDeck template rules', () => {
  async function stagedDeck(root: string): Promise<{ deck: DeckSpec; templateId: string }> {
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    const { provider } = templateProvider();
    const staged = await generateDeckOutlineStage(provider, root, { topic: 'virus', slideCount: 6, customTemplateId: template.id });
    await fillDeckSlidesStage(provider, root, {});
    return { deck: (await readDeck(root)) ?? staged.deck, templateId: template.id };
  }

  test('a generated template deck validates clean', async () => {
    const root = temp('daedalus-ppt-pages-valid-');
    const { deck } = await stagedDeck(root);
    expect(validateDeck(deck, { root }).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('over-cap words, unknown slots, unknown template, missing ref are errors', async () => {
    const root = temp('daedalus-ppt-pages-invalid-');
    const { deck, templateId } = await stagedDeck(root);
    const clone = (): DeckSpec => JSON.parse(JSON.stringify(deck)) as DeckSpec;
    const codes = (d: DeckSpec): string[] => validateDeck(d, { root }).filter((issue) => issue.severity === 'error').map((issue) => issue.code);

    const overCap = clone();
    (overCap.slides[0]!.content.slots as Record<string, string>).s0 = 'x'.repeat(900);
    expect(codes(overCap)).toContain('slot-too-long');

    const unknownSlot = clone();
    (unknownSlot.slides[0]!.content.slots as Record<string, string>).s9 = 'halo';
    expect(codes(unknownSlot)).toContain('template-slot');

    const unknownTemplate = clone();
    unknownTemplate.slides[0]!.templateRef = { templateId: 'tidak-ada', page: 0 };
    expect(codes(unknownTemplate)).toContain('unknown-template');

    const missingRef = clone();
    delete missingRef.slides[0]!.templateRef;
    expect(codes(missingRef)).toContain('template-ref-missing');

    const mismatch = clone();
    mismatch.slides[0]!.layout = 'bullets';
    expect(codes(mismatch)).toContain('template-layout-mismatch');

    const outOfRange = clone();
    outOfRange.slides[0]!.templateRef = { templateId, page: 99 };
    expect(codes(outOfRange)).toContain('template-page-out-of-range');

    const missingAsset = clone();
    (missingAsset.slides[3]!.content.slots as Record<string, string>).s2 = 'tidak-ada.png';
    expect(codes(missingAsset)).toContain('missing-asset');
  });

  test('template slides skip the density/position rules but keep others', async () => {
    const root = temp('daedalus-ppt-pages-density-');
    const { deck } = await stagedDeck(root);
    const slide = deck.slides[3]!;
    slide.positions = { s0: { x: 0.1, y: 0.1 } };
    const errors = validateDeck(deck, { root }).filter((issue) => issue.severity === 'error' && issue.slideId === slide.id);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------- export */

function unzipText(file: string): Map<string, string> {
  const buf = readFileSync(file);
  const out = new Map<string, string>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('template slide export', () => {
  test('exports bg image, native text at slot geometry with slot fonts, and the template picture', async () => {
    const root = temp('daedalus-ppt-pages-export-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    const { provider } = templateProvider();
    await generateDeckOutlineStage(provider, root, { topic: 'virus', slideCount: 6, customTemplateId: template.id });
    const fill = await fillDeckSlidesStage(provider, root, {});
    expect(fill.exported).toBeDefined();
    const parts = unzipText(join(root, fill.exported!.path));

    const coverXml = parts.get('ppt/slides/slide1.xml')!;
    expect(coverXml).toContain('<p:bg>');
    expect(coverXml).toContain('blipFill');
    expect(coverXml).toContain('Isi s0 tentang virus berbahaya');
    expect(coverXml).toContain('typeface="Georgia"');
    expect(coverXml).toContain('sz="4400"');
    // The title box sits at the slot rect (0.1, 0.3 of the slide).
    const offs = [...coverXml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(offs.some(([x, y]) => Math.abs(x - emuX(0.1)) < 1000 && Math.abs(y - emuY(0.3)) < 1000)).toBe(true);
    // Template accent gold survives as the run color.
    expect(coverXml).toContain('FFD97A');

    const contentXml = parts.get('ppt/slides/slide4.xml')!;
    expect(contentXml).toContain('<p:pic>');
    const media = [...parts.keys()].filter((name) => name.startsWith('ppt/media/'));
    expect(media.length).toBeGreaterThanOrEqual(2); // cover bg + content picture (+ maybe master reuse)

    // Honest degradation: template deleted after generation → the slide
    // still exports theme bg + its words, never a crash or a fake image.
    await deletePptxTemplate(root, template.id);
    const deck = (await readDeck(root))!;
    const again = await exportDeckToPptx(deck, root);
    const parts2 = unzipText(join(root, again.relativePath));
    expect(parts2.get('ppt/slides/slide1.xml')).toContain('Isi s0 tentang virus berbahaya');
  });

  test('a chosen deck asset replaces the template picture at the same rect', async () => {
    const root = temp('daedalus-ppt-pages-export-img-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    const { provider } = templateProvider();
    await generateDeckOutlineStage(provider, root, { topic: 'virus', slideCount: 6, customTemplateId: template.id });
    await fillDeckSlidesStage(provider, root, {});
    const deck = (await readDeck(root))!;
    // The user clicked the image slot and uploaded their own picture.
    const assetsDir = join(root, 'deck', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'foto-sawah.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    (deck.slides[3]!.content.slots as Record<string, string>).s2 = 'foto-sawah.jpg';
    await writeDeck(root, deck);
    expect(validateDeck(deck, { root }).filter((issue) => issue.severity === 'error')).toEqual([]);
    const out = await exportDeckToPptx(deck, root);
    const parts = unzipText(join(root, out.relativePath));
    const contentXml = parts.get('ppt/slides/slide4.xml')!;
    expect(contentXml).toContain('<p:pic>');
    const rels = parts.get('ppt/slides/_rels/slide4.xml.rels')!;
    expect(rels).toContain('.jpg');
  });
});

/* -------------------------------------------------------------- engine */

describe('template mode through the engine + edit guard', () => {
  test('smart engine run with a PPT template exports a template deck; layout change via ops is refused', async () => {
    const root = temp('daedalus-ppt-pages-engine-');
    const template = await savePptxTemplate(root, { fileName: 'EmeraldDeck.pptx', bytes: await emeraldPptx() });
    const { provider } = templateProvider();
    const store = new TaskStore(temp('daedalus-ppt-pages-engine-store-'));
    const runner = new TaskRunner({ workspaceRoot: root, store, bus: new EventBus(), provider, approvalPolicy: 'auto' });

    const { state, outcome } = await runner.run({
      goal: 'buatkan slide tentang taksonomi virus',
      taskId: 'engine-template',
      domain: 'slide',
      slide: { generation: 'smart', slideCount: 6, customTemplateId: template.id },
    });
    expect(state.status).toBe('done');
    expect(outcome).toBe('success');
    const deck = (await readDeck(root))!;
    expect(deck.slides).toHaveLength(6);
    expect(deck.slides.every((slide) => slide.templateRef?.templateId === template.id)).toBe(true);
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true);

    // Edit guard: a template slide's layout cannot change; slot words can.
    const refused = applyDeckOps(deck, { ops: [{ op: 'update_slide', slide_id: deck.slides[0]!.id, layout: 'bullets', content: { title: 'X' } }] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.issues.join(' ')).toContain('layout cannot change');

    const ok = applyDeckOps(deck, { ops: [{ op: 'update_slide', slide_id: deck.slides[0]!.id, content: { slots: { s0: 'Judul Editanku', s1: 'Sub editan' } } }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect((ok.value.deck.slides[0]!.content.slots as Record<string, string>).s0).toBe('Judul Editanku');
      expect(ok.value.deck.slides[0]!.templateRef).toEqual({ templateId: template.id, page: 0 });
    }
  });
});
