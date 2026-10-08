import { FONT_PAIRINGS, loadGoogleFont } from '../lib/fonts';

interface FontPickerProps {
  headingFont: string;
  bodyFont: string;
  onChangePairing: (heading: string, body: string) => void;
}

export function FontPicker({ headingFont, bodyFont, onChangePairing }: FontPickerProps) {
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
        {FONT_PAIRINGS.map(p => {
          const isActive = p.heading === headingFont && p.body === bodyFont;
          return (
            <button
              key={p.name}
              onClick={() => {
                loadGoogleFont(p.heading);
                loadGoogleFont(p.body);
                onChangePairing(p.heading, p.body);
              }}
              onMouseEnter={() => {
                loadGoogleFont(p.heading);
                loadGoogleFont(p.body);
              }}
              style={{
                padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                backgroundColor: isActive ? 'rgba(139,92,246,0.25)' : '#2a2a3e',
                border: `1px solid ${isActive ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '6px', color: '#fff', lineHeight: 1.2,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{
                  fontFamily: `'${p.heading}', sans-serif`,
                  fontWeight: 700, fontSize: '0.95rem',
                }}>
                  {p.name}
                </span>
                <span style={{ fontSize: '0.6rem', color: '#666' }}>
                  {p.heading === p.body ? p.heading : `${p.heading} + ${p.body}`}
                </span>
              </div>
              <span style={{
                display: 'block', fontFamily: `'${p.body}', sans-serif`,
                fontSize: '0.7rem', color: '#888', marginTop: '2px',
              }}>
                {p.vibe}
              </span>
            </button>
          );
        })}
      </div>

      {/* Preview of current selection */}
      <div style={{
        backgroundColor: '#1a1a2e', borderRadius: '6px', padding: '10px',
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        <p style={{
          color: '#fff', fontSize: '1.1rem', fontWeight: 700, margin: '0 0 4px',
          fontFamily: `'${headingFont}', sans-serif`,
        }}>
          Heading Preview
        </p>
        <p style={{
          color: '#aaa', fontSize: '0.8rem', margin: 0,
          fontFamily: `'${bodyFont}', sans-serif`,
        }}>
          Body text looks like this. The quick brown fox jumps over the lazy dog.
        </p>
      </div>
    </div>
  );
}
