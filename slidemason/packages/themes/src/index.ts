import { slate } from './slate';
import { canvas } from './canvas';
import { signal } from './signal';
import { noir } from './noir';
import { dawn } from './dawn';
import { boardroom } from './boardroom';
import { neon } from './neon';
import { forest } from './forest';
import { glacier } from './glacier';
import { sunset } from './sunset';
import { paper } from './paper';
import { midnight } from './midnight';
import type { ThemeConfig } from './types';

export type { ThemeConfig } from './types';

export const themes: Record<string, ThemeConfig> = {
  slate,
  canvas,
  signal,
  noir,
  dawn,
  boardroom,
  neon,
  forest,
  glacier,
  sunset,
  paper,
  midnight,
};

export function getTheme(name: string): ThemeConfig {
  const theme = themes[name];
  if (!theme) throw new Error(`Unknown theme: ${name}. Available: ${Object.keys(themes).join(', ')}`);
  return theme;
}
