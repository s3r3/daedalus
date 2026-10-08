import type { ThemeConfig } from './types';

export const noir: ThemeConfig = {
  name: 'noir',
  colors: {
    background: '#000000',
    surface: '#111111',
    text: '#f5f5f4',
    muted: '#737373',
    primary: '#d4a574',
    secondary: '#a8a29e',
    accent: '#fbbf24',
    border: '#262626',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    gradientStart: '#d4a574',
    gradientEnd: '#a8a29e',
    chart: ['#d4a574', '#fbbf24', '#a8a29e', '#ef4444', '#22c55e', '#3b82f6'],
    glass: 'rgba(17,17,17,0.7)',
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
