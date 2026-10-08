import { useState } from 'react';

interface BeforeAfterProps {
  before: React.ReactNode;
  after: React.ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function BeforeAfter({
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  style,
  className = '',
}: BeforeAfterProps) {
  const [showAfter, setShowAfter] = useState(false);

  const buttonBase: React.CSSProperties = {
    padding: '8px 16px',
    border: '1px solid',
    borderRadius: 'var(--sm-radius)',
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    fontSize: '0.8rem',
    transition: 'background 0.15s ease, color 0.15s ease',
  };

  return (
    <div className={className} style={style} data-pptx-type="passthrough">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setShowAfter(false)}
          aria-pressed={!showAfter}
          style={{
            ...buttonBase,
            background: !showAfter ? 'var(--sm-primary)' : 'var(--sm-glass-bg)',
            color: !showAfter ? 'var(--sm-bg)' : 'var(--sm-muted)',
            borderColor: !showAfter ? 'var(--sm-primary)' : 'var(--sm-border)',
          }}
        >
          {beforeLabel}
        </button>
        <button
          onClick={() => setShowAfter(true)}
          aria-pressed={showAfter}
          style={{
            ...buttonBase,
            background: showAfter ? 'var(--sm-primary)' : 'var(--sm-glass-bg)',
            color: showAfter ? 'var(--sm-bg)' : 'var(--sm-muted)',
            borderColor: showAfter ? 'var(--sm-primary)' : 'var(--sm-border)',
          }}
        >
          {afterLabel}
        </button>
      </div>
      <div>{showAfter ? after : before}</div>
    </div>
  );
}
