// PPTX template pages: parse a .pptx's actual slide DESIGNS (background,
// text/image slots, page kind) so generation can pour prompt content into
// the template's own layouts and only the words change (the Docmee model).
//
// This is deliberately a structural scrape in the same spirit as
// pptx-template.ts: the OPC package is a zip of XML parts, so JSZip +
// targeted regexes recover slide order (presentation.xml + rels), each
// slide's background (slide -> layout -> master fallback), every
// text-bearing shape as a slot (rect as slide fractions, sample text,
// dominant-run style) and every picture as an image slot. Decorative
// shapes are additionally captured as flat render hints (decorShapes) so
// the Web canvas can preview the design; the EXPORT preserves the full
// original design by cloning the source slide XML (export-template.ts)
// rather than by reconstructing anything parsed here. Known limits,
// honestly documented: group shapes (p:grpSp) are walked recursively
// — children live in group-local child space (chOff/chExt) mapped
// through the group's off/ext box — so text/picture slots and decor
// inside groups are found with slide-space rects, and each slot
// address carries a shape path (child indices from the tree root) the
// clone export resolves unambiguously. Group rotation is not applied
// to rects (axis-aligned mapping only). Graphic frames
// (charts/tables/SmartArt) are not scraped for slots — under clone
// export they survive as the template's originals, untouched — but
// they yield a `frame` decor entry so the preview marks their place
// instead of leaving a hole. Fills resolve beyond plain srgb:
// gradFill stops, schemeClr names with lumMod/lumOff/tint/shade/
// satMod transforms (ECMA-376), and style fillRef/bgRef entries of
// the theme's fill style lists all feed the preview paint — premium
// templates that paint from schemeClr gradients (e.g. Nexora)
// carried zero preview decor before that resolution existed.
import JSZip from 'jszip';
import { leafShapeKey, picEmbedId, walkShapeTree } from './xml-shape-utils.ts';

export type PptxTemplatePageKind = 'cover' | 'toc' | 'section' | 'content' | 'closing';

export interface PptxSlotRect { x: number; y: number; w: number; h: number }

export interface PptxTextSlot {
  key: string;
  kind: 'text';
  rect: PptxSlotRect;
  sampleText: string;
  fontSizePt: number;
  bold: boolean;
  color?: string;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
  lineCount: number;
  maxChars: number;
}

export interface PptxImageSlot {
  key: string;
  kind: 'image';
  rect: PptxSlotRect;
  imageFile?: string;
}

export type PptxTemplateSlot = PptxTextSlot | PptxImageSlot;

/**
 * A decorative (non-slot) shape of a template page — top-level or
 * inside a group, at its transformed slide-space rect — captured so
 * the Web canvas can PREVIEW the design honestly. Faithful render
 * kinds: simple preset geometry with a solid or gradient fill, and an
 * image (a pic, or a blip-filled shape — the picture already extracted
 * as an asset). Freeform custGeom fills are drawn as an SVG path in
 * their rect (an approximation); graphic frames reduce to a footprint
 * marker. The exported .pptx is always exact because it clones the
 * original slide XML instead of reconstructing anything.
 */
/** One gradient stop of a resolved gradFill paint (pos 0..1). */
export interface PptxGradientStop {
  pos: number;
  color: string;
  /** Opacity 0..1 when the stop carries an <a:alpha> (absent = opaque). */
  alpha?: number;
}

/**
 * A resolved <a:gradFill> for canvas preview: linear gradients carry
 * the OOXML angle (degrees, clockwise from the +x axis, y down);
 * path gradients (circle/rect focus) reduce to a centered radial.
 */
export interface PptxGradient {
  kind: 'linear' | 'radial';
  angleDeg: number;
  stops: PptxGradientStop[];
}

export type PptxDecorShape =
  | { type: 'shape'; rect: PptxSlotRect; fill: string; geom: 'rect' | 'roundRect' | 'ellipse'; gradient?: PptxGradient }
  | { type: 'image'; rect: PptxSlotRect; imageFile: string }
  | {
      type: 'path';
      rect: PptxSlotRect;
      fill: string;
      /** SVG path data converted from the custGeom pathLst (M/L/C/Q/Z subset). */
      d: string;
      /** The custGeom path coordinate space the `d` data lives in. */
      box: { w: number; h: number };
      gradient?: PptxGradient;
    }
  | {
      /** A graphicFrame (native chart/table/SmartArt): never redrawn —
       * the preview marks its footprint; the clone export keeps the
       * template's original frame byte-for-byte. */
      type: 'frame';
      rect: PptxSlotRect;
    };

export interface PptxTemplatePage {
  kind: PptxTemplatePageKind;
  background?: { color?: string; imageFile?: string };
  slots: PptxTemplateSlot[];
  /**
   * Decorative shapes in document order (paint order), for canvas
   * preview only. Added in v3; absent on templates stored by v2.
   */
  shapes?: PptxDecorShape[];
}

export interface PptxPagesExtract {
  pages: PptxTemplatePage[];
  /** Asset bytes keyed by the file name referenced from pages (`page-<i>…`). */
  assets: Array<{ file: string; bytes: Uint8Array }>;
}

const MAX_CLOSING_TEXT = /terima kasih|thank you|thanks for|penutup|hubungi|kontak|contact us/i;
const TOC_TEXT = /daftar isi|\bagenda\b|table of contents|\bcontents\b|outline/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
const EMU_PER_PT = 12700;

function resolvePartPath(basePart: string, target: string): string {
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

interface Rel { id: string; type: string; target: string }
function parseRels(xml: string): Map<string, Rel> {
  const out = new Map<string, Rel>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const type = /\bType="([^"]+)"/.exec(tag)?.[1] ?? '';
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1] ?? '';
    if (id) out.set(id, { id, type, target });
  }
  return out;
}

function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/');
  return slash >= 0 ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` : `_rels/${part}.rels`;
}

function srgbOf(xmlFragment: string | undefined): string | undefined {
  if (!xmlFragment) return undefined;
  const srgb = /<a:srgbClr val="([0-9a-fA-F]{6})"/.exec(xmlFragment)?.[1];
  if (srgb) return `#${srgb.toLowerCase()}`;
  const sys = /<a:sysClr[^>]*lastClr="([0-9a-fA-F]{6})"/.exec(xmlFragment)?.[1];
  return sys ? `#${sys.toLowerCase()}` : undefined;
}

/* ------------------------------------------------------------ colors
 * OOXML color resolution for preview paints. Premium templates paint
 * almost nothing with raw srgb: fills are schemeClr references
 * (accent1, bg1, tx2, …) carrying luminance/saturation transforms, or
 * style fillRef pointers into the theme's fill style list, where the
 * placeholder color phClr stands for the color the referencing shape
 * itself names. Everything resolves against the file's own
 * <a:clrScheme>, parsed once per import.
 */

/** clrScheme name → '#rrggbb', from one theme part's <a:clrScheme>. */
export type PptxColorScheme = Record<string, string>;

/** Scheme aliases every producer relies on (bg/tx pair onto lt/dk). */
const SCHEME_ALIASES: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

export function parseClrScheme(themeXml: string): PptxColorScheme {
  const block = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml)?.[1];
  const scheme: PptxColorScheme = {};
  if (!block) return scheme;
  for (const name of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const entry = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(block)?.[1];
    const hex = entry ? srgbOf(entry) : undefined;
    if (hex) scheme[name] = hex;
  }
  return scheme;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  if (s === 0) {
    const gray = clampByte(l).toString(16).padStart(2, '0');
    return `#${gray}${gray}${gray}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const byte = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return `#${byte(channel(h + 1 / 3))}${byte(channel(h))}${byte(channel(h - 1 / 3))}`;
}

/**
 * Apply one ECMA-376 color transform to a hex color, in HSL terms
 * (val is in 1000ths of a percent, so 100000 = 100%):
 *  - lumMod:  L ×= v        lumOff: L += v
 *  - tint:    L → L + (1−L)·v (toward white)
 *  - shade:   L → L · (1−v)   (toward black)
 *  - satMod:  S ×= v
 * Transforms compose in document order, as producers emit them.
 */
function applyColorTransform(hex: string, name: string, val: number): string {
  const f = val / 100000;
  const hsl = hexToHsl(hex);
  if (name === 'lumMod') hsl.l = clamp01(hsl.l * f);
  else if (name === 'lumOff') hsl.l = clamp01(hsl.l + f);
  else if (name === 'tint') hsl.l = clamp01(hsl.l + (1 - hsl.l) * f);
  else if (name === 'shade') hsl.l = clamp01(hsl.l * (1 - f));
  else if (name === 'satMod') hsl.s = clamp01(hsl.s * f);
  else return hex;
  return hslToHex(hsl.h, hsl.s, hsl.l);
}

/** One resolved color: '#rrggbb' plus opacity when an <a:alpha> rides along. */
export interface ResolvedColor { color: string; alpha?: number }

/**
 * Resolve the first color element (<a:srgbClr>, <a:sysClr>,
 * <a:schemeClr>, <a:phClr>) inside an XML fragment against the scheme.
 * `phClrHex` is what phClr stands for at this reference site (the
 * color a style ref names); without one it falls back to accent1.
 * srgb-only fragments resolve exactly as srgbOf did, so flat templates
 * are untouched.
 */
export function resolveColorIn(fragment: string | undefined, scheme: PptxColorScheme, phClrHex?: string): ResolvedColor | undefined {
  if (!fragment) return undefined;
  const match = /<a:(srgbClr|sysClr|schemeClr|phClr)\b([^>]*)(?:\/>|>([\s\S]*?)<\/a:\1>)/.exec(fragment);
  if (!match) return undefined;
  const [, tag, attrs, inner] = match as unknown as [string, string, string, string | undefined];
  let hex: string | undefined;
  if (tag === 'srgbClr') {
    const val = /\bval="([0-9a-fA-F]{6})"/.exec(attrs)?.[1];
    hex = val ? `#${val.toLowerCase()}` : undefined;
  } else if (tag === 'sysClr') {
    const val = /\blastClr="([0-9a-fA-F]{6})"/.exec(attrs)?.[1];
    hex = val ? `#${val.toLowerCase()}` : undefined;
  } else if (tag === 'schemeClr') {
    const name = /\bval="([a-zA-Z0-9]+)"/.exec(attrs)?.[1];
    // Theme style lists spell the placeholder color as schemeClr "phClr".
    if (name === 'phClr') hex = phClrHex ?? scheme.accent1;
    else {
      const key = name ? (SCHEME_ALIASES[name] ?? name) : undefined;
      hex = key ? scheme[key] : undefined;
    }
  } else {
    hex = phClrHex ?? scheme.accent1;
  }
  if (!hex) return undefined;
  let alpha: number | undefined;
  for (const mod of (inner ?? '').matchAll(/<a:(lumMod|lumOff|tint|shade|satMod|alpha)\s+val="(\d+)"/g)) {
    if (mod[1] === 'alpha') alpha = clamp01(Number(mod[2]) / 100000);
    else hex = applyColorTransform(hex, mod[1]!, Number(mod[2]));
  }
  return { color: hex, ...(alpha !== undefined ? { alpha } : {}) };
}

/** A preview paint: a representative color, or a full gradient. */
export interface ResolvedFill {
  /** First-stop / solid color — the representative every consumer can use. */
  color: string;
  /** Opacity of the solid (or first stop) when an <a:alpha> rides along. */
  alpha?: number;
  gradient?: PptxGradient;
}

/**
 * Resolve one fill element's XML (<a:solidFill>… or <a:gradFill>…) to
 * a preview paint. Gradient stop positions normalize to 0..1; a
 * gradient with no readable stops, or one whose colors all fail to
 * resolve, returns undefined — never a fabricated paint.
 */
export function resolveFillElement(fillXml: string, scheme: PptxColorScheme, phClrHex?: string): ResolvedFill | undefined {
  if (fillXml.includes('<a:solidFill')) {
    const resolved = resolveColorIn(fillXml, scheme, phClrHex);
    return resolved ? { color: resolved.color, ...(resolved.alpha !== undefined ? { alpha: resolved.alpha } : {}) } : undefined;
  }
  if (!fillXml.includes('<a:gradFill')) return undefined;
  const stops: PptxGradientStop[] = [];
  for (const gs of fillXml.matchAll(/<a:gs\s+pos="(\d+)"[^>]*>([\s\S]*?)<\/a:gs>/g)) {
    const resolved = resolveColorIn(gs[2], scheme, phClrHex);
    if (!resolved) continue;
    stops.push({ pos: clamp01(Number(gs[1]) / 100000), color: resolved.color, ...(resolved.alpha !== undefined ? { alpha: resolved.alpha } : {}) });
  }
  if (stops.length === 0) return undefined;
  const lin = /<a:lin\s+ang="(-?\d+)"/.exec(fillXml)?.[1];
  const gradient: PptxGradient = /<a:path\b/.test(fillXml)
    ? { kind: 'radial', angleDeg: 0, stops }
    : { kind: 'linear', angleDeg: lin !== undefined ? Number(lin) / 60000 : 0, stops };
  const first = stops[0]!;
  return { color: first.color, ...(first.alpha !== undefined ? { alpha: first.alpha } : {}), gradient };
}

/** Raw fill-element children of a theme's fill/bg fill style lists. */
export interface ThemeFillStyles { fills: string[]; bgFills: string[] }

export function parseFillStyles(themeXml: string): ThemeFillStyles {
  const listOf = (tag: string): string[] => {
    const block = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(themeXml)?.[1];
    if (!block) return [];
    return [...block.matchAll(/<a:(solidFill|gradFill|blipFill|noFill|grpFill)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g)].map((m) => m[0]);
  };
  return { fills: listOf('fillStyleLst'), bgFills: listOf('bgFillStyleLst') };
}

/** Everything fill resolution needs from the package theme. */
export interface PptxThemeContext {
  scheme: PptxColorScheme;
  fillStyles: ThemeFillStyles;
}

/**
 * Resolve a style reference: fillRef/bgRef idx N (1-based) picks the
 * Nth entry of the theme's corresponding fill style list; the ref's
 * own color child is what phClr means inside that entry. idx 0 is
 * DrawingML's "no fill". A ref whose entry cannot resolve falls back
 * to its own named color, so the shape still paints something honest.
 */
function resolveStyleRef(elementXml: string, refTag: 'fillRef' | 'bgRef', list: string[], scheme: PptxColorScheme): ResolvedFill | undefined {
  const ref = new RegExp(`<a:${refTag}\\b[^>]*\\bidx="(\\d+)"[^>]*>([\\s\\S]*?)</a:${refTag}>`).exec(elementXml)
    ?? new RegExp(`<a:${refTag}\\b[^>]*\\bidx="(\\d+)"[^>]*/>`).exec(elementXml);
  if (!ref) return undefined;
  const idx = Number(ref[1]);
  if (idx === 0) return undefined;
  const refColor = resolveColorIn(ref[2] ?? '', scheme);
  const entry = list[idx - 1];
  if (entry && !entry.includes('<a:noFill') && !entry.includes('<a:blipFill')) {
    const resolved = resolveFillElement(entry, scheme, refColor?.color);
    if (resolved) return resolved;
  }
  return refColor ? { color: refColor.color, ...(refColor.alpha !== undefined ? { alpha: refColor.alpha } : {}) } : undefined;
}

/**
 * The preview fill of one shape element, in DrawingML precedence: an
 * explicit spPr fill (noFill → nothing), then a blip fill (reported
 * separately by the caller as an image), then the shape's style
 * fillRef/bgRef. Returns undefined for unpainted shapes.
 */
export function resolveShapeFill(elementXml: string, theme: PptxThemeContext): ResolvedFill | undefined {
  const spPr = /<p:spPr>([\s\S]*?)<\/p:spPr>/.exec(elementXml)?.[1];
  if (spPr) {
    // The outline element starts the region where fills no longer live;
    // match it with a boundary so <a:lnTo> path commands don't count.
    const lnAt = spPr.search(/<a:ln[\s>]/);
    const fillRegion = lnAt >= 0 ? spPr.slice(0, lnAt) : spPr;
    if (/<a:noFill\s*\/>/.test(fillRegion)) return undefined;
    const fillMatch = /<a:(solidFill|gradFill)\b[^>]*>([\s\S]*?)<\/a:\1>/.exec(fillRegion) ?? /<a:(solidFill|gradFill)\s*\/>/.exec(fillRegion);
    if (fillMatch) return resolveFillElement(fillMatch[0], theme.scheme);
    if (/<a:blipFill/.test(fillRegion)) return undefined; // image paint: caller's asset path
    const grp = /<a:grpFill>([\s\S]*?)<\/a:grpFill>/.exec(fillRegion);
    if (grp) return resolveFillElement(grp[0], theme.scheme);
  }
  // Style reference: the shape names a color, the theme names the paint.
  const byFill = resolveStyleRef(elementXml, 'fillRef', theme.fillStyles.fills, theme.scheme);
  if (byFill) return byFill;
  return resolveStyleRef(elementXml, 'bgRef', theme.fillStyles.bgFills, theme.scheme);
}

/** The theme part + parsed color context of the whole package. */
async function themeContextOf(zip: JSZip): Promise<PptxThemeContext> {
  const paths = Object.keys(zip.files);
  let themePath: string | undefined;
  const masterPath = paths.filter((p) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p)).sort()[0];
  if (masterPath) {
    const dir = masterPath.slice(0, masterPath.lastIndexOf('/'));
    const relsFile = zip.file(`${dir}/_rels/${masterPath.slice(masterPath.lastIndexOf('/') + 1)}.rels`);
    if (relsFile) {
      const rels = parseRels(await relsFile.async('string'));
      const themeRel = [...rels.values()].find((rel) => /\/theme$/.test(rel.type));
      if (themeRel) themePath = resolvePartPath(masterPath, themeRel.target);
    }
  }
  if (!themePath || !zip.file(themePath)) {
    themePath = paths.filter((p) => /^ppt\/theme\/theme\d+\.xml$/.test(p)).sort()[0];
  }
  const themeXml = themePath && zip.file(themePath) ? await zip.file(themePath)!.async('string') : '';
  return { scheme: parseClrScheme(themeXml), fillStyles: parseFillStyles(themeXml) };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Rect from an <a:xfrm> off/ext pair, as slide fractions. */
function xfrmRect(xml: string, slideCx: number, slideCy: number): PptxSlotRect | undefined {
  const xfrm = /<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(xml)?.[1];
  if (!xfrm) return undefined;
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(xfrm);
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(xfrm);
  if (!off || !ext || slideCx <= 0 || slideCy <= 0) return undefined;
  const x = Number(off[1]) / slideCx;
  const y = Number(off[2]) / slideCy;
  const w = Number(ext[1]) / slideCx;
  const h = Number(ext[2]) / slideCy;
  return { x: clamp01(x), y: clamp01(y), w: Math.max(0.01, clamp01(w)), h: Math.max(0.01, clamp01(h)) };
}

/**
 * Slide-EMU box → slide fractions, with the same clamping xfrmRect has
 * always applied (origin pulled on-slide, size floored at 1% so a sliver
 * of a shape stays addressable). The walker (xml-shape-utils) produces
 * the EMU box with group transforms already applied.
 */
function emuRectToFractions(rectEmu: { x: number; y: number; cx: number; cy: number }, slideCx: number, slideCy: number): PptxSlotRect {
  return {
    x: clamp01(rectEmu.x / slideCx),
    y: clamp01(rectEmu.y / slideCy),
    w: Math.max(0.01, clamp01(rectEmu.cx / slideCx)),
    h: Math.max(0.01, clamp01(rectEmu.cy / slideCy)),
  };
}

/** Placeholder identity (`type` + `idx`) of a shape, for layout fallback. */
function placeholderKey(xml: string): string | undefined {
  const ph = /<p:ph\b([^>]*)\/>/.exec(xml)?.[1] ?? /<p:ph\b([^>]*)>/.exec(xml)?.[1];
  if (ph === undefined) return undefined;
  const type = /\btype="([^"]+)"/.exec(ph)?.[1] ?? 'body';
  const idx = /\bidx="([^"]+)"/.exec(ph)?.[1] ?? '';
  return `${type}:${idx}`;
}

/** '#rrggbb' or 'rgba(r,g,b,a)' for the canvas (CSS + SVG fill both take it). */
function cssColor(color: string, alpha?: number): string {
  if (alpha === undefined || alpha >= 1) return color;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Simple preset geometries the canvas can draw faithfully as divs. */
const PREVIEW_GEOMS: Record<string, 'rect' | 'roundRect' | 'ellipse'> = {
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
};

/**
 * Decorative (non-slot) shapes of one page for canvas preview: pic
 * elements and image-filled shapes reuse their already-extracted asset,
 * preset shapes reduce to a colored/gradient div, freeforms to an SVG
 * path. Fills resolve through the theme (solid/scheme/gradient/style
 * ref). Text-bearing shapes are slots, not decor — the caller filters
 * those out by shape path.
 */
function decorShapeOf(
  elementXml: string,
  rect: PptxSlotRect,
  imageFileByEmbed: Map<string, string>,
  theme: PptxThemeContext,
): PptxDecorShape | undefined {
  const blipEmbed = picEmbedId(elementXml);
  const imageFile = blipEmbed ? imageFileByEmbed.get(blipEmbed) : undefined;
  if (imageFile) return { type: 'image', rect, imageFile };
  const fill = resolveShapeFill(elementXml, theme);
  if (!fill) return undefined;
  const gradient = fill.gradient ? { gradient: fill.gradient } : {};
  const geom = /<a:prstGeom[^>]*\bprst="([^"]+)"/.exec(elementXml)?.[1];
  if (geom && PREVIEW_GEOMS[geom]) {
    return { type: 'shape', rect, fill: cssColor(fill.color, fill.alpha), geom: PREVIEW_GEOMS[geom]!, ...gradient };
  }
  // Freeform fills (the big blobs of downloaded templates) convert to an
  // SVG path when they use only the straight/curve command subset; an
  // arcTo or anything exotic skips the shape rather than faking it.
  if (elementXml.includes('<a:custGeom')) {
    const path = custGeomPathOf(elementXml);
    if (path) return { type: 'path', rect, fill: cssColor(fill.color, fill.alpha), d: path.d, box: path.box, ...gradient };
  }
  return undefined;
}

/**
 * Converts one `<a:pathLst>` to SVG path data. Only the command subset
 * that maps 1:1 (moveTo/lnTo/cubicBezTo/quadBezTo/close) is supported;
 * any other command (arcTo, …) returns undefined.
 */
function custGeomPathOf(xml: string): { d: string; box: { w: number; h: number } } | undefined {
  const pathList = /<a:pathLst>([\s\S]*?)<\/a:pathLst>/.exec(xml)?.[1];
  if (!pathList) return undefined;
  const pathMatch = /<a:path\b([^>]*)>([\s\S]*?)<\/a:path>/.exec(pathList);
  if (!pathMatch) return undefined;
  const w = Number(/\bw="(\d+)"/.exec(pathMatch[1]!)?.[1] ?? NaN);
  const h = Number(/\bh="(\d+)"/.exec(pathMatch[1]!)?.[1] ?? NaN);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  const commands: string[] = [];
  const tagRe = /<a:(moveTo|lnTo|cubicBezTo|quadBezTo|close)\s*(?:\/>|>([\s\S]*?)<\/a:\1>)/g;
  let consumed = 0;
  for (const match of pathMatch[2]!.matchAll(tagRe)) {
    if (pathMatch[2]!.slice(consumed, match.index).trim() !== '') return undefined;
    consumed = match.index + match[0].length;
    const name = match[1]!;
    if (name === 'close') {
      commands.push('Z');
      continue;
    }
    const pts = [...(match[2] ?? '').matchAll(/<a:pt x="(-?\d+)" y="(-?\d+)"\s*\/>/g)].map((p) => `${p[1]} ${p[2]}`);
    if (name === 'moveTo' && pts.length === 1) commands.push(`M ${pts[0]}`);
    else if (name === 'lnTo' && pts.length === 1) commands.push(`L ${pts[0]}`);
    else if (name === 'cubicBezTo' && pts.length === 3) commands.push(`C ${pts.join(' ')}`);
    else if (name === 'quadBezTo' && pts.length === 2) commands.push(`Q ${pts.join(' ')}`);
    else return undefined;
  }
  if (pathMatch[2]!.slice(consumed).trim() !== '' || commands.length === 0) return undefined;
  return { d: commands.join(' '), box: { w, h } };
}

/**
 * Deterministic slot capacity: how much copy honestly fits the box it must
 * live in — charsPerLine from box width at ~0.5em average glyph advance,
 * lines from box height at 1.3em line height — clamped so tiny decorative
 * boxes still accept a short label and giant boxes stay prose-sized.
 */
export function slotMaxChars(rect: PptxSlotRect, fontSizePt: number, slideCxEmu: number, slideCyEmu: number, sampleText: string): number {
  const widthPt = rect.w * (slideCxEmu / EMU_PER_PT);
  const heightPt = rect.h * (slideCyEmu / EMU_PER_PT);
  const fontPt = Math.max(6, fontSizePt || 18);
  const charsPerLine = Math.max(4, Math.floor(widthPt / (0.5 * fontPt)));
  const lines = Math.max(1, Math.floor(heightPt / (1.3 * fontPt)));
  const fitted = Math.min(800, Math.max(10, charsPerLine * lines));
  // The template's own sample demonstrably fit — never cap below it.
  return Math.max(fitted, Math.min(800, sampleText.length));
}

interface ParsedShapeText {
  text: string;
  fontSizePt: number;
  bold: boolean;
  color?: string;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
  lineCount: number;
}

/** Dominant-run text/style of one <p:sp> body, or undefined when textless. */
function shapeText(spXml: string, scheme: PptxColorScheme = {}): ParsedShapeText | undefined {
  const txBody = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(spXml)?.[1];
  if (!txBody) return undefined;
  const paragraphs = [...txBody.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]!);
  if (paragraphs.length === 0) return undefined;
  let best: { text: string; length: number; size: number; bold: boolean; color?: string; font?: string } | undefined;
  const allText: string[] = [];
  let align: ParsedShapeText['align'];
  for (const paragraph of paragraphs) {
    const algn = /<a:pPr[^>]*\balgn="([^"]+)"/.exec(paragraph)?.[1];
    if (align === undefined && algn) align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';
    const paraText: string[] = [];
    for (const run of paragraph.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
      const body = run[1]!;
      const text = /<a:t>([^<]*)<\/a:t>/.exec(body)?.[1] ?? '';
      if (!text) continue;
      paraText.push(text);
      const rPr = /<a:rPr\b([^>]*)>/.exec(body)?.[1] ?? /<a:rPr\b([^>]*)\/>/.exec(body)?.[1] ?? '';
      const size = rPr ? Number(/\bsz="(\d+)"/.exec(rPr)?.[1] ?? NaN) : NaN;
      const candidate = {
        text,
        length: text.length,
        size: Number.isFinite(size) && size > 0 ? size / 100 : 18,
        bold: /\bb="1"/.test(rPr),
        color: resolveColorIn(body, scheme)?.color,
        font: /<a:latin typeface="([^"]+)"/.exec(body)?.[1],
      };
      if (!best || candidate.length > best.length || (candidate.length === best.length && candidate.size > best.size)) best = candidate;
    }
    // <a:fld> fields (slide numbers, dates) also carry text.
    for (const fld of paragraph.matchAll(/<a:fld\b[^>]*>([\s\S]*?)<\/a:fld>/g)) {
      const text = /<a:t>([^<]*)<\/a:t>/.exec(fld[1]!)?.[1];
      if (text) paraText.push(text);
    }
    if (paraText.length > 0) allText.push(paraText.join(''));
  }
  const joined = allText.join('\n').trim();
  const hasPlaceholder = /<p:ph\b/.test(spXml);
  if (!joined && !hasPlaceholder) return undefined;
  return {
    text: joined,
    fontSizePt: best?.size ?? 18,
    bold: best?.bold ?? false,
    ...(best?.color ? { color: best.color } : {}),
    ...(best?.font ? { fontFamily: best.font } : {}),
    ...(align ? { align } : {}),
    lineCount: Math.max(1, allText.length),
  };
}

/**
 * Remove <p:grpSp> subtrees (nested too) — used only for layout
 * placeholder rects, where placeholders are read top-level as before.
 * Slide pages themselves are walked group-aware (walkShapeTree).
 */
function stripGroupShapes(xml: string): string {
  let out = xml;
  for (let guard = 0; guard < 8; guard += 1) {
    const next = out.replace(/<p:grpSp>[\s\S]*?<\/p:grpSp>/g, '');
    if (next === out) return out;
    out = next;
  }
  return out;
}

async function backgroundOf(
  zip: JSZip,
  ownerPart: string,
  xml: string,
  rels: Map<string, Rel>,
  assetKey: (extension: string) => string,
  assets: Array<{ file: string; bytes: Uint8Array }>,
): Promise<{ color?: string; imageFile?: string } | undefined> {
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(xml)?.[1];
  if (!bg) return undefined;
  const color = srgbOf(bg);
  if (color) return { color };
  const embed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(bg)?.[1];
  const rel = embed ? rels.get(embed) : undefined;
  if (rel && IMAGE_EXT_RE.test(rel.target)) {
    const file = zip.file(resolvePartPath(ownerPart, rel.target));
    if (file) {
      const bytes = await file.async('uint8array');
      const extension = rel.target.slice(rel.target.lastIndexOf('.')).toLowerCase();
      const name = assetKey(extension);
      assets.push({ file: name, bytes });
      return { imageFile: name };
    }
  }
  return undefined;
}

function classifyPage(index: number, total: number, textSlots: PptxTextSlot[]): PptxTemplatePageKind {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const combined = textSlots.map((slot) => slot.sampleText).join(' \n ');
  const maxFont = textSlots.reduce((max, slot) => Math.max(max, slot.fontSizePt), 0);
  if (isLast && MAX_CLOSING_TEXT.test(combined)) return 'closing';
  if (isFirst) return 'cover';
  if (isLast && (textSlots.length <= 2 || maxFont >= 36)) return 'closing';
  if (TOC_TEXT.test(combined)) return 'toc';
  if (textSlots.length >= 4 && textSlots.every((slot) => slot.sampleText.length <= 90)) return 'toc';
  if (textSlots.length <= 2 && maxFont >= 40) return 'section';
  return 'content';
}

/**
 * Parse every slide of a .pptx into a template page. Returned pages carry
 * asset file names local to this extract (`page-<i>.background.png`,
 * `page-<i>.pic-<k>.png`); the store prefixes them with the template id.
 */
export async function extractPptxPages(bytes: Uint8Array): Promise<PptxPagesExtract> {
  const zip = await JSZip.loadAsync(bytes);
  const presFile = zip.file('ppt/presentation.xml');
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presFile) return { pages: [], assets: [] };
  const presXml = await presFile.async('string');
  const presRels = presRelsFile ? parseRels(await presRelsFile.async('string')) : new Map<string, Rel>();
  const sizeMatch = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(presXml);
  const slideCx = sizeMatch ? Number(sizeMatch[1]) : 12192000;
  const slideCy = sizeMatch ? Number(sizeMatch[2]) : 6858000;

  const slideParts: string[] = [];
  for (const idMatch of presXml.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
    const rel = presRels.get(idMatch[1]!);
    if (rel) slideParts.push(resolvePartPath('ppt/presentation.xml', rel.target));
  }
  // Fallback: numeric slide order when the id list is unreadable.
  if (slideParts.length === 0) {
    const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a.slice(12))?.[0] ?? 0) - Number(/\d+/.exec(b.slice(12))?.[0] ?? 0));
    slideParts.push(...names);
  }

  const assets: Array<{ file: string; bytes: Uint8Array }> = [];
  const theme = await themeContextOf(zip);
  const rawPages: Array<{ background?: { color?: string; imageFile?: string }; slots: PptxTemplateSlot[]; textSlots: PptxTextSlot[]; shapes: PptxDecorShape[] }> = [];

  for (let pageIndex = 0; pageIndex < slideParts.length; pageIndex += 1) {
    const part = slideParts[pageIndex]!;
    const file = zip.file(part);
    if (!file) { rawPages.push({ slots: [], textSlots: [], shapes: [] }); continue; }
    const xml = await file.async('string');
    const relsFile = zip.file(relsPathFor(part));
    const rels = relsFile ? parseRels(await relsFile.async('string')) : new Map<string, Rel>();

    // Layout placeholders as rect fallback + master/layout background chain.
    const layoutPhRects = new Map<string, PptxSlotRect>();
    let layoutXml: string | undefined;
    let layoutRels = new Map<string, Rel>();
    const layoutRel = [...rels.values()].find((rel) => /slideLayout/i.test(rel.type));
    let layoutPart = '';
    if (layoutRel) {
      layoutPart = resolvePartPath(part, layoutRel.target);
      const layoutFile = zip.file(layoutPart);
      if (layoutFile) {
        layoutXml = await layoutFile.async('string');
        const lrFile = zip.file(relsPathFor(layoutPart));
        layoutRels = lrFile ? parseRels(await lrFile.async('string')) : new Map<string, Rel>();
        for (const sp of stripGroupShapes(layoutXml).matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
          const key = placeholderKey(sp[1]!);
          const rect = key ? xfrmRect(sp[1]!, slideCx, slideCy) : undefined;
          if (key && rect) layoutPhRects.set(key, rect);
        }
      }
    }
    let background = await backgroundOf(zip, part, xml, rels, (ext) => `page-${pageIndex}.background${ext}`, assets);
    if (!background && layoutXml) {
      background = await backgroundOf(zip, layoutPart, layoutXml, layoutRels, (ext) => `page-${pageIndex}.background${ext}`, assets);
    }
    if (!background) {
      // Master chain: layout rels point at the slide master.
      const masterRel = [...layoutRels.values()].find((rel) => /slideMaster/i.test(rel.type));
      const masterPart = masterRel
        ? resolvePartPath(part, masterRel.target)
        : Object.keys(zip.files).find((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
      if (masterPart) {
        const masterFile = zip.file(masterPart);
        if (masterFile) {
          const masterRelsFile = zip.file(relsPathFor(masterPart));
          const masterRels = masterRelsFile ? parseRels(await masterRelsFile.async('string')) : new Map<string, Rel>();
          background = await backgroundOf(zip, masterPart, await masterFile.async('string'), masterRels, (ext) => `page-${pageIndex}.background${ext}`, assets);
        }
      }
    }

    const spTreeInner = /<p:spTree>([\s\S]*?)<\/p:spTree>/.exec(xml)?.[1] ?? xml;
    // Group-aware flattening: every leaf shape (top-level and nested in
    // grpSp children, arbitrary depth) in document order, with its
    // slide-space rect already mapped through the group transforms.
    const leaves = walkShapeTree(spTreeInner);
    const slots: PptxTemplateSlot[] = [];
    const textSlots: PptxTextSlot[] = [];
    const slotLeafPaths = new Set<string>();
    const imageAssetsByEmbed = new Map<string, string>();
    let slotSeq = 0;
    let picSeq = 0;
    for (const leaf of leaves) {
      const body = leaf.xml;
      if (leaf.tag === 'pic') {
        if (!leaf.rectEmu) continue;
        const rect = emuRectToFractions(leaf.rectEmu, slideCx, slideCy);
        const embed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(body)?.[1];
        const rel = embed ? rels.get(embed) : undefined;
        const key = `s${slotSeq}`;
        slotSeq += 1;
        let imageFile: string | undefined;
        if (rel && IMAGE_EXT_RE.test(rel.target)) {
          const mediaPart = resolvePartPath(part, rel.target);
          const media = zip.file(mediaPart);
          if (media) {
            const extension = rel.target.slice(rel.target.lastIndexOf('.')).toLowerCase();
            imageFile = `page-${pageIndex}.pic-${picSeq}${extension}`;
            picSeq += 1;
            assets.push({ file: imageFile, bytes: await media.async('uint8array') });
            if (embed) imageAssetsByEmbed.set(embed, imageFile);
          }
        }
        slots.push(imageFile ? { key, kind: 'image', rect, imageFile } : { key, kind: 'image', rect });
        slotLeafPaths.add(leaf.shapePath.join('.'));
        continue;
      }
      if (leaf.tag !== 'sp') continue;
      const rect = (leaf.rectEmu ? emuRectToFractions(leaf.rectEmu, slideCx, slideCy) : undefined)
        ?? (leaf.shapePath.length === 1 ? layoutPhRects.get(placeholderKey(body) ?? '') : undefined);
      if (!rect) continue;
      const text = shapeText(body, theme.scheme);
      if (!text) continue;
      const key = `s${slotSeq}`;
      slotSeq += 1;
      slotLeafPaths.add(leaf.shapePath.join('.'));
      const slot: PptxTextSlot = {
        key,
        kind: 'text',
        rect,
        sampleText: text.text,
        fontSizePt: text.fontSizePt,
        bold: text.bold,
        ...(text.color ? { color: text.color } : {}),
        ...(text.fontFamily ? { fontFamily: text.fontFamily } : {}),
        ...(text.align ? { align: text.align } : {}),
        lineCount: text.lineCount,
        maxChars: slotMaxChars(rect, text.fontSizePt, slideCx, slideCy, text.text),
      };
      slots.push(slot);
      textSlots.push(slot);
    }
    // Decor capture for canvas preview: every sp shape that is not a
    // consumed slot (group children included, at their transformed
    // slide-space rects; pics are image slots, not decor). A blip-filled
    // shape whose image no pic slot extracted gets its own decor asset
    // here — grouped icon pictures ride on that path. Graphic frames
    // leave a footprint marker; the export keeps the real frame.
    const shapes: PptxDecorShape[] = [];
    let decorSeq = 0;
    for (const leaf of leaves) {
      if (!leaf.rectEmu) continue;
      const rect = emuRectToFractions(leaf.rectEmu, slideCx, slideCy);
      if (leaf.tag === 'graphicFrame') {
        shapes.push({ type: 'frame', rect });
        continue;
      }
      if (leaf.tag !== 'sp') continue;
      if (slotLeafPaths.has(leaf.shapePath.join('.'))) continue;
      if (shapeText(leaf.xml, theme.scheme)) continue;
      const blipEmbed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(leaf.xml)?.[1];
      if (blipEmbed && !imageAssetsByEmbed.has(blipEmbed)) {
        const rel = rels.get(blipEmbed);
        if (rel && IMAGE_EXT_RE.test(rel.target)) {
          const media = zip.file(resolvePartPath(part, rel.target));
          if (media) {
            const extension = rel.target.slice(rel.target.lastIndexOf('.')).toLowerCase();
            const imageFile = `page-${pageIndex}.decor-${decorSeq}${extension}`;
            decorSeq += 1;
            assets.push({ file: imageFile, bytes: await media.async('uint8array') });
            imageAssetsByEmbed.set(blipEmbed, imageFile);
          }
        }
      }
      const decor = decorShapeOf(leaf.xml, rect, imageAssetsByEmbed, theme);
      if (decor) shapes.push(decor);
    }
    rawPages.push({ ...(background ? { background } : {}), slots, textSlots, shapes });
  }

  const pages: PptxTemplatePage[] = rawPages.map((raw, index) => ({
    kind: classifyPage(index, rawPages.length, raw.textSlots),
    ...(raw.background ? { background: raw.background } : {}),
    slots: raw.slots,
    ...(raw.shapes.length > 0 ? { shapes: raw.shapes } : {}),
  }));
  return { pages, assets };
}

/**
 * The package's slide part names (`ppt/slides/slideN.xml`) in
 * presentation order — the same order extractPptxPages returns pages in.
 * Used by the template store to address slots inside the kept source
 * file for the clone-and-rewrite export (export-template.ts).
 */
export async function listPptxSlideParts(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) return [];
  const presXml = await presFile.async('string');
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
  const presRels = presRelsFile ? parseRels(await presRelsFile.async('string')) : new Map<string, Rel>();
  const parts: string[] = [];
  for (const idMatch of presXml.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
    const rel = presRels.get(idMatch[1]!);
    if (rel) parts.push(resolvePartPath('ppt/presentation.xml', rel.target));
  }
  if (parts.length === 0) {
    return Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a.slice(12))?.[0] ?? 0) - Number(/\d+/.exec(b.slice(12))?.[0] ?? 0));
  }
  return parts;
}

/**
 * Per-page slot addresses for a whole template file — one entry per
 * parsed page, in the same order extractPptxPages returns pages. The
 * template store persists these alongside the kept source .pptx so the
 * clone export never has to re-guess which shape owns which slot.
 */
export async function extractPptxPageAddresses(bytes: Uint8Array, pages: PptxTemplatePage[]): Promise<PptxTemplatePageAddress[]> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = await listPptxSlideParts(bytes);
  const addresses: PptxTemplatePageAddress[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const page = pages[i];
    const slideFile = zip.file(part);
    if (!page || !slideFile) {
      addresses.push({ slidePart: part, slots: [] });
      continue;
    }
    const slash = part.lastIndexOf('/');
    const relsPath = slash >= 0 ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` : `_rels/${part}.rels`;
    const relsFile = zip.file(relsPath);
    addresses.push(matchPageAddresses(await slideFile.async('string'), relsFile ? await relsFile.async('string') : '', part, page));
  }
  return addresses;
}

/** Renames extract-local asset names (`page-0.…`) to stored names (`<id>.page-0.…`). */
export function prefixPageAssets(pages: PptxTemplatePage[], prefix: string): PptxTemplatePage[] {
  return pages.map((page) => ({
    ...page,
    ...(page.background?.imageFile ? { background: { ...page.background, imageFile: `${prefix}${page.background.imageFile}` } } : {}),
    slots: page.slots.map((slot) => (slot.kind === 'image' && slot.imageFile ? { ...slot, imageFile: `${prefix}${slot.imageFile}` } : slot)),
    ...(page.shapes
      ? {
          shapes: page.shapes.map((shape) =>
            shape.type === 'image' ? { ...shape, imageFile: `${prefix}${shape.imageFile}` } : shape,
          ),
        }
      : {}),
  }));
}

/** Every asset file a stored template references (background + page assets). */
export function pptxTemplateAssetFiles(template: { backgroundImageFile?: string; pages?: PptxTemplatePage[] }): string[] {
  const files: string[] = [];
  if (template.backgroundImageFile) files.push(template.backgroundImageFile);
  for (const page of template.pages ?? []) {
    if (page.background?.imageFile) files.push(page.background.imageFile);
    for (const slot of page.slots) {
      if (slot.kind === 'image' && slot.imageFile) files.push(slot.imageFile);
    }
    for (const shape of page.shapes ?? []) {
      if (shape.type === 'image' && !files.includes(shape.imageFile)) files.push(shape.imageFile);
    }
  }
  return files;
}

export function templatePageTextSlots(page: PptxTemplatePage): PptxTextSlot[] {
  return page.slots.filter((slot): slot is PptxTextSlot => slot.kind === 'text');
}

export function templatePageImageSlots(page: PptxTemplatePage): PptxImageSlot[] {
  return page.slots.filter((slot): slot is PptxImageSlot => slot.kind === 'image');
}

/** One slot's address inside the template's kept source .pptx (v3). */
export interface PptxTemplateSlotAddress {
  /** Slot key from the parsed page (s0, s1, …). */
  key: string;
  kind: 'text' | 'image';
  /** shapeKeyOf() address of the shape within the source slide part. */
  shapeKey: string;
  /**
   * Child indices from the shape-tree root to the slot's shape
   * (`[4, 1]` = second child of the fifth top-level element, a group).
   * Present on slots inside <p:grpSp> groups and on every slot stored
   * since group-aware parsing; the clone export resolves it
   * unambiguously. Absent on pre-group records — the export then falls
   * back to the shapeKey over top-level shapes, as before.
   */
  shapePath?: number[];
  /** Text slots: how many <a:p> paragraphs the original shape carries. */
  paragraphs?: number;
  /** Image slots: package part holding the picture bytes. */
  mediaPart?: string;
  /** Image slots: the r:embed rel id of the picture in its slide. */
  embedId?: string;
}

/** One template page's addresses inside the kept source .pptx (v3). */
export interface PptxTemplatePageAddress {
  /** Source slide part name, e.g. "ppt/slides/slide3.xml". */
  slidePart: string;
  slots: PptxTemplateSlotAddress[];
}

/**
 * Pairs a parsed page's slots with the shapes of its source slide part
 * (both are in document order) so the clone export can find each slot's
 * shape again. Used at import time (stored with the template) and as a
 * fallback at export time for templates stored before v3. Pairing is
 * best-effort: a slot whose shape cannot be located is simply absent —
 * the export then leaves that shape's original sample in place.
 */
export function matchPageAddresses(slideXml: string, slideRelsXml: string, slidePart: string, page: PptxTemplatePage): PptxTemplatePageAddress {
  const rels = parseRels(slideRelsXml);
  const spTreeInner = /<p:spTree>([\s\S]*?)<\/p:spTree>/.exec(slideXml)?.[1] ?? slideXml;
  const textSlots = templatePageTextSlots(page);
  const imageSlots = templatePageImageSlots(page);
  const slots: PptxTemplateSlotAddress[] = [];
  // Both sides (page extraction above and this pairing) flatten the
  // shape tree with the same walker in the same order, and both apply
  // the same candidate rules — a text shape counts when it carries text
  // (or a placeholder) AND a locatable box (its own transform, or the
  // top-level layout-placeholder fallback extraction may have used) —
  // so slot N of the page is always leaf N of the candidates here.
  const keySeen = new Map<string, number>();
  let textIdx = 0;
  let imageIdx = 0;
  for (const leaf of walkShapeTree(spTreeInner)) {
    const shapeKey = leafShapeKey(leaf.xml, leaf.shapePath, keySeen);
    if (leaf.tag === 'sp') {
      const txBody = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(leaf.xml)?.[1];
      if (!txBody || !/<a:p(?=[\s>])/.test(txBody)) continue;
      if (!/<a:t>/.test(txBody) && !/<p:ph\b/.test(leaf.xml)) continue;
      if (leaf.rectEmu === undefined && leaf.shapePath.length > 1) continue;
      const slot = textSlots[textIdx];
      textIdx += 1;
      if (!slot) continue;
      const paragraphs = (txBody.match(/<a:p(?=[\s>])/g) ?? []).length;
      slots.push({ key: slot.key, kind: 'text', shapeKey, shapePath: leaf.shapePath, paragraphs: Math.max(1, paragraphs) });
      continue;
    }
    if (leaf.tag === 'pic') {
      if (leaf.rectEmu === undefined) continue;
      const slot = imageSlots[imageIdx];
      imageIdx += 1;
      if (!slot) continue;
      const address: PptxTemplateSlotAddress = { key: slot.key, kind: 'image', shapeKey, shapePath: leaf.shapePath };
      const embed = picEmbedId(leaf.xml);
      const rel = embed ? rels.get(embed) : undefined;
      if (rel) address.mediaPart = resolvePartPath(slidePart, rel.target);
      if (embed) address.embedId = embed;
      slots.push(address);
    }
  }
  return { slidePart, slots };
}

/**
 * Slot-content issues for one template slide (shared by validateDeck and
 * the generation pipeline so both speak the same repair language).
 * `slots` is the slide's content.slots map; values are strings for both
 * kinds — text copy for text slots, a deck asset name (or '') for images.
 */
export function validateTemplateSlideSlots(page: PptxTemplatePage, slots: unknown): string[] {
  const issues: string[] = [];
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
    return [`slots must be an object mapping slot keys (${page.slots.map((slot) => slot.key).join(', ') || 'none'}) to strings`];
  }
  const map = slots as Record<string, unknown>;
  const known = new Set(page.slots.map((slot) => slot.key));
  for (const key of Object.keys(map)) {
    if (!known.has(key)) issues.push(`slots.${key}: unknown slot — this template page has slots ${[...known].join(', ') || '(none)'}; remove it`);
  }
  for (const slot of page.slots) {
    const value = map[slot.key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      issues.push(`slots.${slot.key}: must be a string${slot.kind === 'image' ? ' (a deck asset name, or "" for the template image)' : ''}`);
      continue;
    }
    if (slot.kind === 'text' && value.length > slot.maxChars) {
      issues.push(`slots.${slot.key}: ${value.length} chars exceeds this slot's capacity of ${slot.maxChars} — shorten the text to fit the template box`);
    }
  }
  return issues;
}
