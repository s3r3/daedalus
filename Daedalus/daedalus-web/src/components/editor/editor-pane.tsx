import { Suspense, lazy, useState } from 'react'
import { Badge } from '../ui/badge'
import { EmptyState, ErrorState, LoadingState } from '../common/panel'
import { PanelErrorBoundary } from '../common/error-boundary'
import { languageForPath } from './language'

/** Monaco is lazy-loaded: the editor chunk is fetched only when a file opens. */
const MonacoEditor = lazy(async () => import('./monaco-editor'))

/**
 * Code surface for a workspace file. Read-only in the MVP: the agent writes
 * files, the human inspects them and reads the diff.
 */
export function EditorPane({
  path,
  content,
  loading,
  error,
  size,
  onRetry,
}: {
  path: string | null
  content: string
  loading: boolean
  error: string | null
  size: number
  onRetry?: () => void
}) {
  const [surfaceFailed, setSurfaceFailed] = useState(false)

  if (error) return <ErrorState title="cannot open file" message={error} onRetry={onRetry} />
  if (path === null) {
    return (
      <EmptyState
        title="No file open"
        hint="Pick a file in the workspace tree to inspect it read-only while the agent works."
      />
    )
  }
  if (loading) return <LoadingState label={`opening ${path}`} />

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="editor-pane">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="truncate text-[11px] text-foreground">{path}</span>
        <Badge tone="neutral">read-only</Badge>
        <span className="ml-auto text-[10px] text-muted">
          {size > 0 ? `${size} bytes` : `${content.split('\n').length} lines`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {surfaceFailed ? (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] text-foreground" data-testid="editor-fallback">
            {content}
          </pre>
        ) : (
          <Suspense fallback={<LoadingState label="loading editor" />}>
            <PanelErrorBoundary
              fallback={
                <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] text-foreground" data-testid="editor-fallback">
                  {content}
                </pre>
              }
              onError={() => setSurfaceFailed(true)}
            >
              <MonacoEditor value={content} language={languageForPath(path)} path={path} />
            </PanelErrorBoundary>
          </Suspense>
        )}
      </div>
    </div>
  )
}