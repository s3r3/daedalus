import { useEffect, useState } from 'react'
import { SPINNER_FRAMES, SPINNER_FRAME_INTERVAL_MS } from '../../theme/motion-tokens'
import { usePrefersReducedMotion } from '../../theme/theme'

/**
 * The one spinner in the app (PLAN.md §3.4 rule 4): the same glyph cycle
 * everywhere, driven by agent status rather than by ad-hoc loading flags.
 *
 * The glyph wears the working gradient, which is what the reference paints on
 * whatever is in flight. Under reduced motion the animation stops and the
 * gradient still reads, so the indicator never loses its color.
 */
export function Spinner({ label = 'working', className = '' }: { label?: string; className?: string }) {
  const [index, setIndex] = useState(0)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    if (reducedMotion) return
    const id = setInterval(() => setIndex((frame) => (frame + 1) % SPINNER_FRAMES.length), SPINNER_FRAME_INTERVAL_MS)
    return () => clearInterval(id)
  }, [reducedMotion])

  return (
    <span role="status" aria-label={label} className={`motion-working-grad ${className}`}>
      <span aria-hidden>{SPINNER_FRAMES[index]}</span>
    </span>
  )
}