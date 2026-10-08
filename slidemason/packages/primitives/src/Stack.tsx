interface StackProps {
  gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  align?: 'start' | 'center' | 'end' | 'stretch';
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const gapSizes = {
  xs: 'clamp(0.15rem, 0.4cqb, 0.4rem)',
  sm: 'clamp(0.3rem, 0.8cqb, 0.75rem)',
  md: 'clamp(0.5rem, 1.2cqb, 1.2rem)',
  lg: 'clamp(0.75rem, 2cqb, 1.75rem)',
  xl: 'clamp(1.25rem, 3cqb, 2.5rem)',
};

export function Stack({ gap = 'md', align = 'stretch', style, className = '', children }: StackProps) {
  return (
    <div
      data-pptx-type="stack"
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: gapSizes[gap] ?? gapSizes['md'],
        alignItems: align,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
