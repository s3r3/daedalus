import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ToolRegistry,
  classifyToolName,
  createDefaultRegistry,
  isToolVisible,
  newDeck,
  newSlideId,
  readDeck,
  validateDeck,
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
