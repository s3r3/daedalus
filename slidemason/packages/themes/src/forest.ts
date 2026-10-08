import type { ThemeConfig } from './types';

export const forest: ThemeConfig = {
  name: 'forest',
  colors: {
    background: '#052e16',
    surface: '#14532d',
    text: '#f0fdf4',
    muted: '#86efac',
    primary: '#4ade80',
    secondary: '#fbbf24',
    accent: '#f9a8d4',
    border: '#166534',
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#ef4444',
    gradientStart: '#86efac',
    gradientEnd: '#fbbf24',
    chart: ['#86efac', '#fbbf24', '#f9a8d4', '#38bdf8', '#a78bfa', '#fb923c'],
    glass: 'rgba(20,83,45,0.7)',
  },
  typography: {
    headingFont: "'Inter', system-ui, sans-serif",
    bodyFont: "'Inter', system-ui, sans-serif",
    monoFont: "'JetBrains Mono', ui-monospace, monospace",
  },
  spacing: {
    slidePadding: '3rem',
    elementGap: '1.5rem',
  },
  radius: '0.5rem',
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.35)',
    md: '0 4px 6px rgba(0,0,0,0.35)',
    lg: '0 10px 15px rgba(0,0,0,0.35)',
  },
};
