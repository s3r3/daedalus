interface ColorBarProps {
  color?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  thickness?: number;
  style?: React.CSSProperties;
}

export function ColorBar({
  color = 'var(--sm-primary)',
  position = 'top',
  thickness = 3,
  style,
}: ColorBarProps) {
  const isHorizontal = position === 'top' || position === 'bottom';
  return (
    <div
      data-pptx-type="colorbar"
      style={{
        position: 'absolute',
        background: color,
        ...(isHorizontal
          ? { left: 0, right: 0, height: thickness, [position]: 0 }
          : { top: 0, bottom: 0, width: thickness, [position]: 0 }),
        ...style,
      }}
    />
  );
}
