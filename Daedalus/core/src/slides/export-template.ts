// Clone-and-rewrite PPTX export for template decks (Template dari PPT v3).
//
// The v2 export REDREW each template slide with pptxgenjs (background +
// slot boxes), which discarded every decorative element of the source
// design — Farid's downloaded templates (vector blobs, stars,
// illustrations) came out plain. This export instead clones the source
// .pptx package kept at import time (pptx-template.ts stores it beside
// the template JSON) and rewrites ONLY the AI's words and the user's
// clicked images inside the original slide XML. Every other shape, fill,
// geometry, chart, table, and animation stays byte-identical to the
// template the user downloaded.
//
// Precondition (checked by the caller in export-pptx.ts): EVERY slide of
// the deck is a template-page slide referencing ONE imported template
// that carries its source package. Anything else (mixed decks, skin-only
// templates, templates imported before v3) keeps the pptxgenjs path.
import JSZip from 'jszip';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { deckPaths, slugifyTitle, type DeckSpec } from './deck.ts';
import { matchPageAddresses, type PptxTemplatePageAddress } from './pptx-pages.ts';
import { readPptxTemplateSource, type PptxTemplate } from './pptx-template.ts';
import { createShapeKeyer, leafShapeKey, splitTopLevelElements, walkShapeTree } from './xml-shape-utils.ts';

export class TemplateCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateCloneError';
  }
}

export interface TemplateCloneExportResult {
  relativePath: string;
  bytes: number;
  slideCount: number;
}

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------ text rewrite */

interface RelEntry { id: string; type: string; target: string; tag: string }

function parseRelEntries(xml: string): RelEntry[] {
  const out: RelEntry[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    if (!id) continue;
    out.push({ id, type: /\bType="([^"]+)"/.exec(tag)?.[1] ?? '', target: /\bTarget="([^"]+)"/.exec(tag)?.[1] ?? '', tag });
  }
  return out;
}

function resolveRelTarget(basePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseDir = basePart.includes('/') ? basePart.slice(0, basePart.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const part of `${baseDir}${target}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** One paragraph rewritten to a single run carrying `line`, style kept. */
function rewriteParagraph(paragraphXml: string, line: string): string {
  const pPr = /<a:pPr\b[^>]*?\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(paragraphXml)?.[0] ?? '';
  if (line === '') return `<a:p>${pPr}</a:p>`;
  const escaped = escapeXmlText(line);
  const runXml = /<a:r>([\s\S]*?)<\/a:r>/.exec(paragraphXml)?.[1];
  const fldXml = runXml === undefined ? /<a:fld\b[^>]*>([\s\S]*?)<\/a:fld>/.exec(paragraphXml)?.[1] : undefined;
  const styleSource = runXml ?? fldXml;
  let rPr = '';
  if (styleSource !== undefined) {
    rPr = /<a:rPr\b[^>]*?\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(styleSource)?.[0] ?? '';
  } else {
    // No run at all: recycle the paragraph's end-mark properties as the
    // run properties (same attribute family) so size/color survive.
    const endPara = /<a:endParaRPr\b([^>]*?)(\/>|>([\s\S]*?)<\/a:endParaRPr>)/.exec(paragraphXml);
    if (endPara) rPr = `<a:rPr${endPara[1] ?? ''}>${endPara[3] ?? ''}</a:rPr>`;
  }
  return `<a:p>${pPr}<a:r>${rPr}<a:t xml:space="preserve">${escaped}</a:t></a:r></a:p>`;
}

/** Replaces a shape's text body with `text`, paragraph by paragraph. */
function rewriteTextBody(shapeXml: string, text: string): string {
  const txOpen = shapeXml.indexOf('<p:txBody>');
  const txClose = shapeXml.lastIndexOf('</p:txBody>');
  if (txOpen < 0 || txClose < txOpen) return shapeXml;
  const innerStart = txOpen + '<p:txBody>'.length;
  const inner = shapeXml.slice(innerStart, txClose);
  const paragraphs = [...inner.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)];
  const lines = text.split('\n');
  let rebuilt: string;
  if (paragraphs.length === 0) {
    rebuilt = inner + lines.map((line) => rewriteParagraph('<a:p></a:p>', line)).join('');
  } else {
    const firstParaStart = paragraphs[0]!.index;
    const lastPara = paragraphs[paragraphs.length - 1]!;
    const prefix = inner.slice(0, firstParaStart);
    const suffix = inner.slice(lastPara.index + lastPara[0].length);
    const count = Math.max(lines.length, 1);
    const paras: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const basePara = paragraphs[Math.min(i, paragraphs.length - 1)]![0];
      paras.push(rewriteParagraph(basePara, lines[i] ?? ''));
    }
    rebuilt = prefix + paras.join('') + suffix;
  }
  return shapeXml.slice(0, innerStart) + rebuilt + shapeXml.slice(txClose);
}

function dottedPath(path: number[]): string {
  return path.join('.');
}

/**
 * String surgery on one shape-tree level: text targets inside groups
 * recurse into the group's children (only when a target actually lives
 * under it, so untouched groups stay byte-identical); a target `sp`
 * gets its text body rewritten; every other byte passes through.
 */
function rewriteTreeLevel(inner: string, prefix: number[], targets: Map<string, string>): string {
  const elements = splitTopLevelElements(inner);
  if (elements.length === 0) return inner;
  let out = '';
  let cursor = 0;
  elements.forEach((element, index) => {
    const path = [...prefix, index];
    let xml = element.xml;
    if (element.tag === 'grpSp') {
      const under = `${dottedPath(path)}.`;
      let needed = false;
      for (const key of targets.keys()) {
        if (key.startsWith(under)) {
          needed = true;
          break;
        }
      }
      if (needed) {
        const openEnd = element.xml.indexOf('>');
        const closeStart = element.xml.lastIndexOf('</p:grpSp>');
        if (openEnd >= 0 && closeStart > openEnd) {
          xml = element.xml.slice(0, openEnd + 1)
            + rewriteTreeLevel(element.xml.slice(openEnd + 1, closeStart), path, targets)
            + element.xml.slice(closeStart);
        }
      }
    } else if (element.tag === 'sp') {
      const value = targets.get(dottedPath(path));
      if (value !== undefined) xml = rewriteTextBody(element.xml, value);
    }
    out += inner.slice(cursor, element.start);
    out += xml;
    cursor = element.end;
  });
  out += inner.slice(cursor);
  return out;
}

/**
 * Rewrites the text of the addressed shapes inside one slide part,
 * including shapes nested inside groups. Every other byte of the slide
 * — decorations, fills, geometry, charts — is carried over untouched.
 * A slot whose shape cannot be located keeps its original sample text
 * (honest: never a silently dropped box).
 *
 * Address resolution: a stored shapePath (child indices from the tree
 * root) wins when it resolves; otherwise the shapeKey is matched the
 * way pre-group exports did — keyed over the top-level elements — and
 * finally over the flattened leaf walk, so addresses stored by any
 * import vintage land on their shape.
 */
export function rewriteTemplateSlideText(
  slideXml: string,
  pageAddress: PptxTemplatePageAddress,
  values: Map<string, string>,
): string {
  const treeOpen = slideXml.indexOf('<p:spTree>');
  const treeClose = slideXml.lastIndexOf('</p:spTree>');
  if (treeOpen < 0 || treeClose < treeOpen) return slideXml;
  const innerStart = treeOpen + '<p:spTree>'.length;
  const inner = slideXml.slice(innerStart, treeClose);
  const textAddresses = pageAddress.slots.filter((slot) => slot.kind === 'text' && values.has(slot.key));
  if (textAddresses.length === 0) return slideXml;

  const leaves = walkShapeTree(inner);
  const leafByPath = new Map(leaves.map((leaf) => [dottedPath(leaf.shapePath), leaf]));
  // Keys as stored by pre-group imports: a keyer over the top-level
  // elements only, counting every element in document order.
  const topKeyToPath = new Map<string, string>();
  {
    const keyer = createShapeKeyer();
    splitTopLevelElements(inner).forEach((element, index) => {
      topKeyToPath.set(keyer(element.xml, index), dottedPath([index]));
    });
  }
  // Keys over the flattened walk (what group-aware imports store).
  const leafKeyToPath = new Map<string, string>();
  {
    const seen = new Map<string, number>();
    for (const leaf of leaves) leafKeyToPath.set(leafShapeKey(leaf.xml, leaf.shapePath, seen), dottedPath(leaf.shapePath));
  }

  const targets = new Map<string, string>();
  for (const address of textAddresses) {
    let path: string | undefined;
    if (address.shapePath && leafByPath.has(dottedPath(address.shapePath))) {
      path = dottedPath(address.shapePath);
    } else if (address.shapeKey) {
      path = topKeyToPath.get(address.shapeKey) ?? leafKeyToPath.get(address.shapeKey);
    }
    if (path !== undefined) targets.set(path, values.get(address.key)!);
  }
  if (targets.size === 0) return slideXml;
  return slideXml.slice(0, innerStart) + rewriteTreeLevel(inner, [], targets) + slideXml.slice(treeClose);
}

/* ------------------------------------------------------------ clone export */

interface SlidePlanEntry {
  slideXml: string;
  slideRelsXml?: string;
  layoutTarget?: string;
}

function slideRelsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return slash >= 0 ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` : `_rels/${part}.rels`;
}

/**
 * Exports `deck` by cloning the source package of `template`. Deck slide
 * order drives the new presentation: each generated slide clones the
 * slide part of the template page it references (duplicated under a new
 * part name when a page is reused), then its text slots are rewritten
 * with the deck's words and its clicked image slots' media bytes swapped.
 */
export async function exportTemplateDeckToPptx(deck: DeckSpec, root: string, template: PptxTemplate, options: { fileSuffix?: string } = {}): Promise<TemplateCloneExportResult> {
  const source = await readPptxTemplateSource(root, template.id);
  if (!source) {
    throw new TemplateCloneError(`template "${template.id}" tidak menyimpan berkas sumber .pptx-nya (impor ulang dari panel "Template dari PPT" untuk ekspor fidelitas penuh)`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(source.bytes);
  } catch {
    throw new TemplateCloneError(`berkas sumber template "${template.id}" rusak dan tidak bisa dibuka`);
  }
  const contentTypesFile = zip.file('[Content_Types].xml');
  const presFile = zip.file('ppt/presentation.xml');
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!contentTypesFile || !presFile || !presRelsFile) {
    throw new TemplateCloneError(`berkas sumber template "${template.id}" bukan PPTX yang utuh (bagian presentasi hilang)`);
  }
  let contentTypes = await contentTypesFile.async('string');
  const presXml = await presFile.async('string');
  const presRelsXml = await presRelsFile.async('string');

  // Source slides in presentation order: part name per sldId.
  const presRels = parseRelEntries(presRelsXml);
  const relById = new Map(presRels.map((rel) => [rel.id, rel]));
  const sourceParts: string[] = [];
  for (const match of presXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const rel = relById.get(match[1]!);
    if (rel) sourceParts.push(resolveRelTarget('ppt/presentation.xml', rel.target));
  }
  if (sourceParts.length === 0) {
    throw new TemplateCloneError(`berkas sumber template "${template.id}" tidak memuat daftar slide`);
  }
  // Page i of the parsed template is source slide i (same scrape order).
  const addresses: Array<PptxTemplatePageAddress | undefined> = [];
  for (let i = 0; i < sourceParts.length; i += 1) {
    const stored = template.sourceAddresses?.[i];
    if (stored) {
      addresses.push(stored);
      continue;
    }
    const page = template.pages?.[i];
    const slideFile = zip.file(sourceParts[i]!);
    if (!page || !slideFile) {
      addresses.push(undefined);
      continue;
    }
    const relsFile = zip.file(slideRelsPath(sourceParts[i]!));
    addresses.push(matchPageAddresses(await slideFile.async('string'), relsFile ? await relsFile.async('string') : '', sourceParts[i]!, page));
  }

  // Read the distinct source slides this deck actually uses.
  const sourceSlides = new Map<number, SlidePlanEntry>();
  const ensureSourceSlide = async (index: number): Promise<SlidePlanEntry> => {
    const cached = sourceSlides.get(index);
    if (cached) return cached;
    const part = sourceParts[index]!;
    const file = zip.file(part);
    if (!file) throw new TemplateCloneError(`halaman template ${index + 1} tidak ditemukan di berkas sumber template "${template.id}"`);
    const slideXml = await file.async('string');
    const relsFile = zip.file(slideRelsPath(part));
    const slideRelsXml = relsFile ? await relsFile.async('string') : undefined;
    const layoutRel = slideRelsXml ? parseRelEntries(slideRelsXml).find((rel) => /slideLayout/i.test(rel.type)) : undefined;
    const entry: SlidePlanEntry = { slideXml, ...(slideRelsXml ? { slideRelsXml } : {}), ...(layoutRel ? { layoutTarget: layoutRel.target } : {}) };
    sourceSlides.set(index, entry);
    return entry;
  };

  // Fresh part names for reused pages: continue the numeric sequence.
  let maxSlideNum = 0;
  for (const name of Object.keys(zip.files)) {
    const num = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1];
    if (num) maxSlideNum = Math.max(maxSlideNum, Number(num));
  }
  const usedCount = new Map<number, number>();
  const newSlideParts: Array<{ part: string; relTarget: string }> = [];
  const swapParts: Array<{ part: string; bytes: Buffer }> = [];
  const swapExts = new Set<string>();
  let swapSeq = 0;

  for (const slide of deck.slides) {
    const ref = slide.templateRef!;
    if (ref.page < 0 || ref.page >= sourceParts.length) {
      throw new TemplateCloneError(`slide "${slide.id}" merujuk halaman template ${ref.page + 1} yang tidak ada di berkas sumber`);
    }
    const entry = await ensureSourceSlide(ref.page);
    const sourcePart = sourceParts[ref.page]!;
    const seen = (usedCount.get(ref.page) ?? 0) + 1;
    usedCount.set(ref.page, seen);
    const part = seen === 1 ? sourcePart : `ppt/slides/slide${(maxSlideNum += 1)}.xml`;
    const address = addresses[ref.page];
    const rawSlots = typeof slide.content.slots === 'object' && slide.content.slots !== null && !Array.isArray(slide.content.slots)
      ? (slide.content.slots as Record<string, unknown>)
      : {};
    let xml = entry.slideXml;
    let outRels = entry.slideRelsXml;
    let relsMutated = false;
    if (address) {
      const values = new Map<string, string>();
      for (const slotAddress of address.slots) {
        if (slotAddress.kind !== 'text') continue;
        const value = rawSlots[slotAddress.key];
        if (typeof value === 'string') values.set(slotAddress.key, value);
      }
      xml = rewriteTemplateSlideText(xml, address, values);
      // Clicked image slots: the chosen deck asset becomes a NEW media
      // part and this slide's picture rel is retargeted to it. Per-slide
      // by construction: slides sharing the source media part keep the
      // original picture, any image format the deck accepts works, and
      // the content-types Default for the new extension is registered
      // below. Unclicked slots keep the original bytes, untouched.
      for (const slotAddress of address.slots) {
        if (slotAddress.kind !== 'image') continue;
        const chosen = rawSlots[slotAddress.key];
        if (typeof chosen !== 'string' || chosen === '' || basename(chosen) !== chosen) continue;
        const assetPath = join(deckPaths(root).assetsDir, chosen);
        if (!existsSync(assetPath)) continue;
        const ext = extname(chosen).toLowerCase();
        if (!IMAGE_CONTENT_TYPES[ext]) continue;
        const swapPart = `ppt/media/daedalus-swap-${(swapSeq += 1)}${ext}`;
        swapParts.push({ part: swapPart, bytes: await readFile(assetPath) });
        swapExts.add(ext);
        const rels = parseRelEntries(outRels ?? '');
        const rel = rels.find((r) => slotAddress.embedId !== undefined && r.id === slotAddress.embedId)
          ?? rels.find((r) => slotAddress.mediaPart !== undefined && resolveRelTarget(sourcePart, r.target) === slotAddress.mediaPart);
        if (rel && outRels) {
          outRels = outRels.replace(rel.tag, `<Relationship Id="${rel.id}" Type="${rel.type}" Target="../media/${basename(swapPart)}"/>`);
          relsMutated = true;
        } else if (rel) {
          outRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${rel.id}" Type="${rel.type}" Target="../media/${basename(swapPart)}"/></Relationships>`;
          relsMutated = true;
        }
      }
    }
    zip.file(part, xml);
    if (part !== sourcePart || relsMutated) {
      zip.file(slideRelsPath(part), outRels ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entry.layoutTarget ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${entry.layoutTarget}"/>` : ''}</Relationships>`);
      if (part !== sourcePart && !new RegExp(`PartName="/${part.replace(/\//g, '\\/')}"`).test(contentTypes)) {
        const override = `<Override PartName="/${part}" ContentType="${SLIDE_CONTENT_TYPE}"/>`;
        contentTypes = contentTypes.includes('</Types>') ? contentTypes.replace('</Types>', `${override}</Types>`) : contentTypes + override;
      }
    }
    newSlideParts.push({ part, relTarget: `slides/${basename(part)}` });
  }

  for (const swap of swapParts) zip.file(swap.part, swap.bytes);
  for (const ext of swapExts) {
    if (!new RegExp(`<Default Extension="${ext.slice(1)}"`).test(contentTypes)) {
      const def = `<Default Extension="${ext.slice(1)}" ContentType="${IMAGE_CONTENT_TYPES[ext]}"/>`;
      contentTypes = contentTypes.includes('</Types>') ? contentTypes.replace('</Types>', `${def}</Types>`) : contentTypes + def;
    }
  }

  // Presentation: keep everything but the slide id list; then rebuild it.
  const maxSldId = [...presXml.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].reduce((max, m) => Math.max(max, Number(m[1])), 255);
  const sldIds = newSlideParts.map((_, i) => `<p:sldId id="${maxSldId + 1 + i}" r:id="rIdNewSlide${i}"/>`).join('');
  const newPresXml = /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/.test(presXml)
    ? presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sldIds}</p:sldIdLst>`)
    : presXml.replace('</p:presentation>', `<p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/presentation.xml', newPresXml);

  const keptRels = presRels.filter((rel) => !rel.type.endsWith('/slide')).map((rel) => rel.tag).join('');
  const slideRels = newSlideParts
    .map((entry, i) => `<Relationship Id="rIdNewSlide${i}" Type="${SLIDE_REL_TYPE}" Target="${entry.relTarget}"/>`)
    .join('');
  const rebuiltPresRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${keptRels}${slideRels}</Relationships>`;
  zip.file('ppt/_rels/presentation.xml.rels', rebuiltPresRels);
  zip.file('[Content_Types].xml', contentTypes);

  const paths = deckPaths(root);
  await mkdir(paths.dir, { recursive: true });
  const fileName = `${slugifyTitle(deck.title)}${options.fileSuffix ? `-${options.fileSuffix}` : ''}.pptx`;
  const outPath = join(paths.dir, fileName);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outPath, buffer);
  const info = await stat(outPath);
  return { relativePath: `deck/${fileName}`, bytes: info.size, slideCount: deck.slides.length };
}
