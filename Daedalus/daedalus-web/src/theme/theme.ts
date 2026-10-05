import { getPalette, type PaletteName } from '@daedalus/core/palette'
import type { AgentMode } from '@daedalus/core'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useDaedalusStore } from '../state/taskStore'

export type ThemeName = 'daedalus-dark' | 'daedalus-light'

const STORAGE_KEY = 'daedalus.theme'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Mirror the shared core palette (core/src/palette.ts) onto --daedalus-* custom
 * properties so index.css tokens resolve from one source of truth. The hex
 * literals in index.css remain only as var() fallbacks, and a test asserts they
 * match the palette, so the first paint and the steady state agree.
 *
 * The import is the `@daedalus/core/palette` subpath, not the package barrel:
 * the barrel reaches node:fs, which cannot run in a client bundle.
 */
export function applyPaletteVars(theme: PaletteName): void {
  const root = document.documentElement
  for (const [key, hex] of Object.entries(getPalette(theme))) {
    root.style.setProperty(`--daedalus-${key}`, hex)
  }
}

const MODE_VAR_KEYS: Record<AgentMode, string> = {
  ask: 'modeAsk',
  manual: 'modeManual',
  auto: 'modeAuto',
  plan: 'modePlan',
  orchestrator: 'modeOrchestrator',
}

/** CSS variable for a mode accent; the value itself always comes from core. */
export function modeCssVar(mode: AgentMode): string {
  return `var(--daedalus-${MODE_VAR_KEYS[mode]})`
}

export const MODE_LABELS: Record<AgentMode, string> = {
  ask: 'Ask',
  manual: 'Manual',
  auto: 'Auto',
  plan: 'Plan',
  orchestrator: 'Orchestrator',
}

/** Applies the §3.4 token set to <html data-theme>; components never style colors. */
export function useTheme(): { theme: ThemeName; toggle: () => void } {
  const theme = useDaedalusStore((state) => state.theme)
  const setTheme = useDaedalusStore((state) => state.setTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    applyPaletteVars(theme === 'daedalus-light' ? 'light' : 'dark')
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* storage unavailable (private mode) — the theme still applies for this session */
    }
  }, [theme])

  const toggle = useCallback(() => setTheme(theme === 'daedalus-dark' ? 'daedalus-light' : 'daedalus-dark'), [setTheme, theme])
  return { theme, toggle }
}

export function readStoredTheme(): ThemeName {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'daedalus-dark' || stored === 'daedalus-light') return stored
  } catch {
    /* ignore */
  }
  return 'daedalus-dark'
}

/** True when the user asked the OS to reduce motion (§3.4 rule 1). */
export function usePrefersReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const snapshot = useCallback(() => window.matchMedia(REDUCED_MOTION_QUERY).matches, [])
  return useSyncExternalStore(subscribe, snapshot, () => false)
}