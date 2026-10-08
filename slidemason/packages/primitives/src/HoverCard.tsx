import { useState } from 'react';

interface HoverCardProps {
  children: React.ReactNode;
  hoverContent: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export function HoverCard({
  children,
  hoverContent,
  style,
  className = '',
}: HoverCardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={className}
      data-pptx-type="passthrough"
      style={{
        background: 'var(--sm-glass-bg)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--sm-border)',
        borderRadius: 'var(--sm-radius)',
        padding: 'clamp(0.75rem, 2cqi, 1.5rem)',
        transform: hovered ? 'translateY(-4px)' : 'translateY(0)',
        boxShadow: hovered ? 'var(--sm-shadow-lg)' : 'none',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        ...style,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      tabIndex={0}
    >
      {children}
      <div
        style={{
          overflow: 'hidden',
          maxHeight: hovered ? 500 : 0,
          opacity: hovered ? 1 : 0,
          transition: 'max-height 0.3s ease, opacity 0.2s ease',
        }}
      >
        {hoverContent}
      </div>
    </div>
  );
}
