/**
 * Shared top-level element scanning for slide XML (shape-tree children).
 *
 * The slide XML work in this package (pptx-pages.ts slot extraction,
 * export-template.ts clone-and-rewrite) is regex-based by design (no XML
 * dependency in core), but both sides must agree on how one top-level
 * `<p:sp>`/`<p:pic>`/`<p:graphicFrame>`/`<p:grpSp>` element is delimited —
 * a naive non-greedy regex to the first close tag stops early on nested
 * same-tag children (e.g. `<p:grpSp>` holds whole `<p:sp>` subtrees), so
 * the scanner counts same-tag open/close depth. Self-closing opens count
 * as closed. The shapes this returns are the top-level children of the
 * shape tree in document order; callers decide what each element means.
 */

export interface TopLevelElement {
  /** Tag name after the `p:` prefix, e.g. "sp", "pic", "graphicFrame", "grpSp". */
  tag: string;
  /** Start offset of the open tag (`<`) in the source string. */
  start: number;
  /** Offset just past the matching close tag (`>`). */
  end: number;
  /** The full element XML, open tag through close tag. */
  xml: string;
}

const ELEMENT_TAGS = ['graphicFrame', 'grpSp', 'cxnSp', 'pic', 'sp'] as const;

/**
 * Splits a shape-tree fragment into its top-level shape elements, in
 * document order. Text between elements (whitespace) is ignored; nested
 * elements of the same tag (group children) stay inside their parent.
 */
export function splitTopLevelElements(fragment: string): TopLevelElement[] {
  const out: TopLevelElement[] = [];
  const openRe = new RegExp(`<p:(${ELEMENT_TAGS.join('|')})(?=[\\s/>])`, 'g');
  let guard = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(fragment)) !== null && guard < 4096) {
    guard += 1;
    const tag = match[1]!;
    const start = match.index;
    const openEnd = fragment.indexOf('>', start);
    if (openEnd < 0) break;
    if (fragment[openEnd - 1] === '/') {
      out.push({ tag, start, end: openEnd + 1, xml: fragment.slice(start, openEnd + 1) });
      openRe.lastIndex = openEnd + 1;
      continue;
    }
    // Count same-tag nesting (only grpSp realistically nests its own tag).
    const tagRe = new RegExp(`<p:${tag}(?=[\\s/>])|</p:${tag}>`, 'g');
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(fragment)) !== null) {
      if (m[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          end = tagRe.lastIndex;
          break;
        }
      } else {
        // A self-closing sibling of the same tag inside does not nest.
        const gt = fragment.indexOf('>', m.index);
        if (gt < 0 || fragment[gt - 1] !== '/') depth += 1;
      }
    }
    if (end < 0) break;
    out.push({ tag, start, end, xml: fragment.slice(start, end) });
    openRe.lastIndex = end;
  }
  return out;
}

/** The `<p:cNvPr id="…">` id of a shape element, when present. */
export function shapeElementId(elementXml: string): number | undefined {
  const id = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(elementXml)?.[1];
  return id !== undefined ? Number(id) : undefined;
}

/** The embed rel id (`r:embed="rId7"`) of a `<p:pic>` element, when present. */
export function picEmbedId(picXml: string): string | undefined {
  return /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(picXml)?.[1];
}

/* ------------------------------------------- group-aware tree walking */

/**
 * One leaf shape of a shape tree, flattened in document order (group
 * children appear where their group sits). `shapePath` is the chain of
 * child indices from the shape-tree root — `[4, 1]` is child 1 of the
 * group at top-level index 4 — and is the stable address the clone
 * export uses to find the same shape again inside a group, where a bare
 * cNvPr id is not guaranteed unique per slide. `rectEmu` is the shape's
 * box in SLIDE EMU coordinates: for group children the group's
 * chOff/chExt child space is mapped through its off/ext box (arbitrary
 * nesting composes), including flipH/flipV mirroring. Group rotation
 * (`rot` on the group's xfrm) is NOT applied — the rect stays the
 * axis-aligned unrotated mapping, an honest preview-grade approximation
 * (the clone export never consumes rects, only paths).
 */
export interface ShapeTreeLeaf {
  /** Tag name after the `p:` prefix, e.g. "sp", "pic", "graphicFrame", "grpSp" is never a leaf. */
  tag: string;
  /** The full element XML, open tag through close tag. */
  xml: string;
  /** Child indices from the shape-tree root. */
  shapePath: number[];
  /** Slide-EMU box when the shape carries an <a:xfrm> off/ext. */
  rectEmu?: { x: number; y: number; cx: number; cy: number };
}

/** Affine map from a group's child space into its parent's space: slide = a·p + b per axis. */
interface SpaceTransform { ax: number; bx: number; ay: number; by: number }
const IDENTITY_TRANSFORM: SpaceTransform = { ax: 1, bx: 0, ay: 1, by: 0 };

interface XfrmParts { x: number; y: number; cx: number; cy: number }

/** off/ext of the first <a:xfrm> inside `xml` (the shape's own transform). */
function xfrmOffExt(xml: string): XfrmParts | undefined {
  const block = /<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(xml)?.[1];
  if (!block) return undefined;
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(block);
  const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"/.exec(block);
  if (!off || !ext) return undefined;
  return { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) };
}

function applyTransform(t: SpaceTransform, rect: XfrmParts): { x: number; y: number; cx: number; cy: number } {
  const x1 = t.ax * rect.x + t.bx;
  const x2 = t.ax * (rect.x + rect.cx) + t.bx;
  const y1 = t.ay * rect.y + t.by;
  const y2 = t.ay * (rect.y + rect.cy) + t.by;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), cx: Math.abs(x2 - x1), cy: Math.abs(y2 - y1) };
}

/** Parent transform ∘ one group's child-space mapping. */
function composeGroupTransform(parent: SpaceTransform, grpXml: string): SpaceTransform {
  const grpSpPr = /<p:grpSpPr>([\s\S]*?)<\/p:grpSpPr>/.exec(grpXml)?.[1];
  if (!grpSpPr) return parent;
  const xfrmTag = /<a:xfrm\b([^>]*)>/.exec(grpSpPr)?.[0];
  const body = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(grpSpPr)?.[1];
  if (!xfrmTag || !body) return parent;
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(body);
  const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"/.exec(body);
  if (!off || !ext) return parent;
  const offX = Number(off[1]);
  const offY = Number(off[2]);
  const extCx = Number(ext[1]);
  const extCy = Number(ext[2]);
  const chOff = /<a:chOff x="(-?\d+)" y="(-?\d+)"/.exec(body);
  const chExt = /<a:chExt cx="(-?\d+)" cy="(-?\d+)"/.exec(body);
  const chOffX = chOff ? Number(chOff[1]) : offX;
  const chOffY = chOff ? Number(chOff[2]) : offY;
  const chExtCx = chExt && Number(chExt[1]) !== 0 ? Number(chExt[1]) : extCx;
  const chExtCy = chExt && Number(chExt[2]) !== 0 ? Number(chExt[2]) : extCy;
  const sx = chExtCx !== 0 ? extCx / chExtCx : 1;
  const sy = chExtCy !== 0 ? extCy / chExtCy : 1;
  const flipH = /\bflipH="1"/.test(xfrmTag);
  const flipV = /\bflipV="1"/.test(xfrmTag);
  // Unflipped: q = off + (p − chOff)·s. Flipped: q = off + (chOff + chExt − p)·s.
  const lax = flipH ? -sx : sx;
  const lbx = flipH ? offX + extCx + chOffX * sx : offX - chOffX * sx;
  const lay = flipV ? -sy : sy;
  const lby = flipV ? offY + extCy + chOffY * sy : offY - chOffY * sy;
  return { ax: parent.ax * lax, bx: parent.ax * lbx + parent.bx, ay: parent.ay * lay, by: parent.ay * lby + parent.by };
}

const MAX_GROUP_DEPTH = 32;

function walkLevel(fragment: string, prefix: number[], transform: SpaceTransform, out: ShapeTreeLeaf[]): void {
  splitTopLevelElements(fragment).forEach((element, index) => {
    const shapePath = [...prefix, index];
    if (element.tag === 'grpSp') {
      if (prefix.length >= MAX_GROUP_DEPTH) return;
      const openEnd = element.xml.indexOf('>');
      const closeStart = element.xml.lastIndexOf('</p:grpSp>');
      if (openEnd < 0 || closeStart <= openEnd) return;
      walkLevel(element.xml.slice(openEnd + 1, closeStart), shapePath, composeGroupTransform(transform, element.xml), out);
      return;
    }
    const rect = xfrmOffExt(element.xml);
    out.push({
      tag: element.tag,
      xml: element.xml,
      shapePath,
      ...(rect ? { rectEmu: applyTransform(transform, rect) } : {}),
    });
  });
}

/**
 * Flattens a shape-tree fragment into its leaf shapes in document
 * order, descending into <p:grpSp> groups (arbitrary nesting) with the
 * group coordinate transforms applied. The shape tree's own
 * nvGrpSpPr/grpSpPr header children carry no shape tags and never
 * appear as leaves. Graphic frames and connectors are leaves (callers
 * decide what they mean); groups themselves are containers, not leaves.
 */
export function walkShapeTree(shapeTreeFragment: string): ShapeTreeLeaf[] {
  const out: ShapeTreeLeaf[] = [];
  walkLevel(shapeTreeFragment, [], IDENTITY_TRANSFORM, out);
  return out;
}

/**
 * Secondary key of one walked leaf: the cNvPr id (`id-12`, `#n` suffix
 * on repeats across the whole walk, counted through the shared `seen`
 * map) or, without an id, the dotted shape path (`ord-4.1`). Both the
 * template store (at import) and the clone export compute keys through
 * this one function over the same walk, so the two sides cannot drift.
 * For group-free slides the result is identical to createShapeKeyer's.
 */
export function leafShapeKey(xml: string, shapePath: number[], seen: Map<string, number>): string {
  const id = shapeElementId(xml);
  const base = id !== undefined ? `id-${id}` : `ord-${shapePath.join('.')}`;
  const occurrence = (seen.get(base) ?? 0) + 1;
  seen.set(base, occurrence);
  return occurrence === 1 ? base : `${base}#${occurrence}`;
}

/**
 * Stable address of one top-level shape inside its slide: the cNvPr id
 * when the producer wrote one (`id-12`), else the element's document
 * order index (`ord-3`). Both the template store (at import) and the
 * clone export (at rewrite) compute addresses through one keyer per
 * slide, so the two sides cannot drift apart.
 *
 * Real producers sometimes repeat a cNvPr id across shapes of one slide
 * (pptxgenjs writes id="1..n" but hand-rolled generators often repeat
 * id="2"), so a repeated id is suffixed with its occurrence count
 * (`id-2#2`). The walk order is identical on both sides — same bytes,
 * same elements.
 */
export function createShapeKeyer(): (elementXml: string, ordinal: number) => string {
  const seen = new Map<string, number>();
  return (elementXml: string, ordinal: number): string => {
    const id = shapeElementId(elementXml);
    const base = id !== undefined ? `id-${id}` : `ord-${ordinal}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base}#${occurrence}`;
  };
}
