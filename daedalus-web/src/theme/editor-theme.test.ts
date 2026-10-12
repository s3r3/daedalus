import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPalette } from '@daedalus/core/palette'
import { EDITOR_THEME_NAMES, editorTheme } from './editor-theme'

const SRC = join(process.cwd(), 'src')

type Mode = 'dark' | 'light'

/**
 * Phase 8 required the editor surface to be verifiable rather than assumed.
 * Monaco's bundled themes cannot be inspected after the fact, so the assertions
 * here run against the theme object the app actually hands to `defineTheme`.
 */
describe('editor surface theme', () => {
  test('every highlighted token resolves to a palette role, both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const theme = editorTheme(mode as Mode)
      expect(theme.rules.length).toBeGreaterThan(30)

      const palette = getPalette(mode) as Record<string, string>
      const allowed = new Set(
        Object.entries(palette)
          .filter(([key]) => key.startsWith('syntax'))
          .map(([, hex]) => hex.replace('#', '').toLowerCase()),
      )
      // Every foreground must be a palette value, not a foreign color.
      for (const rule of theme.rules) expect(allowed.has(String(rule.foreground).toLowerCase())).toBe(true)
    }
  })

  test('the surface paints on palette colors, not a bundled editor theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = getPalette(mode as Mode) as Record<string, string>
      const theme = editorTheme(mode as Mode)

      expect(theme.base).toBe(mode === 'dark' ? 'vs-dark' : 'vs')
      expect(theme.inherit).toBe(false)
      expect(theme.colors?.['editor.background']).toBe(palette.bgBase)
      expect(theme.colors?.['editor.foreground']).toBe(palette.fgBase)
      expect(theme.colors?.['editorCursor.foreground']).toBe(palette.accent)
      expect(theme.colors?.['editorError.foreground']).toBe(palette.error)
    }
  })

  test('the class and tag tokens are emphasized the way the reference emphasizes them', () => {
    const theme = editorTheme('dark')
    for (const token of ['class', 'tag']) {
      const rule = theme.rules.find((r) => r.token === token)
      expect(rule?.fontStyle).toBe('bold')
    }
  })

  test('a theme switch is selected by name, never hardcoded at the call site', () => {
    expect(EDITOR_THEME_NAMES).toEqual({ dark: 'daedalus-dark', light: 'daedalus-light' })
    const source = readFileSync(join(SRC, 'components/editor/monaco-editor.tsx'), 'utf8')
    expect(source).not.toMatch(/theme:\s*'vs/)
    expect(source).not.toMatch(/theme:\s*'vs-dark'/)
    expect(source).toContain('applyEditorTheme(monaco, mode)')
  })
})
