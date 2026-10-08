import { useState } from 'react';

interface FlipcardProps {
  front: React.ReactNode;
  back: React.ReactNode;
  width?: string;
  height?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function Flipcard({
  front,
  back,
  width = '100%',
  height = '100%',
  style,
  className = '',
}: FlipcardProps) {
  const [flipped, setFlipped] = useState(false);

  const faceBase: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    backfaceVisibility: 'hidden',
    background: 'var(--sm-glass-bg)',
    backdropFilter: 'blur(12px)',
    border: '1px solid var(--sm-border)',
    borderRadius: 'var(--sm-radius)',
    padding: 'clamp(0.75rem, 2cqi, 1.5rem)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <button
      className={className}
      data-pptx-type="passthrough"
      onClick={() => setFlipped(!flipped)}
      aria-label={flipped ? 'Flip card to front' : 'Flip card to back'}
      style={{
        perspective: 1000,
        cursor: 'pointer',
        width,
        height,
        background: 'none',
        border: 'none',
        padding: 0,
        textAlign: 'inherit',
        ...style,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          transformStyle: 'preserve-3d',
          transition: 'transform 0.6s ease',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        <div style={faceBase}>{front}</div>
        <div
          style={{
            ...faceBase,
            transform: 'rotateY(180deg)',
            borderColor: 'var(--sm-primary)',
          }}
        >
          {back}
        </div>
      </div>
    </button>
  );
}
