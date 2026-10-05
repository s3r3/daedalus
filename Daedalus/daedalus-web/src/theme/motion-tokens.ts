/**
 * The one spinner glyph cycle (PLAN.md §3.4 rule 4). Kept out of the component
 * file so the frames are a design token, not an implementation detail of the
 * renderer: every consumer, and the test that guards it, reads them from here.
 *
 * Cadence matches the reference terminal agent: 20fps, 50ms per frame.
 */
export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export const SPINNER_FRAME_INTERVAL_MS = 50

/** Motion timing budget (PLAN.md §3.4 rule 3). */
export const TIMING = {
  micro: 100,
  standard: 200,
  max: 400,
} as const