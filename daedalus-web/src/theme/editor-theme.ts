/**
 * Editor surface theme.
 *
 * Monaco ships its own light and dark themes that share nothing with the
 * Daedalus palette, so an open file would read as a foreign app pasted into
 * the workspace. This maps the highlighter's token names onto palette roles,
 * following the reference terminal agent's rule that every highlighted token
 * resolves to a palette role rather than a hardcoded color.
 *
 * Tokens are read from `--daedalus-<key>`, which `applyPaletteVars` writes on
 * <html> from the shared core palette. Reading the variable rather than
 * importing the palette keeps one source of truth for both interfaces and lets
 * the editor follow a theme switch with no second copy to keep in step.
 */
import type * as Monaco from 'monaco-editor'
import { getPalette, type PaletteName } from '@daedalus/core/palette'

/**
 * Resolved from the shared palette rather than read back from the cascade. The
 * theme effect in <App> writes `--daedalus-*` after its children run their
 * effects, so an editor that read the variables would always paint the previous
 * theme's colors for one frame — and keep them if nothing re-rendered it.
 */
const ACTIVE = new Map<PaletteName, Record<string, string>>()

function paletteFor(mode: PaletteName): Record<string, string> {
  const cached = ACTIVE.get(mode)
  if (cached) return cached
  const resolved = getPalette(mode) as Record<string, string>
  ACTIVE.set(mode, resolved)
  return resolved
}

/** Monaco token name -> palette syntax role. */
const TOKEN_COLORS: Array<[string, string]> = [
  ['comment', 'syntaxComment'],
  ['comment.line', 'syntaxComment'],
  ['comment.block', 'syntaxComment'],
  ['comment.doc', 'syntaxComment'],
  ['preprocessor', 'syntaxCommentPreproc'],
  ['keyword', 'syntaxKeyword'],
  ['keyword.other', 'syntaxKeyword'],
  ['keyword.control', 'syntaxKeywordReserved'],
  ['keyword.operator', 'syntaxOperator'],
  ['keyword.declaration', 'syntaxKeywordType'],
  ['storage', 'syntaxKeywordReserved'],
  ['storage.type', 'syntaxKeywordType'],
  ['type', 'syntaxKeywordType'],
  ['type.identifier', 'syntaxKeywordType'],
  ['namespace', 'syntaxKeyword'],
  ['operator', 'syntaxOperator'],
  ['punctuation', 'syntaxPunctuation'],
  ['punctuation.separator', 'syntaxPunctuation'],
  ['identifier', 'syntaxName'],
  ['identifier.other', 'syntaxName'],
  ['variable', 'syntaxName'],
  ['variable.other', 'syntaxName'],
  ['variable.parameter', 'syntaxNameAttribute'],
  ['variable.parameter.function', 'syntaxNameBuiltin'],
  ['variable.language', 'syntaxKeywordReserved'],
  ['attribute', 'syntaxNameAttribute'],
  ['attribute.name', 'syntaxNameAttribute'],
  ['tag', 'syntaxNameTag'],
  ['metatag', 'syntaxNameTag'],
  ['decorator', 'syntaxNameDecorator'],
  ['annotation', 'syntaxNameDecorator'],
  ['annotation.type', 'syntaxNameDecorator'],
  ['function', 'syntaxNameFunction'],
  ['function.method', 'syntaxNameFunction'],
  ['function.magic', 'syntaxNameBuiltin'],
  ['class', 'syntaxNameClass'],
  ['struct', 'syntaxNameClass'],
  ['enum', 'syntaxNameClass'],
  ['interface', 'syntaxNameClass'],
  ['type.identifier.class', 'syntaxNameClass'],
  ['number', 'syntaxNumber'],
  ['number.hex', 'syntaxNumber'],
  ['constant', 'syntaxKeywordReserved'],
  ['string', 'syntaxString'],
  ['string.quoted', 'syntaxString'],
  ['string.template', 'syntaxString'],
  ['string.escape', 'syntaxStringEscape'],
  ['string.invalid', 'syntaxDeleted'],
  ['regexp', 'syntaxStringEscape'],
  ['key', 'syntaxNameTag'],
  ['invalid', 'syntaxDeleted'],
]

/** Roles the reference sets in bold, matching its highlight weight. */
const EMPHASIZED = new Set(['syntaxNameClass', 'syntaxNameTag'])

export const EDITOR_THEME_NAMES = {
  dark: 'daedalus-dark',
  light: 'daedalus-light',
} as const

export function editorTheme(mode: PaletteName): Monaco.editor.IStandaloneThemeData {
  const palette = paletteFor(mode)
  const rules: Monaco.editor.ITokenThemeRule[] = []
  for (const [name, role] of TOKEN_COLORS) {
    const foreground = palette[role]?.replace('#', '')
    if (!foreground) continue
    rules.push({ token: name, foreground, ...(EMPHASIZED.has(role) ? { fontStyle: 'bold' } : {}) })
  }

  const surface = palette.bgBase
  const raised = palette.syntaxBackground || palette.bgRaised || surface
  const fg = palette.fgBase
  const muted = palette.fgMoreSubtle || fg
  const subtle = palette.fgMostSubtle || muted
  const accent = palette.accent || fg
  const info = palette.info || fg
  const line = palette.separator || muted
  const destructive = palette.error || fg

  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: false,
    rules,
    colors: {
      'editor.background': surface,
      'editor.foreground': fg,
      'editorLineNumber.foreground': subtle,
      'editorLineNumber.activeForeground': muted,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': `${info}44`,
      'editor.inactiveSelectionBackground': `${info}22`,
      'editor.lineHighlightBackground': raised,
      'editor.lineHighlightBorder': 'transparent',
      'editorIndentGuide.background1': subtle,
      'editorIndentGuide.activeBackground1': muted,
      'editorWhitespace.foreground': subtle,
      'editorGutter.background': surface,
      'editorError.foreground': destructive,
      'editorWarning.foreground': palette.warning || fg,
      'editorBracketMatch.background': `${info}33`,
      'editorBracketMatch.border': info,
      'editorWidget.background': raised,
      'editorWidget.border': line,
      'editorSuggestWidget.background': raised,
      'editorSuggestWidget.border': line,
      'scrollbarSlider.background': `${muted}55`,
      'scrollbarSlider.hoverBackground': `${muted}88`,
      'scrollbarSlider.activeBackground': muted,
      'minimap.background': surface,
    },
  }
}