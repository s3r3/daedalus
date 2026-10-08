import type { ThemeConfig } from './types';

export const midnight: ThemeConfig = {
  name: 'midnight',
  colors: {
    background: '#18181b',
    surface: '#27272a',
    text: '#fafafa',
    muted: '#a1a1aa',
    primary: '#8b5cf6',
    secondary: '#06b6d4',
    accent: '#f43f5e',
    border: '#3f3f46',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    gradientStart: '#8b5cf6',
    gradientEnd: '#06b6d4',
    chart: ['#8b5cf6', '#06b6d4', '#f43f5e', '#f59e0b', '#22c55e', '#3b82f6'],
    glass: 'rgba(39,39,42,0.7)',
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
    sm: '0 1px 2px rgba(0,0,0,0.4)',
    md: '0 4px 6px rgba(0,0,0,0.4)',
    lg: '0 10px 15px rgba(0,0,0,0.4)',
  },
};
