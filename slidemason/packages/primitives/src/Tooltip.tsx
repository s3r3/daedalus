import { useState } from 'react';

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  position?: 'top' | 'bottom';
  style?: React.CSSProperties;
}

export function Tooltip({
  children,
  content,
  position = 'top',
  style,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);

  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    ...(position === 'top'
      ? { bottom: '100%', marginBottom: 8 }
      : { top: '100%', marginTop: 8 }),
    background: 'var(--sm-surface)',
    border: '1px solid var(--sm-border)',
    borderRadius: 'var(--sm-radius)',
    boxShadow: 'var(--sm-shadow-md)',
    zIndex: 50,
    pointerEvents: 'none' as const,
    whiteSpace: 'nowrap' as const,
    padding: '6px 12px',
    color: 'var(--sm-text)',
    fontSize: '0.85rem',
    opacity: visible ? 1 : 0,
    transition: 'opacity 0.15s ease',
  };

  return (
    <div
      data-pptx-type="passthrough"
      style={{ position: 'relative', display: 'inline-block', ...style }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <div role="tooltip" style={tooltipStyle}>{content}</div>
    </div>
  );
}
