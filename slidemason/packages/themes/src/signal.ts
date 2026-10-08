import type { ThemeConfig } from './types';

export const signal: ThemeConfig = {
  name: 'signal',
  colors: {
    background: '#020617',
    surface: '#0f172a',
    text: '#ffffff',
    muted: '#64748b',
    primary: '#e11d48',
    secondary: '#7c3aed',
    accent: '#f59e0b',
    border: '#1e293b',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    gradientStart: '#e11d48',
    gradientEnd: '#7c3aed',
    chart: ['#e11d48', '#7c3aed', '#f59e0b', '#06b6d4', '#22c55e', '#3b82f6'],
    glass: 'rgba(15,23,42,0.7)',
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
