import type { ITheme } from '@xterm/xterm'

export type { ITheme }

/**
 * Terminal color remap.
 *
 * A program emitting raw ANSI codes would otherwise paint with the browser's
 * default terminal colors, which have nothing to do with the Daedalus palette.
 * The reference terminal agent solves this with a 16-entry ANSI palette in its
 * token set; this reads the same 16 palette entries out of the cascade
 * `applyPaletteVars` writes, so the remap follows the active theme instead of
 * importing a second copy of it.
 */

/** xterm slot -> palette key, in the palette's own normal-then-bright order. */
const ANSI_SLOTS = [
  ['black', 'ansiBlack'],
  ['red', 'ansiRed'],
  ['green', 'ansiGreen'],
  ['yellow', 'ansiYellow'],
  ['blue', 'ansiBlue'],
  ['magenta', 'ansiMagenta'],
  ['cyan', 'ansiCyan'],
  ['white', 'ansiWhite'],
  ['brightBlack', 'ansiBrightBlack'],
  ['brightRed', 'ansiBrightRed'],
  ['brightGreen', 'ansiBrightGreen'],
  ['brightYellow', 'ansiBrightYellow'],
  ['brightBlue', 'ansiBrightBlue'],
  ['brightMagenta', 'ansiBrightMagenta'],
  ['brightCyan', 'ansiBrightCyan'],
  ['brightWhite', 'ansiBrightWhite'],
] as const satisfies ReadonlyArray<readonly [keyof ITheme, string]>

function token(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : undefined
}

export function terminalTheme(): ITheme {
  // xterm paints the viewport from this value. Leaving it transparent lets the
  // element behind it show through, which in practice is xterm's own black
  // default — a terminal that ignores the palette in the one place the palette
  // is most visible.
  const theme: ITheme = {
    background: token('--daedalus-bgBase'),
    foreground: token('--daedalus-fgBase'),
    cursor: token('--daedalus-accent'),
    cursorAccent: token('--daedalus-bgBase'),
    selectionBackground: token('--daedalus-planSubtle'),
  }

  for (const [slot, key] of ANSI_SLOTS) {
    const value = token(`--daedalus-${key}`)
    if (value) theme[slot] = value
  }

  return theme
}