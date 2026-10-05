import { useEffect, useRef } from 'react'
import { useDaedalusStore } from '../../state/taskStore'
import type * as Monaco from 'monaco-editor'
import type { PaletteName } from '@daedalus/core/palette'
import { EDITOR_THEME_NAMES, editorTheme } from '../../theme/editor-theme'

type EditorHandle = Pick<Monaco.editor.IStandaloneCodeEditor, 'getValue' | 'setValue'>

/**
 * Monaco editor surface, loaded on demand. Language services need their web
 * workers, so the worker map is registered once inside this chunk — nothing
 * Monaco-related is fetched until the user opens a file.
 */
export function MonacoEditor({ value, language, path }: { value: string; language: string; path: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  const initialValueRef = useRef(value)
  const disposedRef = useRef(false)
  const appliedThemeRef = useRef<string | null>(null)
  const theme = useDaedalusStore((state) => state.theme)
  const mode: PaletteName = theme === 'daedalus-light' ? 'light' : 'dark'

  useEffect(() => {
    let disposed = false
    let dispose: (() => void) | undefined
    // StrictMode mounts, unmounts, and remounts: the cleanup below sets this
    // flag, so the next mount has to clear it or the theme effect would treat
    // every later switch as a disposed component.
    disposedRef.current = false

    void (async () => {
      const [monaco] = await Promise.all([import('monaco-editor'), configureWorkers()])
      if (disposed || !hostRef.current) return
      appliedThemeRef.current = applyEditorThemeName(mode)
      const editor = monaco.editor.create(hostRef.current, {
        value: initialValueRef.current,
        language,
        theme: applyEditorTheme(monaco, mode),
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        glyphMargin: false,
        wordWrap: 'on',
      })
      editorRef.current = editor
      dispose = () => {
        editor.dispose()
        editorRef.current = null
      }
    })()

    return () => {
      disposed = true
      disposedRef.current = true
      dispose?.()
    }
    // The editor instance is bound to the file identity; content is synced below
    // and a theme switch is applied in place, so `mode` must not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, path])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) editor.setValue(value)
  }, [value])

  useEffect(() => {
    void (async () => {
      const editor = editorRef.current
      if (!editor || appliedThemeRef.current === applyEditorThemeName(mode)) return
      const monaco = await import('monaco-editor')
      if (disposedRef.current) return
      appliedThemeRef.current = applyEditorThemeName(mode)
      monaco.editor.setTheme(applyEditorTheme(monaco, mode))
    })()
  }, [mode])

  return <div ref={hostRef} data-testid="monaco-host" className="h-full w-full" />
}

/**
 * Monaco's bundled themes are built-in and cannot be restyled, so the palette
 * theme is defined once per mode and selected by name.
 */
function applyEditorThemeName(mode: PaletteName): string {
  return mode === 'dark' ? EDITOR_THEME_NAMES.dark : EDITOR_THEME_NAMES.light
}

/**
 * Monaco's bundled themes cannot be restyled, so the palette theme is defined
 * once per mode and then selected by name.
 */
function applyEditorTheme(monaco: typeof Monaco, mode: PaletteName): string {
  const name = applyEditorThemeName(mode)
  monaco.editor.defineTheme(name, editorTheme(mode))
  return name
}

let workersConfigured = false

async function configureWorkers(): Promise<void> {
  if (workersConfigured) return
  workersConfigured = true
  const [editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker] = await Promise.all([
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
  ])
  const factories: Record<string, new () => Worker> = {
    editor: editorWorker.default,
    typescript: tsWorker.default,
    javascript: tsWorker.default,
    json: jsonWorker.default,
    css: cssWorker.default,
    scss: cssWorker.default,
    less: cssWorker.default,
    html: htmlWorker.default,
    handlebars: htmlWorker.default,
    razor: htmlWorker.default,
  }
  ;(globalThis as unknown as { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment = {
    getWorker: (_id: string, label: string) => {
      const factory = factories[label] ?? factories.editor
      return new factory()
    },
  }
}

export default MonacoEditor