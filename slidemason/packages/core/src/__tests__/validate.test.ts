import { describe, it, expect } from 'vitest';
import { validateBrief, validateOutline } from '../validate';

describe('validateBrief', () => {
  it('returns success for valid brief', () => {
    const result = validateBrief({
      title: 'Test',
      audience: 'team',
      goal: 'inform',
      tone: 'casual',
      themes: [],
      sources: [],
    });
    expect(result.success).toBe(true);
  });

  it('returns errors for invalid brief', () => {
    const result = validateBrief({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('validateOutline', () => {
  it('returns success for valid outline', () => {
    const result = validateOutline({
      theme: 'slate',
      slides: [{ id: 's1', type: 'title-hero', intent: 'open', headline: 'Title' }],
    });
    expect(result.success).toBe(true);
  });

  it('returns errors for empty slides', () => {
    const result = validateOutline({ slides: [] });
    expect(result.success).toBe(false);
  });
});
