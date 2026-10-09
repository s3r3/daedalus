import JSZip from 'jszip';
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { deckPaths, slugifyTitle, type DeckTheme } from './deck.ts';
import {
  extractPptxPageAddresses,
  extractPptxPages,
  pptxTemplateAssetFiles,
  prefixPageAssets,
  type PptxTemplatePage,
  type PptxTemplatePageAddress,
} from './pptx-pages.ts';

/**
 * Templates imported from a downloaded .pptx (Farid's "Template dari PPT"
 * panel), two layers:
 *
 * v1 (skin): the file's theme color scheme, font scheme, slide size, and
 * slide-master background are extracted once and stored as theme-token
 * data under `<workspace>/.daedalus/slide-templates/`, so they can be
 * applied to any deck exactly like the bundled templates in
 * slides/templates.ts (which stay the default).
 *
 * v2 (pages): the file's actual slide DESIGNS are parsed by
 * pptx-pages.ts into pages[] (background + text/image slots + page kind).
 * When a deck is generated with such a template, the outline is poured
 * into those pages and only the words change — font, color, and layout
 * all come from the template (the Docmee model). Decks whose template
 * has no pages[] (imported before v2, or unparseable slides) keep the
 * v1 skin behavior.
 *
 * v3 (fidelity): the uploaded .pptx itself is kept beside the JSON
 * (`<id>.source.pptx`) together with per-page slot→shape addresses
 * (sourceAddresses). When a deck references this template on EVERY
 * slide, export CLONES that package and rewrites only the AI's words
 * and the user's clicked images inside the original slide XML
 * (export-template.ts), so decorative shapes, charts, and tables
 * survive into the output untouched — the v2 pptxgenjs redraw only
 * approximates them. Templates imported before v3 have no source file
 * and keep the v2 export path; the canvas likewise only approximates.
 *
 * Extraction is deliberately per-field honest: a missing color or font
 * falls back to the bundled General tokens for that field, never a crash.
 * Only a file that is not a real PPTX at all (not a zip, or no
 * ppt/presentation.xml inside) is rejected outright.
 */
export class PptxTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PptxTemplateError';
    this.code = code;
  }
}

export type PptxSlideSize = {
  /** Raw EMU dimensions from <p:sldSz> (914400 EMU = 1 inch). */
  cx: number;
  cy: number;
  /** Human label: "16:9", "4:3", or the inch size for anything else. */
  label: string;
};

export type PptxTemplate = {
  /** Slug id (also the JSON filename stem under the template store). */
  id: string;
  /** Display name: the uploaded file's stem. */
  name: string;
  /** Original uploaded filename. */
  sourceFile: string;
  createdAt: string;
  /** Extracted design tokens in the DeckTheme shape renderers consume (without the apply-time stamps). */
  theme: DeckTheme;
  slideSize?: PptxSlideSize;
  /** Stored background image filename beside the JSON, when the master background is an image. */
  backgroundImageFile?: string;
  /**
   * v2: the source file's parsed slide designs, in presentation order.
   * Absent on templates imported before v2 (skin-only) or when no slide
   * could be parsed — generation then falls back to the skin path.
   */
  pages?: PptxTemplatePage[];
  /**
   * v3: the kept source .pptx (`<id>.source.pptx` in the store) the
   * clone-and-rewrite export clones from. Absent on templates imported
   * before v3 — those keep the v2 pptxgenjs export path.
   */
  sourceFileName?: string;
  /**
   * v3: per-page slot→shape addresses inside the kept source file,
   * parallel to pages[]. Present whenever sourceFileName is.
   */
  sourceAddresses?: PptxTemplatePageAddress[];
};

export const PPT_TEMPLATES_DIR = '.daedalus/slide-templates';
/** Upload cap for one .pptx (the server enforces the same number on the wire). Downloaded templates (Docmee etc.) routinely run 30–80 MB, so the cap sits well above the old 25 MB that rejected them. */
export const MAX_PPTX_TEMPLATE_BYTES = 100 * 1024 * 1024;

export function pptxTemplatesDir(root: string): string {
  return join(root, PPT_TEMPLATES_DIR);
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertTemplateId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new PptxTemplateError('invalid_template_id', `invalid slide template id "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// XML scraping (no XML dependency in core: theme/master parts are small and
// their attribute shapes stable across PowerPoint-compatible producers).
// ---------------------------------------------------------------------------

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match?.[1];
}

function schemeColor(block: string, name: string): string | undefined {
  const entry = new RegExp(`<a:${name}\\b[^>]*>([\\s\\S]*?)</a:${name}>`).exec(block);
  const inner = entry?.[1];
  if (!inner) return undefined;
  const srgb = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(inner)?.[1];
  if (srgb) return `#${srgb.toLowerCase()}`;
  const sys = /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(inner)?.[1];
  if (sys) return `#${sys.toLowerCase()}`;
  return undefined;
}

function schemeFont(block: string, part: 'majorFont' | 'minorFont'): string | undefined {
  const entry = new RegExp(`<a:${part}\\b[^>]*>\\s*<a:latin\\s+typeface="([^"]*)"`).exec(block);
  const value = entry?.[1]?.trim();
  return value ? value : undefined;
}

/** Resolve a relationship target (e.g. "../media/image1.png") against the part that owns the .rels file. */
function resolvePartPath(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

function relTarget(relsXml: string, id: string): string | undefined {
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(match[0], 'Id') === id) return attr(match[0], 'Target');
  }
  return undefined;
}

function firstPart(paths: string[], pattern: RegExp): string | undefined {
  return paths.filter((p) => pattern.test(p)).sort()[0];
}

// ---------------------------------------------------------------------------
// Color math for the two derived tokens (surface/muted): deterministic
// mixes toward the opposite pole, labelled approximations in the panel copy.
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.replace(/^#/, '');
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isHex(value: string | undefined): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// ---------------------------------------------------------------------------
// PNG average color: when the master background is an image, its average
// luminance — not the theme's lt1 slot — decides whether the design is a
// dark or light one, and the average itself stands in as the background
// token under the picture. Minimal decoder: 8-bit, non-interlaced PNGs
// (the overwhelmingly common master art); anything else returns undefined
// and the caller keeps the theme-derived fallback. JPEG/GIF masters are
// not sampled (no decoder exists in the standard library).
// ---------------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngAverageColor(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = 1;
    let palette: Uint8Array | undefined;
    const idat: Buffer[] = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        width = ((data[0] ?? 0) << 24) | ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0);
        height = ((data[4] ?? 0) << 24) | ((data[5] ?? 0) << 16) | ((data[6] ?? 0) << 8) | (data[7] ?? 0);
        bitDepth = data[8] ?? 0;
        colorType = data[9] ?? -1;
        interlace = data[12] ?? 1;
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data));
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || channels === 0 || idat.length === 0) return undefined;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)));
    let prev = new Uint8Array(stride);
    let pos = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[pos] ?? 0;
      pos += 1;
      const row = raw.subarray(pos, pos + stride);
      pos += stride;
      const cur = new Uint8Array(stride);
      for (let i = 0; i < stride; i += 1) {
        const left = i >= channels ? (cur[i - channels] ?? 0) : 0;
        const up = prev[i] ?? 0;
        const upLeft = i >= channels ? (prev[i - channels] ?? 0) : 0;
        const value = row[i] ?? 0;
        cur[i] =
          filter === 0 ? value
          : filter === 1 ? (value + left) & 0xff
          : filter === 2 ? (value + up) & 0xff
          : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
          : filter === 4 ? (value + paeth(left, up, upLeft)) & 0xff
          : value;
      }
      if (y % step === 0) {
        for (let x = 0; x < width; x += step) {
          const i = x * channels;
          const alpha = colorType === 4 ? (cur[i + 1] ?? 255) : colorType === 6 ? (cur[i + 3] ?? 255) : 255;
          if (alpha < 128) continue;
          if (colorType === 3) {
            const p = (cur[i] ?? 0) * 3;
            r += palette?.[p] ?? 0;
            g += palette?.[p + 1] ?? 0;
            b += palette?.[p + 2] ?? 0;
          } else if (colorType === 0 || colorType === 4) {
            const gray = cur[i] ?? 0;
            r += gray;
            g += gray;
            b += gray;
          } else {
            r += cur[i] ?? 0;
            g += cur[i + 1] ?? 0;
            b += cur[i + 2] ?? 0;
          }
          n += 1;
        }
      }
      prev = cur;
    }
    if (n === 0) return undefined;
    return rgbToHex([r / n, g / n, b / n]);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type ExtractedPptxDesign = {
  theme: DeckTheme;
  slideSize?: PptxSlideSize;
  /** Master background when it is a solid color (already folded into theme.background when present). */
  backgroundColor?: string;
  /** Average color sampled from a PNG master background image (already folded into theme.background when present). */
  backgroundSampled?: string;
  /** Master background image bytes + stored filename extension, when the master background is an image. */
  backgroundImage?: { bytes: Uint8Array; extension: string };
};

async function zipText(zip: JSZip, path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const file = zip.file(path);
  return file ? file.async('string') : undefined;
}

export async function extractPptxDesign(bytes: Uint8Array): Promise<ExtractedPptxDesign> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new PptxTemplateError('not_a_pptx', 'berkas ini bukan PPTX yang valid (bukan arsip zip)');
  }
  const paths = Object.keys(zip.files);
  const presentationPath = firstPart(paths, /^ppt\/presentation\.xml$/);
  if (!presentationPath) {
    throw new PptxTemplateError('not_a_pptx', 'berkas ini bukan PPTX yang valid (ppt/presentation.xml tidak ditemukan)');
  }

  // --- slide size -------------------------------------------------------
  let slideSize: PptxSlideSize | undefined;
  const presentationXml = await zipText(zip, presentationPath);
  const sldSzTag = presentationXml ? /<p:sldSz\b[^>]*>/.exec(presentationXml)?.[0] : undefined;
  if (sldSzTag) {
    const cx = Number(attr(sldSzTag, 'cx'));
    const cy = Number(attr(sldSzTag, 'cy'));
    if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) {
      const ratio = cx / cy;
      const label = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 4 / 3) < 0.02 ? '4:3' : `${(cx / 914400).toFixed(2)} × ${(cy / 914400).toFixed(2)} in`;
      slideSize = { cx, cy, label };
    }
  }

  // --- slide master (background + which theme it points at) ------------
  const masterPath = firstPart(paths, /^ppt\/slideMasters\/slideMaster\d+\.xml$/);
  const masterDir = masterPath ? masterPath.slice(0, masterPath.lastIndexOf('/')) : undefined;
  const masterRelsPath = masterPath ? `${masterDir}/_rels/${basename(masterPath)}.rels` : undefined;
  const masterXml = await zipText(zip, masterPath);
  const masterRelsXml = await zipText(zip, masterRelsPath);

  let backgroundColor: string | undefined;
  let backgroundImage: ExtractedPptxDesign['backgroundImage'];
  const bgBlock = masterXml ? /<p:bg>([\s\S]*?)<\/p:bg>/.exec(masterXml)?.[1] : undefined;
  if (bgBlock) {
    const srgb = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(bgBlock)?.[1];
    const sys = /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(bgBlock)?.[1];
    if (srgb) backgroundColor = `#${srgb.toLowerCase()}`;
    else if (sys) backgroundColor = `#${sys.toLowerCase()}`;
    const embed = /<a:blip\b[^>]*\br:embed="(rId\d+)"/.exec(bgBlock)?.[1];
    if (!backgroundColor && embed && masterRelsXml && masterDir) {
      const target = relTarget(masterRelsXml, embed);
      const mediaPath = target ? resolvePartPath(masterDir, target) : undefined;
      const mediaFile = mediaPath ? zip.file(mediaPath) : null;
      if (mediaFile && mediaPath) {
        const extension = extname(mediaPath).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(extension)) {
          backgroundImage = { bytes: await mediaFile.async('uint8array'), extension };
        }
      }
    }
  }

  // --- theme (colors + fonts) -------------------------------------------
  let themePath: string | undefined;
  if (masterRelsXml && masterDir) {
    const themeRel = [...masterRelsXml.matchAll(/<Relationship\b[^>]*>/g)]
      .map((m) => m[0])
      .find((tag) => (attr(tag, 'Type') ?? '').endsWith('/theme'));
    const target = themeRel ? attr(themeRel, 'Target') : undefined;
    if (target) themePath = resolvePartPath(masterDir, target);
  }
  if (!themePath || !zip.file(themePath)) {
    themePath = firstPart(paths, /^ppt\/theme\/theme\d+\.xml$/);
  }
  const themeXml = await zipText(zip, themePath);
  const clrBlock = themeXml ? /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml)?.[1] : undefined;
  const fontBlock = themeXml ?? '';

  const colors = clrBlock
    ? {
        dk1: schemeColor(clrBlock, 'dk1'),
        lt1: schemeColor(clrBlock, 'lt1'),
        dk2: schemeColor(clrBlock, 'dk2'),
        lt2: schemeColor(clrBlock, 'lt2'),
        accent1: schemeColor(clrBlock, 'accent1'),
        accent2: schemeColor(clrBlock, 'accent2'),
        accent3: schemeColor(clrBlock, 'accent3'),
        accent4: schemeColor(clrBlock, 'accent4'),
        accent5: schemeColor(clrBlock, 'accent5'),
        accent6: schemeColor(clrBlock, 'accent6'),
        hlink: schemeColor(clrBlock, 'hlink'),
      }
    : undefined;

  // Per-field fallbacks (the bundled General tokens) keep a sparse theme
  // honest instead of failing the import.
  const fallback = { background: '#201f26', text: '#ecebf0', accent: '#6b50ff' };
  const lt1 = isHex(colors?.lt1) ? colors.lt1 : fallback.background;
  const dk1 = isHex(colors?.dk1) ? colors.dk1 : fallback.text;
  // An image master background overrides the theme's light slot visually,
  // so its sampled average (PNG only) decides the pole — a dark photo
  // master must not inherit light-background tokens with dark text.
  const sampledBackground =
    backgroundImage && backgroundImage.extension === '.png' ? pngAverageColor(backgroundImage.bytes) : undefined;
  const background = backgroundColor ?? sampledBackground ?? lt1;
  const dark = luminance(background) < 0.4;
  // Office convention: lt1/dk1 are the light/dark text pair; once the
  // master background decides the pole, text is the opposite pole's color.
  const text = dark ? (background === lt1 ? dk1 : lt1) : (background === dk1 ? lt1 : dk1);
  const surface = mixHex(background, text, dark ? 0.07 : 0.05);
  const muted = mixHex(text, background, 0.38);
  const series = [colors?.accent1, colors?.accent2, colors?.accent3, colors?.accent4, colors?.accent5, colors?.accent6].filter(isHex);
  const headingFont = schemeFont(fontBlock, 'majorFont');
  const bodyFont = schemeFont(fontBlock, 'minorFont');

  const theme: DeckTheme = {
    dark,
    background,
    surface,
    text: isHex(text) ? text : fallback.text,
    muted,
    accent: isHex(colors?.accent1) ? colors.accent1 : isHex(colors?.hlink) ? colors.hlink : fallback.accent,
    ...(series.length > 0 ? { series } : {}),
    ...(headingFont ? { headingFont } : {}),
    ...(bodyFont ? { bodyFont } : {}),
  };

  return {
    theme,
    ...(slideSize ? { slideSize } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(sampledBackground ? { backgroundSampled: sampledBackground } : {}),
    ...(backgroundImage ? { backgroundImage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store (<workspace>/.daedalus/slide-templates/<id>.json + <id>.* assets)
// ---------------------------------------------------------------------------

function isPptxTemplate(value: unknown): value is PptxTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === 'string' && ID_PATTERN.test(t.id) &&
    typeof t.name === 'string' &&
    typeof t.sourceFile === 'string' &&
    typeof t.createdAt === 'string' &&
    typeof t.theme === 'object' && t.theme !== null && !Array.isArray(t.theme) &&
    (t.backgroundImageFile === undefined || typeof t.backgroundImageFile === 'string') &&
    (t.pages === undefined || Array.isArray(t.pages)) &&
    (t.sourceFileName === undefined || typeof t.sourceFileName === 'string') &&
    (t.sourceAddresses === undefined || Array.isArray(t.sourceAddresses))
  );
}

export async function savePptxTemplate(root: string, input: { fileName: string; bytes: Uint8Array }): Promise<PptxTemplate> {
  const sourceFile = basename(input.fileName.replace(/\\+/g, '/'));
  if (!sourceFile.toLowerCase().endsWith('.pptx')) {
    throw new PptxTemplateError('not_a_pptx', 'hanya berkas .pptx yang bisa dijadikan template');
  }
  if (input.bytes.length > MAX_PPTX_TEMPLATE_BYTES) {
    throw new PptxTemplateError('pptx_too_large', `Template PPTX terlalu besar (maks ${Math.round(MAX_PPTX_TEMPLATE_BYTES / (1024 * 1024))} MB)`);
  }
  const extracted = await extractPptxDesign(input.bytes);
  const dir = pptxTemplatesDir(root);
  await mkdir(dir, { recursive: true });

  const stem = sourceFile.slice(0, -'.pptx'.length).trim() || 'Template PPT';
  let id = slugifyTitle(stem);
  for (let suffix = 2; existsSync(join(dir, `${id}.json`)); suffix += 1) {
    id = `${slugifyTitle(stem)}-${suffix}`;
  }
  let backgroundImageFile: string | undefined;
  if (extracted.backgroundImage) {
    backgroundImageFile = `${id}.background${extracted.backgroundImage.extension}`;
    await writeFile(join(dir, backgroundImageFile), extracted.backgroundImage.bytes);
  }
  // v2: parse the source's slide designs so generation can pour words
  // into them. Page assets (background images, slot pictures) are stored
  // beside the JSON with the template id as filename prefix; a source
  // whose slides parse to nothing stays a v1 skin-only template.
  const pagesExtract = await extractPptxPages(input.bytes).catch((): Awaited<ReturnType<typeof extractPptxPages>> => ({ pages: [], assets: [] }));
  const pages = pagesExtract.pages.length > 0 ? prefixPageAssets(pagesExtract.pages, `${id}.`) : undefined;
  if (pages) {
    for (const asset of pagesExtract.assets) {
      await writeFile(join(dir, `${id}.${asset.file}`), asset.bytes);
    }
  }
  // v3: keep the source .pptx itself so export can clone its package
  // verbatim (decorations, charts, tables survive; only slot words and
  // clicked images change). A failure here degrades to the v2 export
  // path instead of failing the import — the skin/page data above is
  // already complete on its own.
  let sourceFileName: string | undefined;
  let sourceAddresses: PptxTemplatePageAddress[] | undefined;
  if (pages) {
    try {
      sourceAddresses = await extractPptxPageAddresses(input.bytes, pagesExtract.pages);
      sourceFileName = `${id}.source.pptx`;
      await writeFile(join(dir, sourceFileName), input.bytes);
    } catch {
      sourceFileName = undefined;
      sourceAddresses = undefined;
    }
  }
  const template: PptxTemplate = {
    id,
    name: stem,
    sourceFile,
    createdAt: new Date().toISOString(),
    theme: extracted.theme,
    ...(extracted.slideSize ? { slideSize: extracted.slideSize } : {}),
    ...(backgroundImageFile ? { backgroundImageFile } : {}),
    ...(pages ? { pages } : {}),
    ...(sourceFileName ? { sourceFileName } : {}),
    ...(sourceAddresses ? { sourceAddresses } : {}),
  };
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return template;
}

export async function listPptxTemplates(root: string): Promise<PptxTemplate[]> {
  const dir = pptxTemplatesDir(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const templates: PptxTemplate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, entry), 'utf8'));
      if (isPptxTemplate(parsed)) templates.push(parsed);
    } catch {
      // A corrupt stored template is skipped, never fatal to the list.
    }
  }
  return templates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPptxTemplate(root: string, id: string): Promise<PptxTemplate | undefined> {
  assertTemplateId(id);
  try {
    const parsed: unknown = JSON.parse(await readFile(join(pptxTemplatesDir(root), `${id}.json`), 'utf8'));
    return isPptxTemplate(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readPptxTemplateBackground(root: string, id: string): Promise<{ bytes: Buffer; fileName: string } | undefined> {
  const template = await getPptxTemplate(root, id);
  if (!template?.backgroundImageFile) return undefined;
  try {
    const bytes = await readFile(join(pptxTemplatesDir(root), template.backgroundImageFile));
    return { bytes, fileName: template.backgroundImageFile };
  } catch {
    return undefined;
  }
}

const sourceCache = new Map<string, { mtimeMs: number; bytes: Buffer | undefined }>();

/**
 * The kept source .pptx bytes of a v3 template (undefined for templates
 * imported before v3 or unreadable). Memoized per (root,id) on file
 * mtime like readPptxTemplateSync — export runs once per deck, but the
 * fill pipeline validates repeatedly.
 */
export async function readPptxTemplateSource(root: string, id: string): Promise<{ bytes: Buffer; fileName: string } | undefined> {
  if (!ID_PATTERN.test(id)) return undefined;
  const template = await getPptxTemplate(root, id);
  if (!template?.sourceFileName) return undefined;
  const path = join(pptxTemplatesDir(root), template.sourceFileName);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    sourceCache.delete(`${root} ${id}`);
    return undefined;
  }
  const key = `${root} ${id}`;
  const cached = sourceCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.bytes ? { bytes: cached.bytes, fileName: template.sourceFileName } : undefined;
  }
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(path);
  } catch {
    bytes = undefined;
  }
  sourceCache.set(key, { mtimeMs, bytes });
  return bytes ? { bytes, fileName: template.sourceFileName } : undefined;
}

export async function deletePptxTemplate(root: string, id: string): Promise<boolean> {
  assertTemplateId(id);
  const dir = pptxTemplatesDir(root);
  const jsonPath = join(dir, `${id}.json`);
  if (!existsSync(jsonPath)) return false;
  // Removes the JSON and every stored asset of this template (`<id>.*`:
  // the v1 master background plus any v2 page backgrounds/pictures).
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry === `${id}.json` || entry.startsWith(`${id}.`)) {
      await rm(join(dir, entry), { force: true });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Synchronous + asset readers (validateDeck and the PPTX exporter are
// synchronous core paths; the asset endpoint serves page images to the
// canvas). The sync reader memoizes per (root,id) keyed on file mtime so
// repeated validation of a 40-slide deck stays cheap.
// ---------------------------------------------------------------------------

const syncTemplateCache = new Map<string, { mtimeMs: number; template: PptxTemplate | undefined }>();

export function readPptxTemplateSync(root: string, id: string): PptxTemplate | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  const path = join(pptxTemplatesDir(root), `${id}.json`);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    syncTemplateCache.delete(`${root} ${id}`);
    return undefined;
  }
  const key = `${root} ${id}`;
  const cached = syncTemplateCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached.template;
  let template: PptxTemplate | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    template = isPptxTemplate(parsed) ? parsed : undefined;
  } catch {
    template = undefined;
  }
  syncTemplateCache.set(key, { mtimeMs, template });
  return template;
}

/**
 * Reads one stored template asset (master background or a v2 page asset)
 * by bare file name. Only names the template actually references are
 * served — this guards the HTTP endpoint against path traversal and
 * against reading arbitrary files out of the template store.
 */
export async function readPptxTemplateAsset(root: string, id: string, file: string): Promise<{ bytes: Buffer; fileName: string } | undefined> {
  if (!ID_PATTERN.test(id) || !file || file !== basename(file)) return undefined;
  const template = await getPptxTemplate(root, id);
  if (!template) return undefined;
  if (!pptxTemplateAssetFiles(template).includes(file)) return undefined;
  try {
    const bytes = await readFile(join(pptxTemplatesDir(root), file));
    return { bytes, fileName: file };
  } catch {
    return undefined;
  }
}

/**
 * The DeckTheme to stamp onto a deck for an imported template: the stored
 * tokens plus the apply-time stamps. The extracted background image is
 * copied into deck/assets/ (the only directory the canvas and the PPTX
 * exporter resolve images from), so a deck keeps rendering even if the
 * stored template is later deleted.
 */
export async function applyPptxTemplateTheme(root: string, id: string): Promise<{ template: PptxTemplate; theme: DeckTheme }> {
  const template = await getPptxTemplate(root, id);
  if (!template) {
    throw new PptxTemplateError('ppt_template_not_found', `template PPT "${id}" tidak ditemukan di workspace ini`);
  }
  let backgroundImage: string | undefined;
  if (template.backgroundImageFile) {
    const stored = await readPptxTemplateBackground(root, id);
    if (stored) {
      const ext = extname(template.backgroundImageFile).toLowerCase() || '.png';
      backgroundImage = `template-bg-${id}${ext}`;
      const assetsDir = deckPaths(root).assetsDir;
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, backgroundImage), stored.bytes);
    }
  }
  const theme: DeckTheme = {
    ...template.theme,
    customTemplateId: template.id,
    ...(backgroundImage ? { backgroundImage } : {}),
  };
  return { template, theme };
}
