/**
 * The Daedalus palette.
 *
 * Kept free of any runtime or platform import so both interfaces can load it:
 * the CLI reads it directly, the browser mirrors it onto CSS custom properties.
 * Everything else in the core touches `node:fs` and cannot cross into a client
 * bundle, so this module is deliberately standalone rather than part of the
 * package barrel.
 *
 */

export const palette = {
  // Brand
  primary: '#6b50ff',   // charmtone.charple
  secondary: '#ff60ff', // charmtone.dolly
  accent: '#68ffd6',    // charmtone.bok
  keyword: '#ff84ff',   // charmtone.blush

  // Foreground hierarchy, brightest to most recessed. Quiet supporting text
  // uses fgMoreSubtle; there is no separate `muted` role.
  fgBase: '#ecebf0',       // charmtone.sash
  fgSubtle: '#bfbcc8',     // charmtone.smoke
  fgMoreSubtle: '#858392', // charmtone.squid
  fgMostSubtle: '#605f6b', // charmtone.oyster

  // Surface hierarchy, least to most raised
  bgBase: '#201f26',    // charmtone.pepper
  bgSurface: '#2d2c36', // charmtone.bbq  (least visible)
  bgRaised: '#3a3943',  // charmtone.char  (less visible)
  bgOverlay: '#4d4c57', // charmtone.iron  (most visible)

  // Interactive
  onPrimary: '#fffaf1', // charmtone.butter
  separator: '#3a3943', // charmtone.char

  // Status: full strength first, muted second
  destructive: '#ff577d', // charmtone.coral
  error: '#eb4268',       // charmtone.sriracha
  warning: '#f5ef34',     // charmtone.mustard
  warningMuted: '#e8fe96', // charmtone.zest
  attention: '#ff985a',   // charmtone.tang
  busy: '#e8ff27',       // charmtone.citron
  info: '#00a4ff',       // charmtone.malibu
  infoMuted: '#4fbefe',  // charmtone.sardine
  infoMostSubtle: '#007ab8', // charmtone.damson
  success: '#00ffb2',    // charmtone.julep
  successMuted: '#68ffd6', // charmtone.bok
  successMostSubtle: '#12c78f', // charmtone.guac

  // Diff: foregrounds are muted inks, backgrounds are those inks over bgBase
  diffInsertFg: '#629657',
  diffInsertCodeBg: '#2d3430',
  diffInsertGutterBg: '#282d2c',
  diffDeleteFg: '#a45c59',
  diffDeleteCodeBg: '#33272d',
  diffDeleteGutterBg: '#2a232a',

  // Mode accents
  yolo: '#e8fe96',    // charmtone.zest
  plan: '#6b50ff',   // charmtone.charple
  planSubtle: '#8b75ff', // charmtone.hazy

  // Button fills; foregrounds come from onPrimary / fgBase
  button: '#ff60ff',        // charmtone.dolly
  buttonSubtle: '#3a3943',  // charmtone.char
  buttonInactive: '#4d4c57', // charmtone.iron
  buttonHovered: '#605f6b', // charmtone.oyster

  // Working animation
  workingFrom: '#6b50ff', // charmtone.charple
  workingTo: '#68ffd6',   // charmtone.bok

  // Syntax. The reference maps every highlighter token onto a palette role, so
  // code reads as part of the same system instead of borrowing a foreign one.
  syntaxText: '#bfbcc8',          // charmtone.smoke
  syntaxComment: '#605f6b',       // charmtone.oyster
  syntaxCommentPreproc: '#ff6e63', // charmtone.bengal
  syntaxKeyword: '#00a4ff',       // charmtone.malibu
  syntaxKeywordReserved: '#ff4fbf', // charmtone.pony
  syntaxKeywordType: '#7272ff',   // charmtone.guppy
  syntaxOperator: '#ff7f90',      // charmtone.salmon
  syntaxPunctuation: '#e8fe96',   // charmtone.zest
  syntaxName: '#bfbcc8',          // charmtone.smoke
  syntaxNameBuiltin: '#68ffd6',   // charmtone.bok
  syntaxNameTag: '#d46eff',       // charmtone.mauve
  syntaxNameAttribute: '#8b75ff', // charmtone.hazy
  syntaxNameClass: '#f7f6fb',     // charmtone.salt
  syntaxNameDecorator: '#ff985a', // charmtone.tang
  syntaxNameFunction: '#12c78f',  // charmtone.guac
  syntaxNumber: '#00ffb2',        // charmtone.julep
  syntaxString: '#bf976f',        // charmtone.cumin
  syntaxStringEscape: '#68ffd6',  // charmtone.bok
  syntaxDeleted: '#ff577d',       // charmtone.coral
  syntaxInserted: '#12c78f',      // charmtone.guac
  syntaxBackground: '#3a3943',    // charmtone.char

  // ANSI 16, normal then bright: remaps raw terminal colors onto the palette
  ansiBlack: '#2d2c36',
  ansiRed: '#ff577d',
  ansiGreen: '#12c78f',
  ansiYellow: '#f5ef34',
  ansiBlue: '#6b50ff',
  ansiMagenta: '#ff60ff',
  ansiCyan: '#00a4ff',
  ansiWhite: '#bfbcc8',
  ansiBrightBlack: '#4d4c57',
  ansiBrightRed: '#ff6daa', // charmtone.tuna
  ansiBrightGreen: '#00ffb2',
  ansiBrightYellow: '#e8fe96',
  ansiBrightBlue: '#7272ff', // charmtone.guppy
  ansiBrightMagenta: '#ff84ff',
  ansiBrightCyan: '#4fbefe',
  ansiBrightWhite: '#f7f6fb', // charmtone.salt
} as const;

/**
 * Light counterpart. The reference terminal agent ships no light theme, so this
 * keeps the same semantic layering on light neutral ramps and maps each extra
 * role onto a hue that already exists in this theme rather than inventing one.
 */
export const paletteLight = {
  primary: '#5b40ec',
  secondary: '#d633d6',
  accent: '#0f9b7d',
  keyword: '#e879b0',

  fgBase: '#201f26',
  fgSubtle: '#4d4c57',
  fgMoreSubtle: '#6b6a75',
  fgMostSubtle: '#a2a0ad',

  bgBase: '#fbfbfb',
  bgSurface: '#f2f1f5',
  bgRaised: '#e8e7ec',
  bgOverlay: '#d6d3dc',

  onPrimary: '#fffaf1',
  separator: '#d6d3dc',

  destructive: '#a45c59',
  error: '#c21e46',
  warning: '#8a7a00',
  warningMuted: '#a39600',
  attention: '#a39600',
  busy: '#a39600',
  info: '#0070b8',
  infoMuted: '#005a94',
  infoMostSubtle: '#005a94',
  success: '#0f9b7d',
  successMuted: '#0a7a63',
  successMostSubtle: '#0a7a63',

  diffInsertFg: '#0a7a63',
  diffInsertCodeBg: '#d0e1db',
  diffInsertGutterBg: '#dfeae6',
  diffDeleteFg: '#a45c59',
  diffDeleteCodeBg: '#ecdad9',
  diffDeleteGutterBg: '#f2e6e5',

  yolo: '#8a7a00',
  plan: '#5b40ec',
  planSubtle: '#6b6a75',

  button: '#d633d6',
  buttonSubtle: '#e8e7ec',
  buttonInactive: '#d6d3dc',
  buttonHovered: '#6b6a75',

  workingFrom: '#0f9b7d',
  workingTo: '#00a4ff',

  syntaxText: '#4d4c57',
  syntaxComment: '#a2a0ad',
  syntaxCommentPreproc: '#c21e46',
  syntaxKeyword: '#0070b8',
  syntaxKeywordReserved: '#e879b0',
  syntaxKeywordType: '#005a94',
  syntaxOperator: '#4d4c57',
  syntaxPunctuation: '#a39600',
  syntaxName: '#4d4c57',
  syntaxNameBuiltin: '#0f9b7d',
  syntaxNameTag: '#d633d6',
  syntaxNameAttribute: '#6b6a75',
  syntaxNameClass: '#5b40ec',
  syntaxNameDecorator: '#a39600',
  syntaxNameFunction: '#0a7a63',
  syntaxNumber: '#0a7a63',
  syntaxString: '#8a7a00',
  syntaxStringEscape: '#0f9b7d',
  syntaxDeleted: '#a45c59',
  syntaxInserted: '#0a7a63',
  syntaxBackground: '#e8e7ec',

  ansiBlack: '#201f26',
  ansiRed: '#c21e46',
  ansiGreen: '#0a7a63',
  ansiYellow: '#8a7a00',
  ansiBlue: '#0070b8',
  ansiMagenta: '#d633d6',
  ansiCyan: '#0f9b7d',
  ansiWhite: '#4d4c57',
  ansiBrightBlack: '#6b6a75',
  ansiBrightRed: '#c21e46',
  ansiBrightGreen: '#0f9b7d',
  ansiBrightYellow: '#a39600',
  ansiBrightBlue: '#005a94',
  ansiBrightMagenta: '#e879b0',
  ansiBrightCyan: '#0a7a63',
  ansiBrightWhite: '#201f26',
} as const;

export type PaletteName = 'dark' | 'light';

export function getPalette(name: PaletteName): typeof palette | typeof paletteLight {
  return name === 'light' ? paletteLight : palette
}

const ANSI_KEYS = [
  'ansiBlack', 'ansiRed', 'ansiGreen', 'ansiYellow',
  'ansiBlue', 'ansiMagenta', 'ansiCyan', 'ansiWhite',
  'ansiBrightBlack', 'ansiBrightRed', 'ansiBrightGreen', 'ansiBrightYellow',
  'ansiBrightBlue', 'ansiBrightMagenta', 'ansiBrightCyan', 'ansiBrightWhite',
] as const

/** The 16 ANSI slots in terminal order (0-7 normal, 8-15 bright). */
export function ansiPalette(name: PaletteName): string[] {
  const p = getPalette(name)
  return ANSI_KEYS.map((key) => p[key])
}
