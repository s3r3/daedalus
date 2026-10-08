import { useRef, useEffect, useState } from 'react';
import { useInView } from 'framer-motion';
import { isPptxMode } from './pptxMode';

interface TypeWriterProps {
  text: string;
  speed?: number;
  delay?: number;
  cursor?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

const blinkKeyframes = `
@keyframes blink {
  50% { opacity: 0 }
}
`;

let styleInjected = false;

function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  const tag = document.createElement('style');
  tag.textContent = blinkKeyframes;
  document.head.appendChild(tag);
  styleInjected = true;
}

export function TypeWriter({
  text: rawText,
  speed = 40,
  delay = 0,
  cursor = true,
  style,
  className = '',
}: TypeWriterProps) {
  const text = String(rawText ?? '');
  const pptx = isPptxMode();
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [charIndex, setCharIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (cursor) injectStyle();
  }, [cursor]);

  useEffect(() => {
    if (!isInView) return;

    const timeout = setTimeout(() => setStarted(true), delay * 1000);
    return () => clearTimeout(timeout);
  }, [isInView, delay]);

  useEffect(() => {
    if (!started) return;

    const interval = setInterval(() => {
      setCharIndex((prev) => {
        const next = prev + 1;
        if (next >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
        return next;
      });
    }, speed);

    return () => clearInterval(interval);
  }, [started, text, speed]);

  if (pptx) {
    return <span className={className} style={style} data-pptx-type="text" data-pptx-typewriter-final={text}>{text}</span>;
  }

  const showCursor = cursor && started && !done;

  return (
    <span
      ref={ref}
      className={className}
      style={style}
      data-pptx-type="text"
      data-pptx-typewriter-final={text}
    >
      {text.slice(0, charIndex)}
      {showCursor && (
        <span
          style={{
            animation: 'blink 0.7s step-end infinite',
            fontWeight: 'inherit',
          }}
        >
          |
        </span>
      )}
    </span>
  );
}
