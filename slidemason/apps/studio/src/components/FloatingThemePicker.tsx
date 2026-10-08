import { useEffect, useState } from 'react';

const THEMES = [
  { name: 'slate', bg: '#1e293b', primary: '#3b82f6' },
  { name: 'canvas', bg: '#faf5eb', primary: '#b45309' },
  { name: 'signal', bg: '#0f172a', primary: '#22d3ee' },
  { name: 'noir', bg: '#0a0a0a', primary: '#ffffff' },
  { name: 'dawn', bg: '#fefce8', primary: '#f97316' },
  { name: 'boardroom', bg: '#1c1917', primary: '#a78bfa' },
  { name: 'neon', bg: '#0a0a0a', primary: '#a855f7' },
  { name: 'forest', bg: '#14532d', primary: '#4ade80' },
  { name: 'glacier', bg: '#ecfeff', primary: '#0891b2' },
  { name: 'sunset', bg: '#1c1917', primary: '#fb923c' },
  { name: 'paper', bg: '#fafaf9', primary: '#57534e' },
  { name: 'midnight', bg: '#18181b', primary: '#8b5cf6' },
];

interface FloatingThemePickerProps {
  activeTheme: string;
  onSelectTheme: (theme: string) => void;
}

export function FloatingThemePicker({ activeTheme, onSelectTheme }: FloatingThemePickerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <div style={{ position: 'fixed', bottom: '24px', left: '24px', zIndex: 50 }}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        aria-label="Toggle theme picker"
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          backgroundColor: 'rgba(0,0,0,0.6)',
          border: '1px solid rgba(255,255,255,0.2)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: '1.1rem',
          backdropFilter: 'blur(8px)',
        }}
      >
        🎨
      </button>

      {/* Swatch panel */}
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '50px',
            left: 0,
            backgroundColor: 'rgba(20,20,30,0.95)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px',
            padding: '12px',
            width: '180px',
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '6px',
          }}
        >
          {THEMES.map(t => (
            <button
              key={t.name}
              onClick={() => {
                onSelectTheme(t.name);
                setOpen(false);
              }}
              aria-label={`${t.name} theme${activeTheme === t.name ? ' (active)' : ''}`}
              title={t.name}
              style={{
                width: '100%',
                aspectRatio: '1',
                borderRadius: '6px',
                backgroundColor: t.bg,
                border: activeTheme === t.name ? '2px solid rgba(139,92,246,0.8)' : '2px solid transparent',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  bottom: '3px',
                  right: '3px',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: t.primary,
                }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
