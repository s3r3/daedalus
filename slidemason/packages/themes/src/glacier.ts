import type { ThemeConfig } from './types';

export const glacier: ThemeConfig = {
  name: 'glacier',
  colors: {
    background: '#f0f9ff',
    surface: '#ffffff',
    text: '#0c4a6e',
    muted: '#64748b',
    primary: '#0369a1',
    secondary: '#0891b2',
    accent: '#6366f1',
    border: '#bae6fd',
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
    gradientStart: '#0369a1',
    gradientEnd: '#6366f1',
    chart: ['#0369a1', '#0891b2', '#6366f1', '#d97706', '#16a34a', '#dc2626'],
    glass: 'rgba(224,242,254,0.8)',
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
