import { Suspense, lazy, useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { EmptyState, ErrorState, LoadingState } from '../common/panel'
import { PanelErrorBoundary } from '../common/error-boundary'
import { api } from '../../api/client'
import { languageForPath } from './language'
import { ImagePreview } from './image-preview'

/** Monaco is lazy-loaded: the editor chunk is fetched only when a file opens. */
const MonacoEditor = lazy(async () => import('./monaco-editor'))

/**
 * Editable code surface for a file in the shared workspace. Saving writes
 * through the gateway's existing PUT /workspace/file route into the very
 * folder the CLI operates on; there is no separate Web copy to export back.
 */
export function EditorPane({
  path,
  content,
  loading,
  error,
  size,
  root,
  kind = 'text',
  imageSrc = null,
  mediaType = null,
  onRetry,
  onSaved,
}: {
  path: string | null
  content: string
  loading: boolean
  error: string | null
  size: number
  root?: string
  kind?: 'text' | 'image'
  imageSrc?: string | null
  mediaType?: string | null
  onRetry?: () => void
  onSaved?: (path: string, content: string) => void
}) {
  const [surfaceFailed, setSurfaceFailed] = useState(false)
  const [draft, setDraft] = useState(content)
  const [savedContent, setSavedContent] = useState(content)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)

  // A newly opened file replaces the editing session wholesale.
  useEffect(() => {
    setDraft(content)
    setSavedContent(content)
    setSaveError(null)
    setDiskChanged(false)
    setSurfaceFailed(false)
    // Content is the initial disk snapshot for this path; later disk refreshes
    // are handled below so unsaved edits are never silently overwritten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // A disk refresh (for example the agent rewrote the file) either flows into
  // a clean editor or is surfaced as a conflict banner when there are unsaved
  // edits. The user's draft is always kept until they choose to reload.
  useEffect(() => {
    if (path === null || content === savedContent) return
    if (draft === savedContent) {
      setDraft(content)
      setSavedContent(content)
      setDiskChanged(false)
    } else if (content !== draft) {
      setDiskChanged(true)
    }
  }, [content, draft, path, savedContent])

  if (error) return <ErrorState title="cannot open file" message={error} onRetry={onRetry} />
  if (path === null) {
    return (
      <EmptyState
        title="No file open"
        hint="Pick a file in the workspace tree or Files Changed panel to inspect and edit it in the shared workspace."
      />
    )
  }
  if (loading) return <LoadingState label={`opening ${path}`} />
  // Images render as pictures: never through Monaco/textarea (binary would
  // show as gibberish, and Save would happily corrupt it back to disk).
  if (kind === 'image') {
    if (!imageSrc) return <ErrorState title="cannot open image" message="The server returned no image data for this file." onRetry={onRetry} />
    return <ImagePreview path={path} src={imageSrc} size={size} mediaType={mediaType} />
  }

  const dirty = draft !== savedContent
  const language = languageForPath(path)

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    if (!root) {
      setSaveError('Choose a workspace before saving.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await api.saveFile(root, path, draft)
      setSavedContent(draft)
      setDiskChanged(false)
      onSaved?.(path, draft)
    } catch (caught) {
      // Keep the draft and dirty marker: a failed save must never look saved.
      setSaveError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const reloadFromDisk = (): void => {
    setDraft(content)
    setSavedContent(content)
    setDiskChanged(false)
    setSaveError(null)
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="editor-pane"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void save()
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="truncate text-[11px] text-foreground">{path}</span>
        {dirty ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-warning" data-testid="editor-dirty">
            <span aria-hidden="true">●</span> modified
          </span>
        ) : (
          <Badge tone="success">saved</Badge>
        )}
        <Badge tone="neutral">{language}</Badge>
        <span className="ml-auto text-[10px] text-muted">
          {size > 0 ? `${size} bytes` : `${draft.split('\n').length} lines`}
        </span>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!dirty || saving} data-testid="editor-save">
          <Save /> {saving ? 'saving…' : 'save'}
        </Button>
      </div>

      {diskChanged ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11px] text-warning" data-testid="editor-disk-changed" role="status">
          <span>This file changed on disk while you have unsaved edits. Your draft is kept.</span>
          <Button type="button" variant="outline" size="sm" onClick={reloadFromDisk}>
            reload disk version
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDiskChanged(false)}>
            keep mine
          </Button>
        </div>
      ) : null}

      {saveError ? (
        <p role="alert" className="border-b border-line px-3 py-1.5 text-[11px] text-error">
          {saveError}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {surfaceFailed ? (
          <textarea
            aria-label={`edit ${path}`}
            data-testid="editor-fallback"
            className="h-full w-full resize-none bg-surface-base p-3 font-mono text-[11px] text-foreground outline-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <Suspense fallback={<LoadingState label="loading editor" />}>
            <PanelErrorBoundary
              fallback={
                <textarea
                  aria-label={`edit ${path}`}
                  data-testid="editor-fallback"
                  className="h-full w-full resize-none bg-surface-base p-3 font-mono text-[11px] text-foreground outline-none"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              }
              onError={() => setSurfaceFailed(true)}
            >
              <MonacoEditor value={draft} language={language} path={path} onChange={setDraft} onSave={() => void save()} />
            </PanelErrorBoundary>
          </Suspense>
        )}
      </div>
    </div>
  )
}
