interface SplitProps {
  ratio?: '35/65' | '40/60' | '50/50' | '60/40' | '65/35';
  reverse?: boolean;
  /** Stacks vertically on narrow containers. Default: true */
  stackOnNarrow?: boolean;
  gap?: string;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const ratioMap: Record<string, [string, string]> = {
  '35/65': ['35%', '65%'],
  '40/60': ['40%', '60%'],
  '50/50': ['50%', '50%'],
  '60/40': ['60%', '40%'],
  '65/35': ['65%', '35%'],
};

export function Split({
  ratio = '35/65',
  reverse = false,
  stackOnNarrow = true,
  gap = 'clamp(1rem, 2.5cqi, 2.5rem)',
  style,
  className = '',
  children,
}: SplitProps) {
  const [left, right] = ratioMap[ratio] ?? ratioMap['35/65'];
  return (
    <div
      data-pptx-type="split"
      className={className}
      style={{
        display: 'flex',
        flexDirection: reverse ? 'row-reverse' : 'row',
        flexWrap: stackOnNarrow ? 'wrap' : 'nowrap',
        gap,
        ...style,
      }}
    >
      {Array.isArray(children)
        ? children.map((child, i) => (
            <div
              key={i}
              style={{
                flex: stackOnNarrow
                  ? `1 1 min(100%, ${i === 0 ? left : right})`
                  : `0 0 calc(${i === 0 ? left : right} - ${gap} / 2)`,
                minWidth: stackOnNarrow ? 'min(100%, 280px)' : undefined,
              }}
            >
              {child}
            </div>
          ))
        : children}
    </div>
  );
}
