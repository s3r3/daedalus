import { describe, expect, test } from 'vitest'
import { languageForPath, modelUriForPath } from './language'

describe('editor language detection', () => {
  test('tsx is TypeScript (with JSX), never plain JSX/JavaScript', () => {
    expect(languageForPath('src/App.tsx')).toBe('typescript')
    expect(languageForPath('src/main.ts')).toBe('typescript')
    expect(languageForPath('src/legacy.jsx')).toBe('javascript')
    expect(languageForPath('src/plain.js')).toBe('javascript')
  })

  test('the Monaco model URI keeps the real extension for script-kind inference', () => {
    // Monaco's TS service reads .tsx/.jsx off the model path; an
    // extension-less in-memory model made it misread TSX files as JSX/TS.
    expect(modelUriForPath('src/App.tsx')).toBe('inmemory://workspace/src/App.tsx')
    expect(modelUriForPath('src/legacy.jsx')).toBe('inmemory://workspace/src/legacy.jsx')
    expect(modelUriForPath('/leading/slash.ts')).toBe('inmemory://workspace/leading/slash.ts')
    expect(modelUriForPath('win\\style\\path.tsx')).toBe('inmemory://workspace/win/style/path.tsx')
  })
})
