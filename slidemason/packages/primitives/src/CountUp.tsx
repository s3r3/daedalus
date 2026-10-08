import { useRef, useEffect, useState } from 'react';
import { useInView } from 'framer-motion';
import { isPptxMode } from './pptxMode';

interface CountUpProps {
  to: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  decimals?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function CountUp({
  to,
  from = 0,
  prefix = '',
  suffix = '',
  duration = 2,
  decimals: rawDecimals = 0,
  style,
  className = '',
}: CountUpProps) {
  const decimals = Math.max(0, Math.min(Math.floor(rawDecimals), 20));
  const pptx = isPptxMode();
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [display, setDisplay] = useState(from.toFixed(decimals));

  useEffect(() => {
    if (!isInView) return;

    const startTime = performance.now();
    const durationMs = duration * 1000;
    let raf: number;

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (to - from) * eased;
      setDisplay(value.toFixed(decimals));

      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isInView, from, to, duration, decimals]);

  if (pptx) {
    return (
      <span className={className} style={style} data-pptx-type="text" data-pptx-countup-final={`${prefix}${to.toFixed(decimals)}${suffix}`}>
        {prefix}{to.toFixed(decimals)}{suffix}
      </span>
    );
  }

  return (
    <span
      ref={ref}
      className={className}
      style={style}
      data-pptx-type="text"
      data-pptx-countup-final={`${prefix}${to.toFixed(decimals)}${suffix}`}
    >
      {prefix}{display}{suffix}
    </span>
  );
}
