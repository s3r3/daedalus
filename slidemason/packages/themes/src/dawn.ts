import type { ThemeConfig } from './types';

export const dawn: ThemeConfig = {
  name: 'dawn',
  colors: {
    background: '#fef3c7',
    surface: '#ffffff',
    text: '#292524',
    muted: '#78716c',
    primary: '#c2410c',
    secondary: '#059669',
    accent: '#7c3aed',
    border: '#e7e5e4',
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
    gradientStart: '#c2410c',
    gradientEnd: '#059669',
    chart: ['#c2410c', '#059669', '#7c3aed', '#2563eb', '#d97706', '#dc2626'],
    glass: 'rgba(255,247,237,0.85)',
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
    sm: '0 1px 2px rgba(0,0,0,0.06)',
    md: '0 4px 6px rgba(0,0,0,0.08)',
    lg: '0 10px 15px rgba(0,0,0,0.1)',
  },
};
