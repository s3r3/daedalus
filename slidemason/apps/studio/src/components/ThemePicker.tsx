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

interface ThemePickerProps {
  activeTheme: string;
  onSelectTheme: (theme: string) => void;
}

export function ThemePicker({ activeTheme, onSelectTheme }: ThemePickerProps) {
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px',
      }}>
        {THEMES.map(t => (
          <button
            key={t.name}
            onClick={() => onSelectTheme(t.name)}
            title={t.name}
            style={{
              width: '100%', aspectRatio: '1', borderRadius: '8px',
              backgroundColor: t.bg, border: activeTheme === t.name
                ? '2px solid rgba(139,92,246,0.8)'
                : '2px solid transparent',
              cursor: 'pointer', position: 'relative', overflow: 'hidden',
              boxShadow: activeTheme === t.name ? '0 0 0 2px rgba(139,92,246,0.4)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            {/* Primary color dot */}
            <div style={{
              position: 'absolute', bottom: '4px', right: '4px',
              width: '10px', height: '10px', borderRadius: '50%',
              backgroundColor: t.primary,
            }} />
            {/* Theme name */}
            <span style={{
              position: 'absolute', bottom: '4px', left: '4px',
              fontSize: '0.55rem', color: t.primary, opacity: 0.7,
            }}>
              {t.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
