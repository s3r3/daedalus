interface SpacerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  style?: React.CSSProperties;
}

const sizes = {
  sm: 'clamp(0.4rem, 1cqb, 0.75rem)',
  md: 'clamp(0.75rem, 2cqb, 1.5rem)',
  lg: 'clamp(1.25rem, 3.5cqb, 2.5rem)',
  xl: 'clamp(2rem, 5cqb, 4rem)',
};

export function Spacer({ size = 'md', style }: SpacerProps) {
  return (
    <div
      data-pptx-type="spacer"
      style={{
        height: sizes[size] ?? sizes['md'],
        ...style,
      }}
    />
  );
}
