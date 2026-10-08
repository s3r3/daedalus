interface RowProps {
  gap?: 'xs' | 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  wrap?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const gapSizes = {
  xs: 'clamp(0.15rem, 0.4cqi, 0.4rem)',
  sm: 'clamp(0.3rem, 0.8cqi, 0.6rem)',
  md: 'clamp(0.5rem, 1.2cqi, 1rem)',
  lg: 'clamp(0.75rem, 2cqi, 1.5rem)',
};

export function Row({ gap = 'md', align = 'center', wrap = false, style, className = '', children }: RowProps) {
  return (
    <div
      data-pptx-type="row"
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: gapSizes[gap] ?? gapSizes['md'],
        alignItems: align,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
