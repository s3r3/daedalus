import { Children } from 'react';
import { motion, type TargetAndTransition, type Easing } from 'framer-motion';
import { isPptxMode } from './pptxMode';

type Effect = 'fade-up' | 'fade-down' | 'scale';

interface StaggerProps {
  interval?: number;
  effect?: Effect;
  duration?: number;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const EFFECTS: Record<Effect, { initial: TargetAndTransition; animate: TargetAndTransition }> = {
  'fade-up':   { initial: { opacity: 0, y: 30 },       animate: { opacity: 1, y: 0 } },
  'fade-down': { initial: { opacity: 0, y: -30 },      animate: { opacity: 1, y: 0 } },
  'scale':     { initial: { opacity: 0, scale: 0.85 },  animate: { opacity: 1, scale: 1 } },
};

export function Stagger({
  interval = 0.15,
  effect = 'fade-up',
  duration = 0.7,
  style,
  className = '',
  children,
}: StaggerProps) {
  const pptx = isPptxMode();
  const { initial, animate } = EFFECTS[effect] ?? EFFECTS['fade-up'];

  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'clamp(0.4rem, 1.2cqb, 1.2rem)',
    ...style,
  };

  if (pptx) {
    return <div className={className} style={wrapStyle} data-pptx-type="passthrough">{children}</div>;
  }

  return (
    <div className={className} style={wrapStyle} data-pptx-type="passthrough">
      {Children.map(children, (child, i) => (
        <motion.div
          key={i}
          initial={initial}
          whileInView={animate}
          viewport={{ once: true }}
          transition={{ duration, delay: interval * i, ease: EASE as Easing }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}
