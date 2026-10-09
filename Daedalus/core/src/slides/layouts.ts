import type { DeckIssue } from './deck.ts';

// Kept local so this module stays pure/browser-safe (no node:* transitively).
const LONG_TEXT_CHARS = 140;

export type PropSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export type PropSchema = {
  type: PropSchemaType;
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: string[];
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  enum?: Array<string | number | boolean>;
};

export type LayoutSchema = {
  type: 'object';
  required: string[];
  properties: Record<string, PropSchema>;
  additionalProperties: false;
};

export type LayoutCategory = 'opener' | 'content' | 'visual' | 'data' | 'closing';

export type LayoutDef = {
  id: string;
  label: string;
  category: LayoutCategory;
  schema: LayoutSchema;
  defaults: Record<string, unknown>;
};

const s = (): PropSchema => ({ type: 'string' });
const n = (): PropSchema => ({ type: 'number' });
// A few fields are number|string in the spec (section.number, stats.value);
// the lite schema types them as string and the validator also accepts numbers.
type LoosePropSchema = PropSchema & { allowNumber?: boolean };

function stringArray(minItems?: number, maxItems?: number): PropSchema {
  return { type: 'array', items: s(), ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) };
}

function obj(required: string[], properties: Record<string, PropSchema>): PropSchema {
  return { type: 'object', required, properties };
}

function schema(required: string[], properties: Record<string, PropSchema>): LayoutSchema {
  return { type: 'object', required, properties, additionalProperties: false };
}

const columnSchema = (): PropSchema => obj(['heading', 'points'], { heading: s(), points: stringArray(1, 7) });
const namedColumnSchema = (): PropSchema => obj(['title', 'points'], { title: s(), points: stringArray(1, 7) });

export const LAYOUTS: LayoutDef[] = [
  {
    id: 'title', label: 'Title', category: 'opener',
    schema: schema(['title'], { title: s(), subtitle: s() }),
    defaults: { title: 'Untitled presentation', subtitle: '' },
  },
  {
    id: 'section', label: 'Section divider', category: 'opener',
    // number may be number|string; schema encodes as string, validator accepts numbers for this field via allowNumber on the property below.
    schema: schema(['title'], { title: s(), number: { type: 'string' } as PropSchema }),
    defaults: { title: 'Section', number: 1 },
  },
  {
    id: 'bullets', label: 'Bullets', category: 'content',
    schema: schema(['title', 'points'], { title: s(), points: stringArray(1, 7) }),
    defaults: { title: 'Key points', points: ['First point'] },
  },
  {
    id: 'two-column', label: 'Two column', category: 'content',
    schema: schema(['title', 'left', 'right'], { title: s(), left: columnSchema(), right: columnSchema() }),
    defaults: { title: 'Two columns', left: { heading: 'Left', points: ['Point'] }, right: { heading: 'Right', points: ['Point'] } },
  },
  {
    id: 'image-side', label: 'Image side', category: 'visual',
    schema: schema(['title', 'points', 'image'], { title: s(), points: stringArray(1, 7), image: s(), alt: s(), side: { type: 'string', enum: ['left', 'right'] } }),
    defaults: { title: 'Visual', points: ['Point'], image: 'image.png', side: 'right' },
  },
  {
    id: 'diagram-flow', label: 'Flow diagram', category: 'visual',
    schema: schema(['title', 'steps'], {
      title: s(),
      steps: { type: 'array', minItems: 3, maxItems: 6, items: obj(['title'], { title: s(), desc: s() }) },
    }),
    defaults: { title: 'Process', steps: [{ title: 'Start' }, { title: 'Work' }, { title: 'Done' }] },
  },
  {
    id: 'diagram-cycle', label: 'Cycle diagram', category: 'visual',
    schema: schema(['title', 'nodes'], { title: s(), nodes: { type: 'array', items: s(), minItems: 4, maxItems: 4 } }),
    defaults: { title: 'Cycle', nodes: ['Plan', 'Do', 'Check', 'Act'] },
  },
  {
    id: 'diagram-hierarchy', label: 'Hierarchy diagram', category: 'visual',
    schema: schema(['title', 'root', 'groups'], {
      title: s(), root: s(),
      groups: { type: 'array', minItems: 1, maxItems: 4, items: obj(['label', 'items'], { label: s(), items: stringArray(1, 8) }) },
    }),
    defaults: { title: 'Structure', root: 'Root', groups: [{ label: 'Group', items: ['Item'] }] },
  },
  {
    id: 'timeline', label: 'Timeline', category: 'visual',
    schema: schema(['title', 'events'], {
      title: s(),
      events: { type: 'array', minItems: 2, maxItems: 6, items: obj(['when', 'title'], { when: s(), title: s(), desc: s() }) },
    }),
    defaults: { title: 'Timeline', events: [{ when: '2024', title: 'Start' }, { when: '2025', title: 'Launch' }] },
  },
  {
    id: 'comparison', label: 'Comparison', category: 'visual',
    schema: schema(['title', 'left', 'right'], { title: s(), left: namedColumnSchema(), right: namedColumnSchema(), verdict: s() }),
    defaults: { title: 'Comparison', left: { title: 'Option A', points: ['Pro'] }, right: { title: 'Option B', points: ['Pro'] } },
  },
  {
    id: 'chart-bar', label: 'Bar chart', category: 'data',
    schema: schema(['title', 'data'], {
      title: s(),
      data: { type: 'array', minItems: 2, maxItems: 8, items: obj(['label', 'value'], { label: s(), value: n() }) },
      unit: s(),
    }),
    defaults: { title: 'Bar chart', data: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }] },
  },
  {
    id: 'chart-line', label: 'Line chart', category: 'data',
    schema: schema(['title', 'series'], {
      title: s(),
      series: { type: 'array', minItems: 1, maxItems: 3, items: obj(['name', 'points'], { name: s(), points: { type: 'array', items: n(), minItems: 2 } }) },
      unit: s(),
    }),
    defaults: { title: 'Trend', series: [{ name: 'Series 1', points: [1, 2, 3] }] },
  },
  {
    id: 'chart-donut', label: 'Donut chart', category: 'data',
    schema: schema(['title', 'slices'], {
      title: s(),
      slices: { type: 'array', minItems: 2, maxItems: 6, items: obj(['label', 'value'], { label: s(), value: n() }) },
      unit: s(),
    }),
    defaults: { title: 'Share', slices: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] },
  },
  {
    id: 'table', label: 'Table', category: 'data',
    schema: schema(['title', 'columns', 'rows'], {
      title: s(),
      columns: { type: 'array', items: s(), minItems: 2, maxItems: 6 },
      rows: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'array', items: s() } },
    }),
    defaults: { title: 'Table', columns: ['Column 1', 'Column 2'], rows: [['A', 'B']] },
  },
  {
    id: 'stats', label: 'Stats', category: 'data',
    schema: schema(['title', 'stats'], {
      title: s(),
      stats: { type: 'array', minItems: 2, maxItems: 4, items: obj(['value', 'label'], { value: s(), label: s() }) },
    }),
    defaults: { title: 'Highlights', stats: [{ value: '100%', label: 'Coverage' }, { value: '2x', label: 'Faster' }] },
  },
  {
    id: 'quote', label: 'Quote', category: 'content',
    schema: schema(['text'], { text: s(), author: s() }),
    defaults: { text: 'A memorable quote.', author: '' },
  },
  {
    id: 'icon-grid', label: 'Icon grid', category: 'visual',
    schema: schema(['title', 'items'], {
      title: s(),
      items: { type: 'array', minItems: 3, maxItems: 6, items: obj(['icon', 'title'], { icon: s(), title: s(), desc: s() }) },
    }),
    defaults: { title: 'Features', items: [{ icon: 'zap', title: 'Fast' }, { icon: 'shield', title: 'Safe' }, { icon: 'heart', title: 'Loved' }] },
  },
  {
    id: 'closing', label: 'Closing', category: 'closing',
    schema: schema(['title'], { title: s(), cta: s() }),
    defaults: { title: 'Thank you', cta: '' },
  },
];

// Allow section.number to be number|string despite the lite schema typing.
(LAYOUTS.find((l) => l.id === 'section')!.schema.properties.number as LoosePropSchema).allowNumber = true;
// stats.value may be number|string in practice; keep schema string but allow numbers similarly.
(LAYOUTS.find((l) => l.id === 'stats')!.schema.properties.stats!.items!.properties!.value as LoosePropSchema).allowNumber = true;

export const LAYOUT_IDS: string[] = LAYOUTS.map((l) => l.id);

function indexedKeys(field: unknown, prefix: string, cap?: number): string[] {
  const count = Array.isArray(field) ? field.length : 0;
  const n = cap !== undefined ? Math.min(count, cap) : count;
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

/**
 * The named, individually placeable blocks a slide of this layout has,
 * given its content (slides/deck.ts `positions` keys). The Web canvas
 * editor drags exactly these blocks, the PPTX exporter places exactly
 * these blocks, and validateDeck rejects placements for anything else —
 * one vocabulary shared by all three. Repeated elements are indexed
 * (`step-0`, `item-2`, `stat-1`, ...) in content order.
 */
export function layoutBlockKeys(layoutId: string, content: Record<string, unknown>): string[] {
  switch (layoutId) {
    case 'title': return ['title', 'subtitle'];
    case 'section': return ['number', 'title'];
    case 'closing': return ['title', 'cta'];
    case 'quote': return ['text', 'author'];
    case 'bullets': return ['title', 'points'];
    case 'two-column': return ['title', 'left', 'right'];
    case 'comparison': return ['title', 'left', 'right', 'verdict'];
    case 'image-side': return ['title', 'points', 'image'];
    case 'diagram-flow': return ['title', ...indexedKeys(content.steps, 'step')];
    case 'diagram-cycle': return ['title', ...indexedKeys(content.nodes, 'node', 4)];
    case 'diagram-hierarchy': return ['title', 'root', ...indexedKeys(content.groups, 'group')];
    case 'timeline': return ['title', ...indexedKeys(content.events, 'event')];
    case 'chart-bar': return ['title', 'chart'];
    case 'chart-line': return ['title', 'chart', 'legend'];
    case 'chart-donut': return ['title', 'chart', 'legend'];
    case 'table': return ['title', 'table'];
    case 'stats': return ['title', ...indexedKeys(content.stats, 'stat')];
    case 'icon-grid': return ['title', ...indexedKeys(content.items, 'item')];
    default: return [];
  }
}

export function getLayout(id: string): LayoutDef | undefined {
  return LAYOUTS.find((l) => l.id === id);
}

/** Compact schema rendering (`*` = required), rendered from the same schema objects the validator enforces, so a model sees the exact field shapes (nested objects and array item fields included) instead of guessing them. Shared by the deck-tool descriptions and the slide generation pipeline's stage prompts. */
function summarizePropSchema(prop: PropSchema): string {
  if (prop.type === 'array') {
    const items = prop.items ? summarizePropSchema(prop.items) : 'string';
    const bounds = prop.minItems !== undefined || prop.maxItems !== undefined ? ` (${prop.minItems ?? 0}..${prop.maxItems ?? 'n'})` : '';
    return `${items}[]${bounds}`;
  }
  if (prop.type === 'object' && prop.properties) {
    const required = new Set(prop.required ?? []);
    const fields = Object.entries(prop.properties).map(([key, value]) => `${key}${required.has(key) ? '*' : ''}: ${summarizePropSchema(value)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return prop.enum ? prop.enum.join('|') : prop.type;
}

export function summarizeLayoutSchema(layout: LayoutDef): string {
  const required = new Set(layout.schema.required);
  const fields = Object.entries(layout.schema.properties).map(([key, value]) => `${key}${required.has(key) ? '*' : ''}: ${summarizePropSchema(value)}`);
  return `${layout.id} { ${fields.join(', ')} }`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issue(field: string | undefined, code: string, message: string, severity: 'error' | 'warning' = 'error', layout?: string): DeckIssue {
  return { ...(field ? { field } : {}), code, message, severity, ...(layout ? { layout } : {}) };
}

function validateValue(field: string, prop: PropSchema, value: unknown, issues: DeckIssue[], layoutId: string): void {
  const loose = prop as LoosePropSchema;
  if (prop.enum && !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? prop.enum.includes(value as string) : false)) {
    issues.push(issue(field, 'invalid-enum', `${field} must be one of: ${prop.enum.join(', ')}`, 'error', layoutId));
    return;
  }
  switch (prop.type) {
    case 'string': {
      if (typeof value !== 'string') {
        if (loose.allowNumber && typeof value === 'number' && Number.isFinite(value)) return;
        issues.push(issue(field, 'invalid-type', `${field} must be a string`, 'error', layoutId));
        return;
      }
      if (prop.maxLength !== undefined && value.length > prop.maxLength) {
        issues.push(issue(field, 'too-long', `${field} exceeds maxLength ${prop.maxLength}`, 'error', layoutId));
      } else if (value.length > LONG_TEXT_CHARS) {
        issues.push(issue(field, 'long-text', `${field} is long (${value.length} chars > ${LONG_TEXT_CHARS}); consider shortening`, 'warning', layoutId));
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) issues.push(issue(field, 'invalid-type', `${field} must be a number`, 'error', layoutId));
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') issues.push(issue(field, 'invalid-type', `${field} must be a boolean`, 'error', layoutId));
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { issues.push(issue(field, 'invalid-type', `${field} must be an array`, 'error', layoutId)); return; }
      if (prop.minItems !== undefined && value.length < prop.minItems) issues.push(issue(field, 'too-few-items', `${field} needs at least ${prop.minItems} item(s), got ${value.length}`, 'error', layoutId));
      if (prop.maxItems !== undefined && value.length > prop.maxItems) issues.push(issue(field, 'too-many-items', `${field} allows at most ${prop.maxItems} item(s), got ${value.length}`, 'error', layoutId));
      if (prop.items) value.forEach((item, i) => validateValue(`${field}[${i}]`, prop.items!, item, issues, layoutId));
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) { issues.push(issue(field, 'invalid-type', `${field} must be an object`, 'error', layoutId)); return; }
      validateObjectFields(field, prop, value, issues, layoutId);
      return;
    }
  }
}

function validateObjectFields(prefix: string, prop: PropSchema, value: Record<string, unknown>, issues: DeckIssue[], layoutId: string): void {
  const required = prop.required ?? [];
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      const field = prefix ? `${prefix}.${key}` : key;
      issues.push(issue(field, 'missing-required', `${field} is required`, 'error', layoutId));
    }
  }
  const props = prop.properties ?? {};
  for (const [key, val] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    const sub = props[key];
    if (!sub) {
      issues.push(issue(field, 'unknown-field', `${field} is not a known field for layout ${layoutId}`, 'warning', layoutId));
      continue;
    }
    if (val !== undefined) validateValue(field, sub, val, issues, layoutId);
  }
}

export function validateSlideContent(layout: LayoutDef | string, content: unknown): DeckIssue[] {
  const def = typeof layout === 'string' ? getLayout(layout) : layout;
  if (!def) {
    return [issue(undefined, 'unknown-layout', `unknown layout: ${String(layout)}`)];
  }
  if (!isPlainObject(content)) {
    return [issue(undefined, 'invalid-type', `content for layout ${def.id} must be an object`, 'error', def.id)];
  }
  const issues: DeckIssue[] = [];
  // Top-level follows LayoutSchema (additionalProperties:false -> warning unknown-field)
  validateObjectFields('', { type: 'object', required: def.schema.required, properties: def.schema.properties }, content, issues, def.id);
  return issues.map((i) => ({ ...i, layout: def.id }));
}
