import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import JSZip from 'jszip';
import { documentPaths, type DocumentState, type StyleOp } from './document.ts';
import { newStyleOpId } from './store.ts';

/**
 * DOCX re-layout (design decision 5): deterministic style operations,
 * never the model. The engine reads the document's CURRENT style state
 * (section margins, default font/size, line spacing, heading
 * numbering), the user names a target, the change list is STAGED in
 * the panel, and "Terapkan" applies it by rewriting the DOCX package
 * XML. The original file is never overwritten — output is a new DOCX.
 * Only structured style properties change; content, tables, and
 * images are not reconstructed.
 */

export type DocxStyleState = {
  /** Margins in cm: [top, right, bottom, left] (first section). */
  marginsCm: [number, number, number, number];
  font: string;
  fontSizePt: number;
  lineSpacing: number;
  headingNumbered: boolean;
  headingFont: string;
  sections: number;
};

export type StyleTarget = {
  marginsCm?: [number, number, number, number];
  font?: string;
  fontSizePt?: number;
  lineSpacing?: number;
  headingNumbered?: boolean;
  headingFont?: string;
};

const TWIPS_PER_CM = 567;

async function loadZip(absPath: string): Promise<JSZip> {
  const bytes = await readFile(absPath);
  return JSZip.loadAsync(bytes);
}

function numAttr(xml: string, tag: string, attr: string): number | null {
  const match = xml.match(new RegExp(`<w:${tag}[^>]*w:${attr}="([0-9.-]+)"`));
  return match ? Number(match[1]) : null;
}

export async function inspectDocxStyles(absPath: string): Promise<DocxStyleState> {
  const zip = await loadZip(absPath);
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  const numberingXml = (await zip.file('word/numbering.xml')?.async('string')) ?? '';

  const pgMarBlocks = documentXml.match(/<w:pgMar[^>]*\/>/g) ?? [];
  const first = pgMarBlocks[0] ?? '';
  const marginsCm: [number, number, number, number] = [
    Math.round(((numAttr(first, 'pgMar', 'top') ?? 1440) / TWIPS_PER_CM) * 100) / 100,
    Math.round(((numAttr(first, 'pgMar', 'right') ?? 1440) / TWIPS_PER_CM) * 100) / 100,
    Math.round(((numAttr(first, 'pgMar', 'bottom') ?? 1440) / TWIPS_PER_CM) * 100) / 100,
    Math.round(((numAttr(first, 'pgMar', 'left') ?? 1440) / TWIPS_PER_CM) * 100) / 100,
  ];

  const docDefaults = stylesXml.match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/)?.[1] ?? '';
  const font = docDefaults.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1] ?? 'Calibri';
  const szVal = docDefaults.match(/<w:sz[^>]*w:val="([0-9]+)"/)?.[1];
  const fontSizePt = szVal ? Number(szVal) / 2 : 11;
  const lineVal = docDefaults.match(/<w:spacing[^>]*w:line="([0-9]+)"/)?.[1];
  const lineSpacing = lineVal ? Number(lineVal) / 240 : 1;
  const headingBlock = stylesXml.match(/<w:style[^>]*w:styleId="Heading1"[^>]*>([\s\S]*?)<\/w:style>/)?.[1] ?? '';
  const headingFont = headingBlock.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1] ?? font;
  const headingNumbered = /<w:numPr>/.test(headingBlock) || /<w:numPr>/.test(numberingXml) && /Heading1/.test(stylesXml) && /<w:numPr>/.test(headingBlock);

  return {
    marginsCm,
    font,
    fontSizePt,
    lineSpacing: Math.round(lineSpacing * 100) / 100,
    headingNumbered: /<w:numPr>/.test(headingBlock),
    headingFont,
    sections: Math.max(1, pgMarBlocks.length),
  };
}

const fmtMargins = (m: [number, number, number, number]): string => `margin ${m.map((v) => v.toFixed(2).replace(/\.?0+$/, '')).join('/')} cm (atas/kanan/bawah/kiri)`;

/** Build the staged change list (before → after) for a target; only real changes are staged. */
export function proposeStyleOps(current: DocxStyleState, target: StyleTarget): StyleOp[] {
  const ops: StyleOp[] = [];
  const push = (targetName: string, before: string, after: string): void => {
    if (before !== after) ops.push({ id: newStyleOpId(), target: targetName, before, after, applied: false });
  };
  if (target.marginsCm) push('margin', fmtMargins(current.marginsCm), fmtMargins(target.marginsCm));
  if (target.font) push('font', `font ${current.font}`, `font ${target.font}`);
  if (target.fontSizePt) push('fontSize', `ukuran font ${current.fontSizePt} pt`, `ukuran font ${target.fontSizePt} pt`);
  if (target.lineSpacing) push('lineSpacing', `spasi ${current.lineSpacing}`, `spasi ${target.lineSpacing}`);
  if (target.headingFont) push('headingFont', `font heading ${current.headingFont}`, `font heading ${target.headingFont}`);
  if (target.headingNumbered !== undefined) {
    push('headingNumbering', current.headingNumbered ? 'heading bernomor' : 'heading tanpa nomor', target.headingNumbered ? 'heading bernomor' : 'heading tanpa nomor');
  }
  return ops;
}

/**
 * Parse a re-layout instruction deterministically (no model): "margin
 * 4-3-3-3, Times New Roman 12, spasi 1.5, heading bernomor". Returns
 * null when nothing parseable was found.
 */
export function parseStyleInstruction(text: string): StyleTarget | null {
  const target: StyleTarget = {};
  const margin = text.match(/margin\s*:?\s*(\d+(?:[.,]\d+)?)\s*[-/]\s*(\d+(?:[.,]\d+)?)\s*[-/]\s*(\d+(?:[.,]\d+)?)\s*[-/]\s*(\d+(?:[.,]\d+)?)/i);
  if (margin) {
    target.marginsCm = [margin[1], margin[2], margin[3], margin[4]].map((v) => Number(v!.replace(',', '.'))) as [number, number, number, number];
  }
  const spasi = text.match(/spasi\s*:?\s*(\d+(?:[.,]\d+)?)/i);
  if (spasi) target.lineSpacing = Number(spasi[1]!.replace(',', '.'));
  if (/heading\s*(bernomor|ber-number|dinomori|numbered)/i.test(text)) target.headingNumbered = true;
  if (/heading\s*(tanpa nomor|tidak bernomor|unnumbered)/i.test(text)) target.headingNumbered = false;
  const font = text.match(/(?:font|huruf)\s*:?\s*([A-Za-z][A-Za-z0-9 ]{1,30}?)(?:\s*,|\s+\d+\s*(?:pt)?\b|$)/i);
  if (font) target.font = font[1]!.trim();
  const size = text.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:pt|point)\b/i) ?? text.match(/(?:font|huruf)[^0-9]{0,20}(\d{1,2})\b/i);
  if (size) target.fontSizePt = Number(size[1]!.replace(',', '.'));
  return Object.keys(target).length > 0 ? target : null;
}

function setAttr(xml: string, tagPattern: RegExp, attr: string, value: string): string {
  return xml.replace(tagPattern, (tag) => (new RegExp(`w:${attr}="[^"]*"`).test(tag) ? tag.replace(new RegExp(`w:${attr}="[^"]*"`), `w:${attr}="${value}"`) : tag.replace(/\/>$/, ` w:${attr}="${value}"/>`)));
}

async function ensureNumbering(zip: JSZip): Promise<void> {
  const numberingPath = 'word/numbering.xml';
  let xml = await zip.file(numberingPath)?.async('string');
  if (!xml) {
    xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>`;
    // Content types + relationship for the new part.
    let contentTypes = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
    if (!contentTypes.includes('/word/numbering.xml')) {
      contentTypes = contentTypes.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
      zip.file('[Content_Types].xml', contentTypes);
    }
    let rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
    if (!rels.includes('numbering.xml')) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
      const nextId = (ids.length ? Math.max(...ids) : 0) + 1;
      rels = rels.replace('</Relationships>', `<Relationship Id="rId${nextId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
      zip.file('word/_rels/document.xml.rels', rels);
    }
  }
  if (!/<w:abstractNum[^>]*w:abstractNumId="9871"/.test(xml)) {
    const abstract = `<w:abstractNum w:abstractNumId="9871"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="0" w:hanging="0"/></w:pPr></w:lvl></w:abstractNum>`;
    const num = `<w:num w:numId="9871"><w:abstractNumId w:val="9871"/></w:num>`;
    xml = xml.replace('</w:numbering>', `${abstract}${num}</w:numbering>`);
  }
  zip.file(numberingPath, xml);
}

/**
 * Apply staged ops to a copy of the DOCX; returns the new file's path.
 * The input file is opened read-only — the original stays byte-identical.
 */
export async function applyStyleOps(
  root: string,
  doc: DocumentState,
  inputAbsPath: string,
  ops: StyleOp[],
): Promise<{ path: string; bytes: number }> {
  const zip = await loadZip(inputAbsPath);
  const target: StyleTarget = {};
  for (const op of ops) {
    if (op.target === 'margin') {
      const nums = op.after.match(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
      if (nums) target.marginsCm = [nums[1], nums[2], nums[3], nums[4]].map(Number) as [number, number, number, number];
    } else if (op.target === 'font') target.font = op.after.replace(/^font\s+/, '');
    else if (op.target === 'headingFont') target.headingFont = op.after.replace(/^font heading\s+/, '');
    else if (op.target === 'fontSize') target.fontSizePt = Number(op.after.match(/(\d+(?:\.\d+)?)/)?.[1]);
    else if (op.target === 'lineSpacing') target.lineSpacing = Number(op.after.match(/(\d+(?:\.\d+)?)/)?.[1]);
    else if (op.target === 'headingNumbering') target.headingNumbered = op.after.includes('bernomor') && !op.after.includes('tanpa');
  }

  let documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  let stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';

  if (target.marginsCm) {
    const [top, right, bottom, left] = target.marginsCm.map((cm) => String(Math.round(cm * TWIPS_PER_CM)));
    documentXml = documentXml.replace(/<w:pgMar[^>]*\/>/g, (tag) => {
      let next = tag;
      for (const [attr, val] of [['top', top], ['right', right], ['bottom', bottom], ['left', left]] as const) {
        next = setAttr(next, /<w:pgMar[^>]*\/>/, attr, val!);
      }
      return next;
    });
  }

  const applyToDefaults = (xml: string): string => {
    const match = xml.match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/);
    if (!match) return xml;
    let defaults = match[1]!;
    // docDefaults children may be empty self-closed elements (the docx
    // library writes <w:rPrDefault/>) — expand them so properties can
    // be CREATED, not only rewritten.
    const ensureChild = (defaultsXml: string, tag: string, inner: string): string => {
      if (new RegExp(`<w:${tag}>`).test(defaultsXml)) return defaultsXml;
      if (new RegExp(`<w:${tag}\\/>`).test(defaultsXml)) return defaultsXml.replace(new RegExp(`<w:${tag}\\/>`), `<w:${tag}>${inner}</w:${tag}>`);
      return `<w:${tag}>${inner}</w:${tag}>${defaultsXml}`;
    };
    if (target.font || target.fontSizePt) {
      defaults = ensureChild(defaults, 'rPrDefault', '<w:rPr></w:rPr>');
    }
    if (target.lineSpacing) {
      defaults = ensureChild(defaults, 'pPrDefault', '<w:pPr></w:pPr>');
    }
    if (target.font) {
      if (/<w:rFonts[^>]*\/>/.test(defaults)) {
        defaults = defaults.replace(/<w:rFonts[^>]*\/>/, (tag) => {
          let next = tag;
          for (const attr of ['ascii', 'hAnsi', 'cs']) {
            next = new RegExp(`w:${attr}="[^"]*"`).test(next) ? next.replace(new RegExp(`w:${attr}="[^"]*"`), `w:${attr}="${target.font}"`) : next.replace(/\/>$/, ` w:${attr}="${target.font}"/>`);
          }
          return next;
        });
      } else {
        defaults = defaults.replace('<w:rPr>', `<w:rPr><w:rFonts w:ascii="${target.font}" w:hAnsi="${target.font}" w:cs="${target.font}"/>`);
      }
    }
    if (target.fontSizePt) {
      const half = String(Math.round(target.fontSizePt * 2));
      defaults = /<w:sz[^>]*\/>/.test(defaults)
        ? defaults.replace(/<w:sz[^>]*\/>/, (tag) => tag.replace(/w:val="[^"]*"/, `w:val="${half}"`))
        : defaults.replace('</w:rPr>', `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`);
    }
    if (target.lineSpacing) {
      const line = String(Math.round(target.lineSpacing * 240));
      defaults = /<w:spacing[^>]*\/>/.test(defaults)
        ? defaults.replace(/<w:spacing[^>]*\/>/, (tag) => (new RegExp('w:line="[^"]*"').test(tag) ? tag.replace(/w:line="[^"]*"/, `w:line="${line}"`) : tag.replace(/\/>$/, ` w:line="${line}" w:lineRule="auto"/>`)))
        : defaults.replace('</w:pPr>', `<w:spacing w:line="${line}" w:lineRule="auto"/></w:pPr>`);
    }
    return xml.replace(match[0], `<w:docDefaults>${defaults}</w:docDefaults>`);
  };
  stylesXml = applyToDefaults(stylesXml);

  if (target.headingFont) {
    stylesXml = stylesXml.replace(/(<w:style[^>]*w:styleId="Heading1"[^>]*>[\s\S]*?<w:rFonts[^>]*?)w:ascii="[^"]*"/, `$1w:ascii="${target.headingFont}"`);
  }

  if (target.headingNumbered === true) {
    await ensureNumbering(zip);
    const blockMatch = stylesXml.match(/<w:style[^>]*w:styleId="Heading1"[^>]*>[\s\S]*?<\/w:style>/);
    if (blockMatch && !/<w:numPr>/.test(blockMatch[0])) {
      let block = blockMatch[0];
      if (/<w:pPr>/.test(block)) {
        block = block.replace('<w:pPr>', '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9871"/></w:numPr>');
      } else if (/<w:rPr>/.test(block)) {
        block = block.replace('<w:rPr>', '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9871"/></w:numPr></w:pPr><w:rPr>');
      } else {
        block = block.replace(/<\/w:style>$/, '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9871"/></w:numPr></w:pPr></w:style>');
      }
      stylesXml = stylesXml.replace(blockMatch[0], block);
    }
  } else if (target.headingNumbered === false) {
    const blockMatch = stylesXml.match(/<w:style[^>]*w:styleId="Heading1"[^>]*>[\s\S]*?<\/w:style>/);
    if (blockMatch && /<w:numPr>/.test(blockMatch[0])) {
      stylesXml = stylesXml.replace(blockMatch[0], blockMatch[0].replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, ''));
    }
  }

  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);

  const paths = documentPaths(root, doc.id);
  await mkdir(paths.exportsDir, { recursive: true });
  const base = basename(inputAbsPath).replace(/\.docx$/i, '');
  const name = `${base}-tata-ulang.docx`;
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(join(paths.exportsDir, name), buffer);
  for (const op of ops) op.applied = true;
  return { path: `.daedalus/documents/${doc.id}/exports/${name}`, bytes: buffer.length };
}
