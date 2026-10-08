import { useState, Children, cloneElement, isValidElement } from 'react';

interface SpotlightProps {
  children: React.ReactNode;
  defaultActive?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function Spotlight({
  children,
  defaultActive = 0,
  style,
  className = '',
}: SpotlightProps) {
  const items = Children.toArray(children);
  const [active, setActive] = useState(defaultActive);

  return (
    <div className={className} style={style} data-pptx-type="passthrough">
      <div>
        {items.map((child, i) => {
          if (!isValidElement(child)) return child;
          const isActive = active === i;
          return cloneElement(child as React.ReactElement<Record<string, unknown>>, {
            key: i,
            style: {
              ...(typeof (child as React.ReactElement<Record<string, unknown>>).props.style === 'object'
                ? (child as React.ReactElement<Record<string, unknown>>).props.style as React.CSSProperties
                : {}),
              opacity: isActive ? 1 : 0.3,
              transform: isActive ? 'scale(1.02)' : 'scale(0.98)',
              transition: 'opacity 0.3s ease, transform 0.3s ease',
            },
          });
        })}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 8,
          marginTop: 16,
        }}
      >
        {items.map((_, i) => {
          const isActive = active === i;
          return (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`Show item ${i + 1}`}
              aria-current={isActive ? 'true' : undefined}
              style={{
                width: isActive ? 24 : 8,
                height: 8,
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: isActive ? 'var(--sm-primary)' : 'var(--sm-border)',
                transition: 'all 0.2s ease',
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
