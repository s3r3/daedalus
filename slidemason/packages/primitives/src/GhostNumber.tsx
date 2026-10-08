interface GhostNumberProps {
  n: number | string;
  style?: React.CSSProperties;
}

export function GhostNumber({ n, style }: GhostNumberProps) {
  return (
    <div
      data-pptx-type="ghost"
      style={{
        position: 'absolute',
        right: 'clamp(1rem, 3cqi, 2rem)',
        top: '50%',
        transform: 'translateY(-50%)',
        fontSize: 'clamp(8rem, 22cqi, 18rem)',
        fontWeight: 900,
        lineHeight: 1,
        color: 'var(--sm-text)',
        opacity: 0.06,
        pointerEvents: 'none',
        userSelect: 'none',
        ...style,
      }}
    >
      {n}
    </div>
  );
}
