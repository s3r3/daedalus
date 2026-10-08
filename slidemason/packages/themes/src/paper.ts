import type { ThemeConfig } from './types';

export const paper: ThemeConfig = {
  name: 'paper',
  colors: {
    background: '#fffbeb',
    surface: '#ffffff',
    text: '#1c1917',
    muted: '#78716c',
    primary: '#1e3a5f',
    secondary: '#b91c1c',
    accent: '#047857',
    border: '#e7e5e4',
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
    gradientStart: '#1e3a5f',
    gradientEnd: '#b91c1c',
    chart: ['#1e3a5f', '#b91c1c', '#047857', '#d97706', '#7c3aed', '#0891b2'],
    glass: 'rgba(255,251,235,0.85)',
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
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 6px rgba(0,0,0,0.07)',
    lg: '0 10px 15px rgba(0,0,0,0.1)',
  },
};
