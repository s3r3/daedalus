interface DividerProps {
  width?: string;
  style?: React.CSSProperties;
}

export function Divider({ width = 'clamp(2rem, 4cqi, 3rem)', style }: DividerProps) {
  return (
    <div
      data-pptx-type="divider"
      style={{
        width,
        height: 3,
        background: 'linear-gradient(90deg, var(--sm-primary), var(--sm-secondary))',
        borderRadius: 2,
        ...style,
      }}
    />
  );
}
