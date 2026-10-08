import type { ThemeConfig } from './types';

export const boardroom: ThemeConfig = {
  name: 'boardroom',
  colors: {
    background: '#0c1929',
    surface: '#162a40',
    text: '#f8fafc',
    muted: '#8b9db8',
    primary: '#38bdf8',
    secondary: '#38bdf8',
    accent: '#a78bfa',
    border: '#1e3a5f',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    gradientStart: '#38bdf8',
    gradientEnd: '#a78bfa',
    chart: ['#38bdf8', '#a78bfa', '#e2e8f0', '#f59e0b', '#22c55e', '#ef4444'],
    glass: 'rgba(22,42,64,0.7)',
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
