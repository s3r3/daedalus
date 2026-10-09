import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  LAYOUTS,
  ToolRegistry,
  classifyToolName,
  createDefaultRegistry,
  exportDeckToPptx,
  getLayout,
  isToolVisible,
  layoutBlockKeys,
  newDeck,
  newSlideId,
  readDeck,
  validateDeck,
  validateSlideContent,
  writeDeck,
  type ToolCall,
} from '../src/index.ts';
import { SLIDE_TOOLS } from '../src/tools/slides.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function toolCall(tool: string, args: unknown, id = 'c1'): ToolCall {
  return { id, task_id: 't1', turn_id: 'u1', tool, args, started_at: new Date().toISOString() };
}

function slideRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of SLIDE_TOOLS) r.register(t);
  return r;
}

describe('slides store', () => {
  test('writeDeck → readDeck round-trip; readDeck null when absent', async () => {
    const root = temp('daedalus-slides-store-');
    expect(await readDeck(root)).toBeNull();
    const deck = newDeck('Round Trip');
    deck.slides.push({ id: newSlideId(), layout: 'title', content: { title: 'Round Trip' } });
    await writeDeck(root, deck);
    const back = await readDeck(root);
    expect(back).toEqual(deck);
    expect(existsSync(join(root, 'deck', 'deck.json'))).toBe(true);
    expect(existsSync(join(root, 'deck', 'assets'))).toBe(true);
  });
});

describe('validateDeck', () => {
  test('catches unknown layout, missing required, too many points, missing asset; long text is warning only', () => {
    const deck = newDeck('Validate Me');
    deck.slides.push(
      { id: 's-unknown', layout: 'nope-layout', content: { title: 'X' } },
      { id: 's-missing', layout: 'bullets', content: { title: 'No points' } },
      { id: 's-many', layout: 'bullets', content: { title: 'Many', points: ['1', '2', '3', '4', '5', '6', '7', '8'] } },
      { id: 's-image', layout: 'image-side', content: { title: 'Pic', points: ['a'], image: 'missing.png' } },
      { id: 's-long', layout: 'bullets', content: { title: 'Long', points: ['x'.repeat(200)] } },
    );
    const issues = validateDeck(deck, { assetExists: () => false });
    const bySlide = (id: string) => issues.filter((i) => i.slideId === id);
    expect(bySlide('s-unknown').some((i) => i.code === 'unknown-layout' && i.severity === 'error')).toBe(true);
    expect(bySlide('s-missing').some((i) => i.code === 'missing-required' && i.severity === 'error')).toBe(true);
    expect(bySlide('s-many').some((i) => i.code === 'too-many-items' && i.severity === 'error')).toBe(true);
    expect(bySlide('s-image').some((i) => i.code === 'missing-asset' && i.severity === 'error')).toBe(true);
    const longIssues = bySlide('s-long');
    expect(longIssues.length).toBeGreaterThan(0);
    expect(longIssues.every((i) => i.severity === 'warning')).toBe(true);
    expect(longIssues.some((i) => i.code === 'long-text')).toBe(true);
  });
});

describe('validateDeck positions (canvas drag placements)', () => {
  test('accepts in-range placements for real blocks; decks without positions are untouched', () => {
    const deck = newDeck('Placed');
    deck.slides.push(
      { id: 's-plain', layout: 'bullets', content: { title: 'Plain', points: ['a'] } },
      {
        id: 's-placed', layout: 'icon-grid',
        content: { title: 'Grid', items: [{ icon: 'zap', title: 'A' }, { icon: 'shield', title: 'B' }, { icon: 'heart', title: 'C' }] },
        positions: { title: { x: 0.1, y: 0.08 }, 'item-1': { x: 0.34, y: 0.4, w: 0.32, h: 0.3 } },
      },
    );
    const issues = validateDeck(deck).filter((i) => i.slideId === 's-placed' || i.slideId === 's-plain');
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('rejects garbage coordinates as errors and unknown block keys as warnings', () => {
    const deck = newDeck('Garbage');
    deck.slides.push({
      id: 's-bad', layout: 'bullets',
      content: { title: 'Bad', points: ['a'] },
      positions: {
        points: { x: 1.4, y: 0.2 },
        title: { x: 0.8, y: 0.1, w: 0.5 },
        nope: { x: 0.1, y: 0.1 },
      } as never,
    });
    const issues = validateDeck(deck).filter((i) => i.slideId === 's-bad');
    expect(issues.some((i) => i.code === 'invalid-position' && i.field === 'positions.points' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'invalid-position' && i.field === 'positions.title' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'unknown-block' && i.field === 'positions.nope' && i.severity === 'warning')).toBe(true);
  });
});

describe('layout library expansion (12 new layouts, 30 total)', () => {
  const NEW_LAYOUT_IDS = [
    'numbered-steps', 'code-focus', 'chevron-process', 'diagram-pyramid', 'roadmap', 'versus',
    'matrix-quadrant', 'big-stat', 'testimonial', 'profile-cards', 'glossary', 'mosaic',
  ];

  test('catalog carries the 18 existing layouts plus the 12 new ones', () => {
    expect(LAYOUTS).toHaveLength(30);
    for (const id of NEW_LAYOUT_IDS) expect(getLayout(id), id).toBeDefined();
  });

  test('every new layout ships defaults that validate without errors', () => {
    for (const id of NEW_LAYOUT_IDS) {
      const def = getLayout(id)!;
      const errors = validateSlideContent(def, JSON.parse(JSON.stringify(def.defaults)) as unknown)
        .filter((i) => i.severity === 'error');
      expect(errors, `${id}: ${JSON.stringify(errors)}`).toEqual([]);
    }
  });

  test('every new layout rejects content missing a required field', () => {
    for (const id of NEW_LAYOUT_IDS) {
      const def = getLayout(id)!;
      const content = JSON.parse(JSON.stringify(def.defaults)) as Record<string, unknown>;
      const required = def.schema.required[0]!;
      delete content[required];
      const issues = validateSlideContent(def, content);
      expect(issues.some((i) => i.code === 'missing-required' && i.severity === 'error'), `${id} without ${required}`).toBe(true);
    }
  });

  test('array bounds are enforced on the new layouts', () => {
    const steps = getLayout('numbered-steps')!;
    const tooMany = { title: 'X', steps: Array.from({ length: 7 }, (_, i) => ({ title: `S${i}` })) };
    expect(validateSlideContent(steps, tooMany).some((i) => i.code === 'too-many-items' && i.severity === 'error')).toBe(true);
    const mosaic = getLayout('mosaic')!;
    const tooFew = { tiles: [{ image: 'a.png' }, { image: 'b.png' }, { image: 'c.png' }] };
    expect(validateSlideContent(mosaic, tooFew).some((i) => i.code === 'too-few-items' && i.severity === 'error')).toBe(true);
    const quadrant = getLayout('matrix-quadrant')!;
    const three = { title: 'M', xAxis: 'X', yAxis: 'Y', quadrants: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    expect(validateSlideContent(quadrant, three).some((i) => i.severity === 'error')).toBe(true);
  });

  test('block keys name every draggable block of the new layouts', () => {
    expect(layoutBlockKeys('numbered-steps', { steps: [{}, {}, {}] })).toEqual(['title', 'step-0', 'step-1', 'step-2']);
    expect(layoutBlockKeys('chevron-process', { steps: [{}, {}, {}, {}] })).toEqual(['title', 'step-0', 'step-1', 'step-2', 'step-3']);
    expect(layoutBlockKeys('diagram-pyramid', { tiers: [{}, {}, {}] })).toEqual(['title', 'tier-0', 'tier-1', 'tier-2']);
    expect(layoutBlockKeys('roadmap', { phases: [{}, {}, {}, {}] })).toEqual(['title', 'phase-0', 'phase-1', 'phase-2', 'phase-3']);
    expect(layoutBlockKeys('matrix-quadrant', { quadrants: [{}, {}, {}, {}] })).toEqual(['title', 'quadrant-0', 'quadrant-1', 'quadrant-2', 'quadrant-3']);
    expect(layoutBlockKeys('big-stat', {})).toEqual(['title', 'value', 'label', 'points']);
    expect(layoutBlockKeys('testimonial', {})).toEqual(['text', 'person', 'metrics']);
    expect(layoutBlockKeys('code-focus', {})).toEqual(['title', 'code', 'points']);
    expect(layoutBlockKeys('versus', {})).toEqual(['title', 'left', 'right', 'badge', 'verdict']);
    expect(layoutBlockKeys('profile-cards', { people: [{}, {}, {}] })).toEqual(['title', 'person-0', 'person-1', 'person-2']);
    expect(layoutBlockKeys('glossary', { terms: [{}, {}, {}, {}] })).toEqual(['title', 'term-0', 'term-1', 'term-2', 'term-3']);
    expect(layoutBlockKeys('mosaic', { tiles: [{}, {}, {}, {}] })).toEqual(['title', 'tile-0', 'tile-1', 'tile-2', 'tile-3', 'caption']);
  });

  test('positions on new-layout blocks validate; unknown blocks warn', () => {
    const deck = newDeck('Placed New');
    deck.slides.push({
      id: 's-versus', layout: 'versus',
      content: { title: 'A vs B', left: { title: 'A', points: ['x'] }, right: { title: 'B', points: ['y'] } },
      positions: { badge: { x: 0.46, y: 0.42, w: 0.08, h: 0.12 }, nope: { x: 0.1, y: 0.1 } },
    });
    const issues = validateDeck(deck).filter((i) => i.slideId === 's-versus');
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.code === 'unknown-block' && i.field === 'positions.nope')).toBe(true);
  });

  test('exporter emits a real pptx covering every new layout', async () => {
    const root = temp('daedalus-slides-new-layouts-');
    const deck = newDeck('New Layouts Export');
    const content: Record<string, Record<string, unknown>> = {
      'numbered-steps': { title: 'Agenda', steps: [{ title: 'Satu', desc: 'Pertama' }, { title: 'Dua', desc: 'Kedua' }] },
      'code-focus': { title: 'Kode', code: 'const x = 1;', language: 'ts', points: ['Singkat'] },
      'chevron-process': { title: 'Alur', steps: [{ title: 'Mulai' }, { title: 'Proses' }, { title: 'Selesai' }] },
      'diagram-pyramid': { title: 'Piramida', tiers: [{ label: 'Visi' }, { label: 'Strategi' }, { label: 'Operasi' }] },
      'roadmap': { title: 'Peta', phases: [{ label: 'Fase 1', items: ['A'] }, { label: 'Fase 2', items: ['B'] }, { label: 'Fase 3', items: ['C'] }] },
      'versus': { title: 'A vs B', left: { title: 'A', points: ['Pro'] }, right: { title: 'B', points: ['Pro'] }, verdict: 'Seri' },
      'matrix-quadrant': { title: 'Matriks', xAxis: 'Dampak', yAxis: 'Upaya', quadrants: [{ label: 'Q1', items: ['a'] }, { label: 'Q2', items: ['b'] }, { label: 'Q3', items: ['c'] }, { label: 'Q4', items: ['d'] }] },
      'big-stat': { title: 'Hasil', value: '92%', label: 'Berhasil', points: ['Konteks pendukung'] },
      'testimonial': { text: 'Sangat membantu.', name: 'Andini Prameswari', role: 'Ketua Tim', metrics: [{ value: '3x', label: 'Lebih cepat' }] },
      'profile-cards': { title: 'Tim', people: [{ name: 'Andini Prameswari', role: 'Ketua' }, { name: 'Bagas Nugraha', role: 'Inti' }, { name: 'Citra Lestari', role: 'Desain' }] },
      'glossary': { title: 'Istilah', terms: [{ term: 'Agent', definition: 'Pelaksana langkah' }, { term: 'Prompt', definition: 'Instruksi' }, { term: 'Deck', definition: 'Kumpulan slide' }, { term: 'Layout', definition: 'Tata letak' }] },
      'mosaic': { title: 'Galeri', tiles: [{ image: 'a.png' }, { image: 'b.png' }, { image: 'c.png' }, { image: 'd.png' }] },
    };
    for (const id of NEW_LAYOUT_IDS) deck.slides.push({ id: `s-${id}`, layout: id, content: content[id]! });
    const result = await exportDeckToPptx(deck, root);
    expect(result.slideCount).toBe(12);
    const path = join(root, result.relativePath);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(10_000);
  });
});

describe('slide tools end-to-end', () => {
  test('create → add → update → move → delete → validate → export produces a real pptx', async () => {
    const root = temp('daedalus-slides-tools-');
    const registry = slideRegistry();
    const ctx = { workspaceRoot: root };
    const call = (tool: string, args: unknown, id: string) => registry.execute(toolCall(tool, args, id), ctx);

    expect((await call('create_deck', { title: 'Slide Deck Test' }, 'a')).status).toBe('ok');
    // duplicate create must fail
    expect((await call('create_deck', { title: 'Again' }, 'a2')).status).toBe('error');

    const addTitle = await call('add_slide', { layout: 'title', content: { title: 'Hello Deck', subtitle: 'Agentic Slide' } }, 'b');
    expect(addTitle.status).toBe('ok');
    expect((await call('add_slide', { layout: 'bullets', content: { title: 'Points', points: ['One', 'Two'] } }, 'c')).status).toBe('ok');
    expect((await call('add_slide', { layout: 'diagram-flow', content: { title: 'Flow', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] } }, 'd')).status).toBe('ok');
    const addChart = await call('add_slide', { layout: 'chart-bar', content: { title: 'Numbers', data: [{ label: 'Q1', value: 3 }, { label: 'Q2', value: 7 }] } }, 'e');
    expect(addChart.status).toBe('ok');

    const deck1 = await readDeck(root);
    expect(deck1!.slides).toHaveLength(4);
    const chartSlide = deck1!.slides.find((s) => s.layout === 'chart-bar')!;

    const upd = await call('update_slide', { slideId: chartSlide.id, content: { title: 'Numbers Updated' } }, 'f');
    expect(upd.status).toBe('ok');
    expect((await readDeck(root))!.slides.find((s) => s.id === chartSlide.id)!.content.title).toBe('Numbers Updated');

    const mv = await call('move_slide', { slideId: chartSlide.id, toIndex: 0 }, 'g');
    expect(mv.status).toBe('ok');
    expect((await readDeck(root))!.slides[0]!.id).toBe(chartSlide.id);

    const del = await call('delete_slide', { slideId: chartSlide.id }, 'h');
    expect(del.status).toBe('ok');
    expect((await readDeck(root))!.slides).toHaveLength(3);

    // re-add chart so export covers charts too, then validate + export
    expect((await call('add_slide', { layout: 'chart-bar', content: { title: 'Numbers', data: [{ label: 'Q1', value: 3 }, { label: 'Q2', value: 7 }] } }, 'e2')).status).toBe('ok');

    const val = await call('validate_deck', {}, 'i');
    expect(val.status).toBe('ok');
    expect(val.output).toContain('deck valid');

    const exp = await call('export_deck', {}, 'j');
    expect(exp.status).toBe('ok');
    const files = readdirSync(join(root, 'deck')).filter((f) => f.endsWith('.pptx'));
    expect(files).toHaveLength(1);
    const pptxPath = join(root, 'deck', files[0]!);
    expect(existsSync(pptxPath)).toBe(true);
    expect(statSync(pptxPath).size).toBeGreaterThan(10_000);
  });

  test('default registry also carries the slide tools', () => {
    const names = createDefaultRegistry().list().map((t) => t.name);
    for (const n of ['create_deck', 'read_deck', 'add_slide', 'update_slide', 'move_slide', 'delete_slide', 'set_deck_theme', 'validate_deck', 'export_deck']) {
      expect(names).toContain(n);
    }
  });
});

describe('slide tool mode classification', () => {
  test('deck-writing tool descriptions carry the nested content schemas the validator enforces', () => {
    const add = SLIDE_TOOLS.find((tool) => tool.name === 'add_slide');
    const update = SLIDE_TOOLS.find((tool) => tool.name === 'update_slide');
    for (const tool of [add, update]) {
      expect(tool?.description).toContain('diagram-flow');
      expect(tool?.description).toContain('steps*');
      expect(tool?.description).toContain('title*');
      expect(tool?.description).toContain('timeline');
      expect(tool?.description).toContain('when*');
      expect(tool?.description).toContain('comparison');
      expect(tool?.description).toContain('points*');
    }
  });

  test('read/mutating/executing classes and visibility', () => {
    expect(classifyToolName('read_deck')).toBe('read');
    expect(classifyToolName('validate_deck')).toBe('read');
    expect(classifyToolName('add_slide')).toBe('mutating');
    expect(classifyToolName('create_deck')).toBe('mutating');
    expect(classifyToolName('export_deck')).toBe('executing');
    expect(isToolVisible('ask', 'add_slide')).toBe(false);
    expect(isToolVisible('ask', 'read_deck')).toBe(true);
    expect(isToolVisible('auto', 'create_deck')).toBe(true);
    expect(isToolVisible('auto', 'export_deck')).toBe(true);
  });
});
