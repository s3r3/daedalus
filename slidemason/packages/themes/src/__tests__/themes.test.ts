import { describe, it, expect } from 'vitest';
import { themes, getTheme } from '../index';

const allThemeNames = [
  'slate', 'canvas', 'signal', 'noir', 'dawn', 'boardroom',
  'neon', 'forest', 'glacier', 'sunset', 'paper', 'midnight',
];

describe('themes', () => {
  it('exports twelve themes', () => {
    expect(Object.keys(themes)).toHaveLength(12);
    for (const name of allThemeNames) {
      expect(themes).toHaveProperty(name);
    }
  });

  it('each theme has required token categories', () => {
    for (const theme of Object.values(themes)) {
      expect(theme).toHaveProperty('name');
      expect(theme).toHaveProperty('colors');
      expect(theme).toHaveProperty('typography');
      expect(theme).toHaveProperty('spacing');
      expect(theme).toHaveProperty('radius');
      expect(theme).toHaveProperty('shadow');
      expect(theme.colors).toHaveProperty('background');
      expect(theme.colors).toHaveProperty('surface');
      expect(theme.colors).toHaveProperty('text');
      expect(theme.colors).toHaveProperty('muted');
      expect(theme.colors).toHaveProperty('primary');
      expect(theme.colors).toHaveProperty('secondary');
      expect(theme.colors).toHaveProperty('accent');
      expect(theme.colors).toHaveProperty('border');
    }
  });

  it('each theme has new semantic color fields', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.colors).toHaveProperty('success');
      expect(theme.colors).toHaveProperty('warning');
      expect(theme.colors).toHaveProperty('danger');
      expect(theme.colors.success).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.colors.warning).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.colors.danger).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('each theme has gradient colors', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.colors).toHaveProperty('gradientStart');
      expect(theme.colors).toHaveProperty('gradientEnd');
      expect(theme.colors.gradientStart).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.colors.gradientEnd).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('each theme has a chart palette of 6 colors', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.colors.chart).toHaveLength(6);
      for (const color of theme.colors.chart) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('each theme has a glass background', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.colors.glass).toMatch(/^rgba\(/);
    }
  });

  it('getTheme returns a theme by name', () => {
    for (const name of allThemeNames) {
      expect(getTheme(name).name).toBe(name);
    }
  });

  it('getTheme throws for unknown theme', () => {
    expect(() => getTheme('nonexistent')).toThrow();
  });
});
