import { useEffect, useState, type CSSProperties } from 'react'
import { Download, FileJson2, FileType2, FolderOpen } from 'lucide-react'
import { api } from '../../api/client'
import type { WorkspaceEntry } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

/**
 * Slide-domain replacement for the code workspace panel: in Slide mode
 * the workspace surfaces the deck artifacts only (deck/deck.json and the
 * exported .pptx files) — code files are the Coding domain's business.
 */
export function SlideWorkspacePanel({ className, style }: { className?: string; style?: CSSProperties }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!root) {
      setEntries([])
      return
    }
    let cancelled = false
    api
      .list(root, 'deck')
      .then(({ items }) => {
        if (!cancelled) {
          setEntries(items)
          setError(null)
        }
      })
      .catch(() => {
        // No deck/ directory yet is the normal pre-first-task state.
        if (!cancelled) {
          setEntries([])
          setError(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [root, revision])

  const files = entries.filter((entry) => !entry.isDirectory)

  return (
    <section data-testid="slide-workspace" className={cn('flex min-h-0 flex-col rounded-md border border-line bg-surface-base', className)} style={style}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FolderOpen className="size-3.5 text-primary" aria-hidden />
        <strong className="text-[11px] uppercase tracking-wide text-muted">Deck workspace</strong>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!root ? (
          <p className="px-1 py-1 text-[11px] text-muted">Buka workspace dulu…</p>
        ) : files.length === 0 ? (
          <p className="px-1 py-1 text-[11px] text-muted">Belum ada file deck. Hasil ekspor .pptx muncul di sini.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {files.map((entry) => {
              const isPptx = entry.name.toLowerCase().endsWith('.pptx')
              const rel = `deck/${entry.name}`
              return (
                <li key={entry.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] hover:bg-surface-raised">
                  {isPptx ? <FileType2 className="size-3.5 shrink-0 text-primary" aria-hidden /> : <FileJson2 className="size-3.5 shrink-0 text-muted" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate text-foreground">{rel}</span>
                  {typeof entry.size === 'number' ? <span className="shrink-0 text-[10px] text-muted">{Math.max(1, Math.round(entry.size / 1024))} KB</span> : null}
                  {isPptx ? (
                    <a
                      href={api.deckDownloadUrl(root, rel)}
                      download={entry.name}
                      data-testid={`slide-download-${entry.name}`}
                      className="shrink-0 rounded border border-line p-1 text-muted hover:border-primary hover:text-foreground"
                      aria-label={`unduh ${entry.name}`}
                    >
                      <Download className="size-3.5" aria-hidden />
                    </a>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {error ? <p className="px-1 py-1 text-[11px] text-muted">{error}</p> : null}
      </div>
      {root ? <p className="truncate border-t border-line px-3 py-1.5 text-[10px] text-muted" title={root}>{root}</p> : null}
    </section>
  )
}
