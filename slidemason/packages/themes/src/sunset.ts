import type { ThemeConfig } from './types';

export const sunset: ThemeConfig = {
  name: 'sunset',
  colors: {
    background: '#1e1b4b',
    surface: '#312e81',
    text: '#fef3c7',
    muted: '#a5b4fc',
    primary: '#f97316',
    secondary: '#ec4899',
    accent: '#fbbf24',
    border: '#3730a3',
    success: '#22c55e',
    warning: '#fbbf24',
    danger: '#ef4444',
    gradientStart: '#f97316',
    gradientEnd: '#ec4899',
    chart: ['#f97316', '#ec4899', '#fbbf24', '#22d3ee', '#a3e635', '#a78bfa'],
    glass: 'rgba(49,46,129,0.7)',
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
