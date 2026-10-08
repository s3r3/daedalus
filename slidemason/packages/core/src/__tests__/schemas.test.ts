import { describe, it, expect } from 'vitest';
import { BriefSchema, OutlineSchema, ManifestSchema } from '../schemas';

describe('BriefSchema', () => {
  it('validates a valid brief', () => {
    const brief = {
      title: 'Q2 Strategy Review',
      audience: 'executive leadership',
      goal: 'align on strategy and resource allocation',
      tone: 'clear, executive, persuasive',
      themes: ['growth', 'efficiency'],
      sources: [{ file: 'notes.md', type: 'markdown', summary: 'Meeting notes' }],
      constraints: ['15 slides max'],
    };
    expect(BriefSchema.parse(brief)).toEqual(brief);
  });

  it('rejects a brief missing required fields', () => {
    expect(() => BriefSchema.parse({})).toThrow();
  });
});

describe('OutlineSchema', () => {
  it('validates a valid outline', () => {
    const outline = {
      theme: 'slate',
      slides: [
        {
          id: 's1',
          type: 'title-hero',
          intent: 'open strongly',
          headline: 'Q2 Strategy Review',
          subheadline: 'Priorities and tradeoffs',
          components: [],
          notesSeed: 'Open with the shift in priorities',
        },
      ],
    };
    expect(OutlineSchema.parse(outline)).toBeDefined();
  });

  it('validates new slide types', () => {
    const outline = {
      theme: 'midnight',
      slides: [
        { id: 's1', type: 'icon-features', intent: 'show features', headline: 'Features' },
        { id: 's2', type: 'flywheel', intent: 'show cycle', headline: 'Our Process' },
        { id: 's3', type: 'data-dashboard', intent: 'show metrics', headline: 'KPIs' },
      ],
    };
    expect(OutlineSchema.parse(outline)).toBeDefined();
  });
});

describe('ManifestSchema', () => {
  it('validates a valid manifest', () => {
    const manifest = {
      generatedAt: '2026-02-27T00:00:00Z',
      dataDir: './data',
      files: [
        {
          path: 'data/notes.md',
          name: 'notes.md',
          type: 'markdown',
          size: 1234,
          modifiedAt: '2026-02-27T00:00:00Z',
        },
      ],
    };
    expect(ManifestSchema.parse(manifest)).toBeDefined();
  });
});
