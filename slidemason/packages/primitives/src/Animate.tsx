import { motion, type TargetAndTransition, type Easing } from 'framer-motion';
import { isPptxMode } from './pptxMode';

type Effect =
  | 'fade-up'
  | 'fade-down'
  | 'fade-left'
  | 'fade-right'
  | 'scale'
  | 'blur-in'
  | 'slide-left'
  | 'slide-right';

interface AnimateProps {
  effect?: Effect;
  delay?: number;
  duration?: number;
  ease?: readonly number[];
  once?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const EFFECTS: Record<Effect, { initial: TargetAndTransition; animate: TargetAndTransition }> = {
  'fade-up':     { initial: { opacity: 0, y: 30 },              animate: { opacity: 1, y: 0 } },
  'fade-down':   { initial: { opacity: 0, y: -30 },             animate: { opacity: 1, y: 0 } },
  'fade-left':   { initial: { opacity: 0, x: 40 },              animate: { opacity: 1, x: 0 } },
  'fade-right':  { initial: { opacity: 0, x: -40 },             animate: { opacity: 1, x: 0 } },
  'scale':       { initial: { opacity: 0, scale: 0.85 },        animate: { opacity: 1, scale: 1 } },
  'blur-in':     { initial: { opacity: 0, filter: 'blur(10px)' }, animate: { opacity: 1, filter: 'blur(0px)' } },
  'slide-left':  { initial: { x: '100%', opacity: 0 },          animate: { x: 0, opacity: 1 } },
  'slide-right': { initial: { x: '-100%', opacity: 0 },         animate: { x: 0, opacity: 1 } },
};

export function Animate({
  effect = 'fade-up',
  delay = 0,
  duration = 0.7,
  ease = EASE,
  once = true,
  style,
  className = '',
  children,
}: AnimateProps) {
  const pptx = isPptxMode();
  const { initial, animate } = EFFECTS[effect] ?? EFFECTS['fade-up'];
  const transition = { duration, delay, ease: ease as Easing };

  if (pptx) {
    return <div className={className} style={style} data-pptx-type="passthrough">{children}</div>;
  }

  if (once) {
    return (
      <motion.div
        className={className}
        style={style}
        initial={initial}
        whileInView={animate}
        viewport={{ once: true }}
        transition={transition}
        data-pptx-type="passthrough"
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      style={style}
      initial={initial}
      animate={animate}
      transition={transition}
      data-pptx-type="passthrough"
    >
      {children}
    </motion.div>
  );
}
