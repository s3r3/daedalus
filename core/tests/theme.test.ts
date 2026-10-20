import { describe, expect, test } from 'vitest'
import { fg, getPalette, palette, paletteLight, rgb } from '../src/theme.ts'

describe('theme', () => {
  test('dark primary is the brand hex from index.css', () => {
    expect(palette.primary).toBe('#6b50ff')
    expect(getPalette('dark').primary).toBe('#6b50ff')
  })

  test('light primary is the light-theme brand hex', () => {
    expect(paletteLight.primary).toBe('#5b40ec')
    expect(getPalette('light').primary).toBe('#5b40ec')
  })

  test('rgb parses #rrggbb into [r, g, b]', () => {
    expect(rgb('#6b50ff')).toEqual([107, 80, 255])
    expect(rgb('#00ffb2')).toEqual([0, 255, 178])
  })

  test('fg is empty when NO_COLOR is set', () => {
    const orig = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      expect(fg('#6b50ff')).toBe('')
    } finally {
      if (orig === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = orig
    }
  })
})