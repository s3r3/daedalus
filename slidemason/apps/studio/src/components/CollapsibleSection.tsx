import type { ReactNode } from 'react';

interface CollapsibleSectionProps {
  step: number;
  title: string;
  children: ReactNode;
  open: boolean;
  done: boolean;
  onToggle: () => void;
  onNext?: () => void;
  /** Validation error shown above Next button — blocks advancing when set */
  error?: string;
}

export function CollapsibleSection({
  step, title, children, open, done, onToggle, onNext, error,
}: CollapsibleSectionProps) {
  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '10px 0', backgroundColor: 'transparent', border: 'none',
          cursor: 'pointer', color: '#fff', fontSize: '0.8rem', fontWeight: 600,
        }}
      >
        {/* Step number / checkmark */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
          backgroundColor: done
            ? 'rgba(34,197,94,0.25)'
            : open
              ? 'rgba(139,92,246,0.25)'
              : 'rgba(255,255,255,0.06)',
          color: done ? '#86efac' : open ? '#c4b5fd' : '#888',
          fontSize: '0.6rem', fontWeight: 700,
        }}>
          {done ? '✓' : step}
        </span>

        <span style={{
          flex: 1, textAlign: 'left',
          color: done ? '#888' : open ? '#fff' : '#aaa',
          textDecoration: done ? 'line-through' : 'none',
        }}>
          {title}
        </span>

        {/* Chevron */}
        <span style={{
          color: '#666', fontSize: '0.55rem',
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          ▶
        </span>
      </button>

      {open && (
        <div style={{ paddingBottom: '12px', paddingLeft: '28px' }}>
          {children}

          {onNext && (
            <>
              {error && (
                <p style={{
                  color: '#f87171', fontSize: '0.7rem', margin: '8px 0 0',
                  padding: '6px 8px', backgroundColor: 'rgba(248,113,113,0.1)',
                  borderRadius: '4px', border: '1px solid rgba(248,113,113,0.2)',
                }}>
                  {error}
                </p>
              )}
              <button
                onClick={onNext}
                style={{
                  marginTop: '8px', width: '100%', padding: '8px', fontSize: '0.75rem',
                  fontWeight: 600, backgroundColor: 'rgba(139,92,246,0.2)', color: '#c4b5fd',
                  border: '1px solid rgba(139,92,246,0.3)', borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                Next →
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
