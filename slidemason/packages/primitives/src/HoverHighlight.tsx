import { useState, Children, cloneElement, isValidElement } from 'react';

interface HoverHighlightProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export function HoverHighlight({
  children,
  style,
  className = '',
}: HoverHighlightProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const items = Children.toArray(children);

  return (
    <div className={className} style={style} data-pptx-type="passthrough">
      {items.map((child, i) => {
        if (!isValidElement(child)) return child;

        const isActive = hoveredIndex === i;
        const hasSomeHovered = hoveredIndex !== null;

        return cloneElement(child as React.ReactElement<Record<string, unknown>>, {
          key: i,
          onMouseEnter: () => setHoveredIndex(i),
          onMouseLeave: () => setHoveredIndex(null),
          onFocus: () => setHoveredIndex(i),
          onBlur: () => setHoveredIndex(null),
          style: {
            ...(typeof (child as React.ReactElement<Record<string, unknown>>).props.style === 'object'
              ? (child as React.ReactElement<Record<string, unknown>>).props.style as React.CSSProperties
              : {}),
            opacity: hasSomeHovered ? (isActive ? 1 : 0.35) : 1,
            transform: isActive ? 'scale(1.02)' : 'scale(1)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
          },
        });
      })}
    </div>
  );
}
