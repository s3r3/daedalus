import type { ThemeConfig } from './types';

export const neon: ThemeConfig = {
  name: 'neon',
  colors: {
    background: '#0a0a0a',
    surface: '#171717',
    text: '#ffffff',
    muted: '#737373',
    primary: '#ec4899',
    secondary: '#22d3ee',
    accent: '#a3e635',
    border: '#262626',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    gradientStart: '#ec4899',
    gradientEnd: '#22d3ee',
    chart: ['#ec4899', '#22d3ee', '#a3e635', '#f59e0b', '#8b5cf6', '#3b82f6'],
    glass: 'rgba(23,23,23,0.7)',
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
    sm: '0 1px 2px rgba(0,0,0,0.5)',
    md: '0 4px 6px rgba(0,0,0,0.5)',
    lg: '0 10px 15px rgba(0,0,0,0.5)',
  },
};
