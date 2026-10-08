import type { ComponentType } from 'react';

const SIZES = {
  sm: { box: 'clamp(28px, 4cqi, 40px)', icon: 16 },
  md: { box: 'clamp(36px, 5cqi, 52px)', icon: 20 },
  lg: { box: 'clamp(44px, 6.5cqi, 72px)', icon: 24 },
} as const;

interface IconCircleProps {
  icon: ComponentType<{ size?: number; style?: React.CSSProperties }>;
  size?: keyof typeof SIZES;
  active?: boolean;
  color?: string;
  style?: React.CSSProperties;
}

export function IconCircle({
  icon: Icon,
  size = 'md',
  active = false,
  color = 'var(--sm-primary)',
  style,
}: IconCircleProps) {
  const s = SIZES[size] ?? SIZES['md'];

  return (
    <div
      data-pptx-type="icon"
      style={{
        width: s.box,
        height: s.box,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? color : 'var(--sm-surface)',
        border: `2px solid ${active ? color : 'var(--sm-border)'}`,
        flexShrink: 0,
        ...style,
      }}
    >
      <Icon size={s.icon} style={{ color: active ? 'var(--sm-bg)' : color }} />
    </div>
  );
}
