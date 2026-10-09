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
