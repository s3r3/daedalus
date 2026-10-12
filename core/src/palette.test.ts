import { describe, expect, test } from 'vitest'
import { ansiPalette, getPalette, palette, paletteLight, type PaletteName } from './palette.ts'

/** Relative luminance, used only to assert that each ramp stays ordered. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The palette is the one place both interfaces read color from, so its values
 * are pinned here rather than trusted. These are CharmTone Pantera hexes as
 * published by `charmbracelet/x/exp/charmtone v0.1.0` — the release the
 * reference terminal agent pins — and the Gruvbox Dark values declared in its
 * theme. A drift guard in the web suite asserts the CSS mirror agrees; this
 * suite is what makes a wrong hex fail here first.
 */
const CHARMTONE = {
  primary: '#6b50ff', // charple
  secondary: '#ff60ff', // dolly
  accent: '#68ffd6', // bok
  keyword: '#ff84ff', // blush

  fgBase: '#ecebf0', // sash
  fgSubtle: '#bfbcc8', // smoke
  fgMoreSubtle: '#858392', // squid
  fgMostSubtle: '#605f6b', // oyster
  onPrimary: '#fffaf1', // butter

  bgBase: '#201f26', // pepper
  bgSurface: '#2d2c36', // bbq
  bgRaised: '#3a3943', // char
  bgOverlay: '#4d4c57', // iron

  separator: '#3a3943',

  destructive: '#ff577d', // coral
  error: '#eb4268', // sriracha
  warning: '#f5ef34', // mustard
  warningMuted: '#e8fe96', // zest
  attention: '#ff985a', // tang
  busy: '#e8ff27', // citron
  info: '#00a4ff', // malibu
  infoMuted: '#4fbefe', // sardine
  infoMostSubtle: '#007ab8', // damson
  success: '#00ffb2', // julep
  successMuted: '#68ffd6', // bok
  successMostSubtle: '#12c78f', // guac

  yolo: '#e8fe96',
  plan: '#6b50ff',
  planSubtle: '#8b75ff', // hazy

  workingFrom: '#6b50ff',
  workingTo: '#68ffd6',

  ansiBlack: '#2d2c36',
  ansiRed: '#ff577d',
  ansiGreen: '#12c78f',
  ansiYellow: '#f5ef34',
  ansiBlue: '#6b50ff',
  ansiMagenta: '#ff60ff',
  ansiCyan: '#00a4ff',
  ansiWhite: '#bfbcc8',
  ansiBrightBlack: '#4d4c57',
  ansiBrightRed: '#ff6daa', // tuna
  ansiBrightGreen: '#00ffb2',
  ansiBrightYellow: '#e8fe96',
  ansiBrightBlue: '#7272ff', // guppy
  ansiBrightMagenta: '#ff84ff',
  ansiBrightCyan: '#4fbefe',
  ansiBrightWhite: '#f7f6fb', // salt
} as const


describe('CharmTone Pantera palette', () => {
  test('every named CharmTone token carries its published hex', () => {
    for (const [key, hex] of Object.entries(CHARMTONE)) {
      expect(palette[key as keyof typeof CHARMTONE], key).toBe(hex)
    }
  })

  test('diff inks are the muted hues the reference theme declares', () => {
    expect(palette.diffInsertFg).toBe('#629657')
    expect(palette.diffDeleteFg).toBe('#a45c59')
  })

  /**
   * Diff backgrounds are derived, not chosen: the ink blended over bgBase at
   * the reference's ratios (0.20 code / 0.13 gutter for insert, 0.15 / 0.08 for
   * delete) in CIELAB. The values below are that computation.
   */
  test('diff backgrounds are the derived tints', () => {
    expect(palette.diffInsertCodeBg).toBe('#2d3430')
    expect(palette.diffInsertGutterBg).toBe('#282d2c')
    expect(palette.diffDeleteCodeBg).toBe('#33272d')
    expect(palette.diffDeleteGutterBg).toBe('#2a232a')
  })

  test('button fills reuse the palette roles the reference maps them to', () => {
    expect(palette.button).toBe(palette.secondary)
    expect(palette.buttonSubtle).toBe(palette.bgRaised)
    expect(palette.buttonInactive).toBe(palette.bgOverlay)
    expect(palette.buttonHovered).toBe(palette.fgMostSubtle)
  })
})

describe('light palette', () => {
  test('keeps the same token shape as the dark palette', () => {
    expect(Object.keys(paletteLight).sort()).toEqual(Object.keys(palette).sort())
  })

  test('keeps light neutral ramps ordered from surface to overlay', () => {
    const ramp = [paletteLight.bgBase, paletteLight.bgSurface, paletteLight.bgRaised, paletteLight.bgOverlay]
    for (let i = 0; i + 1 < ramp.length; i++) {
      const lower = ramp[i] as string
      const higher = ramp[i + 1] as string
      expect(luminance(higher), `${lower} -> ${higher}`).toBeLessThan(luminance(lower))
    }
  })

  test('keeps the foreground ramp readable on the light base', () => {
    // On a light theme the base text is dark against a light surface, and the
    // ramp recedes by getting lighter toward the least important text.
    expect(luminance(paletteLight.fgBase)).toBeLessThan(luminance(paletteLight.bgBase))
    const ramp = [paletteLight.fgBase, paletteLight.fgSubtle, paletteLight.fgMoreSubtle, paletteLight.fgMostSubtle]
    for (let i = 0; i + 1 < ramp.length; i++) {
      const lower = ramp[i] as string
      const higher = ramp[i + 1] as string
      expect(luminance(higher), `${lower} -> ${higher}`).toBeGreaterThan(luminance(lower))
    }
  })
})

describe('dark palette ramps', () => {
  test('keeps the foreground ramp readable on the dark base', () => {
    expect(luminance(palette.fgBase)).toBeGreaterThan(luminance(palette.bgBase))
    const ramp = [palette.fgBase, palette.fgSubtle, palette.fgMoreSubtle, palette.fgMostSubtle]
    for (let i = 0; i + 1 < ramp.length; i++) {
      const stronger = ramp[i] as string
      const recessed = ramp[i + 1] as string
      expect(luminance(recessed), `${stronger} -> ${recessed}`).toBeLessThan(luminance(stronger))
    }
  })
})

describe('palette lookup', () => {
  test('both names resolve to a full token set', () => {
    for (const name of ['dark', 'light'] as PaletteName[]) {
      const p = getPalette(name) as Record<string, string>
      expect(Object.keys(p).length).toBe(Object.keys(palette).length)
      for (const [key, value] of Object.entries(p)) {
        expect(value, `${name}.${key}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  test('the ANSI remap is 16 slots in terminal order', () => {
    const ansi = ansiPalette('dark')
    expect(ansi).toHaveLength(16)
    expect(ansi[0]).toBe(palette.ansiBlack)
    expect(ansi[7]).toBe(palette.ansiWhite)
    expect(ansi[8]).toBe(palette.ansiBrightBlack)
    expect(ansi[15]).toBe(palette.ansiBrightWhite)
    expect(ansi.every((hex) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true)
  })
})