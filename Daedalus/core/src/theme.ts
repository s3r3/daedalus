/**
 * Terminal color helpers shared by every Daedalus CLI.
 *
 * The palette itself lives in `palette.ts`, which both interfaces load; this
 * module adds the ANSI helpers that only make sense on a terminal.
 */

import { palette } from "./palette.ts";

export {
  ansiPalette,
  getPalette,
  palette,
  paletteLight,
  type PaletteName,
} from "./palette.ts";

/** Parse a `#rrggbb` hex string into its `[r, g, b]` components. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** True only when NO_COLOR is unset AND (FORCE_COLOR set OR stdout is a TTY). */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}

/** Wrap `s` in a 24-bit foreground ANSI sequence; `''` when color is disabled. */
export function fg(hex: string): string {
  if (!supportsColor()) return '';
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Wrap `s` in bold. When color is disabled the text is returned UNSTYLED —
 * never empty, so the label itself always survives.
 */
export function bold(s: string): string {
  if (!supportsColor()) return s;
  return `\x1b[1m${s}\x1b[0m`;
}

/**
 * Wrap `s` in dim. When color is disabled the text is returned UNSTYLED —
 * never empty, so the label itself always survives.
 */
export function dim(s: string): string {
  if (!supportsColor()) return s;
  return `\x1b[2m${s}\x1b[0m`;
}

/**
 * Wrap `s` in a gradient (foreground cycling).
 * Simulates Crush's working gradient animation in CLI.
 */
export function gradient(s: string, from: string = palette.workingFrom, to: string = palette.workingTo): string {
  if (!supportsColor()) return s;
  const [r1, g1, b1] = rgb(from);
  const [r2, g2, b2] = rgb(to);
  
  let result = '';
  const chars = s.split('');
  chars.forEach((char, i) => {
    const t = i / Math.max(chars.length - 1, 1);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    result += `\x1b[38;2;${r};${g};${b}m${char}`;
  });
  return result + '\x1b[0m';
}