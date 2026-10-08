import { useId, useState } from 'react';

interface TabItem {
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  items: TabItem[];
  defaultIndex?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function Tabs({
  items = [],
  defaultIndex = 0,
  style,
  className = '',
}: TabsProps) {
  const [activeIndex, setActiveIndex] = useState(defaultIndex);
  const id = useId();

  const buttonBase: React.CSSProperties = {
    padding: '8px 16px',
    border: '1px solid',
    borderRadius: 'var(--sm-radius)',
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    fontSize: '0.8rem',
    transition: 'background 0.15s ease, color 0.15s ease',
  };

  return (
    <div className={className} style={style} data-pptx-type="tabs">
      <div role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {items.map((item, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={i}
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={isActive}
              aria-controls={`${id}-panel-${i}`}
              onClick={() => setActiveIndex(i)}
              style={{
                ...buttonBase,
                background: isActive ? 'var(--sm-primary)' : 'var(--sm-glass-bg)',
                color: isActive ? 'var(--sm-bg)' : 'var(--sm-muted)',
                borderColor: isActive ? 'var(--sm-primary)' : 'var(--sm-border)',
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-${activeIndex}`}
        aria-labelledby={`${id}-tab-${activeIndex}`}
      >
        {items[activeIndex]?.content}
      </div>
    </div>
  );
}
