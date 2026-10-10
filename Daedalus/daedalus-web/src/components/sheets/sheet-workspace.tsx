import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { ChevronRight, Download, FileSpreadsheet, Folder, RefreshCw } from 'lucide-react'
import { api } from '../../api/client'
import { Button } from '../ui/button'
import type { WorkspaceEntry } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

/**
 * Spreadsheet workspace panel (Farid's rule, same as Slide): every
 * workspace file is LISTED, but only spreadsheet artifacts open —
 * `.xlsx`/`.csv` (imported as the editable workbook), the exports
 * under `workbook/` (download), and `workbook/workbook.json` (focuses
 * the grid). Everything else is a plain listed row. Root-level listing
 * only, with the `workbook/` folder's exports folded in — the working
 * files for this domain live exactly there.
 */
export function SheetWorkspacePanel({ className, style }: { className?: string; style?: CSSProperties }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [items, setItems] = useState<WorkspaceEntry[]>([])
  const [workbookItems, setWorkbookItems] = useState<WorkspaceEntry[]>([])
  const [openWorkbookDir, setOpenWorkbookDir] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!root) return
    try {
      const [top, inner] = await Promise.all([
        api.list(root, '.'),
        api.list(root, 'workbook').catch(() => ({ items: [] as WorkspaceEntry[] })),
      ])
      setItems(top.items)
      setWorkbookItems(inner.items)
      setError(null)
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [root])

  useEffect(() => {
    void load()
  }, [load, revision])

  const openFile = async (path: string): Promise<void> => {
    if (!root || opening) return
    setOpening(path)
    try {
      await api.workbookOpen(root, path)
      bumpWorkspaceRevision()
    } catch (openError: unknown) {
      setError(openError instanceof Error ? openError.message : String(openError))
    } finally {
      setOpening(null)
    }
  }

  const isSpreadsheetFile = (entry: WorkspaceEntry): boolean => /\.(xlsx|csv)$/i.test(entry.name) && !entry.isDirectory

  return (
    <section
      aria-label="spreadsheet workspace"
      data-testid="sheet-workspace"
      className={cn('flex min-h-0 flex-col rounded-md border border-line bg-surface', className)}
      style={style}
    >
      <header className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Workspace</p>
        <span className="ml-auto">
          <Button type="button" size="sm" variant="ghost" onClick={() => void load()} data-testid="sheet-ws-refresh" aria-label="Muat ulang daftar file">
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
        </span>
      </header>
      {error ? (
        <p className="px-2 py-1 text-[10px] text-red-300" data-testid="sheet-ws-error">{error}</p>
      ) : null}
      <ul className="min-h-0 flex-1 overflow-auto px-1 py-1" data-testid="sheet-ws-list">
        {items.length === 0 ? (
          <li className="px-2 py-1 text-[11px] text-muted">Workspace kosong.</li>
        ) : null}
        {items.map((entry) => {
          if (entry.isDirectory && entry.name === 'workbook') {
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-foreground hover:bg-surface-base"
                  onClick={() => setOpenWorkbookDir((value) => !value)}
                  data-testid="sheet-ws-workbook-dir"
                >
                  <ChevronRight className={cn('size-3 text-muted transition-transform', openWorkbookDir ? 'rotate-90' : '')} aria-hidden />
                  <Folder className="size-3.5 text-muted" aria-hidden />
                  workbook/
                </button>
                {openWorkbookDir ? (
                  <ul className="ml-5 border-l border-line pl-1">
                    {workbookItems.map((inner) => {
                      const rel = `workbook/${inner.name}`
                      const isExport = /\.(xlsx|csv)$/i.test(inner.name)
                      return (
                        <li key={inner.path} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]">
                          <FileSpreadsheet className="size-3.5 text-muted" aria-hidden />
                          <span className={cn(isExport || inner.name === 'workbook.json' ? 'text-foreground' : 'text-muted')}>{inner.name}</span>
                          {inner.name === 'workbook.json' ? (
                            <span className="ml-auto text-[9px] uppercase tracking-wide text-muted">sumber kebenaran</span>
                          ) : isExport ? (
                            <a
                              href={api.workbookDownloadUrl(root, rel)}
                              className="ml-auto inline-flex items-center gap-1 text-[10px] text-primary underline decoration-dotted"
                              data-testid="sheet-ws-download"
                            >
                              <Download className="size-3" aria-hidden /> unduh
                            </a>
                          ) : null}
                        </li>
                      )
                    })}
                    {workbookItems.length === 0 ? <li className="px-1.5 py-1 text-[10px] text-muted">(kosong)</li> : null}
                  </ul>
                ) : null}
              </li>
            )
          }
          const openable = isSpreadsheetFile(entry)
          return (
            <li key={entry.path} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]">
              {entry.isDirectory ? (
                <Folder className="size-3.5 text-muted" aria-hidden />
              ) : (
                <FileSpreadsheet className="size-3.5 text-muted" aria-hidden />
              )}
              <span className={cn(openable ? 'text-foreground' : 'text-muted')}>{entry.path}</span>
              {openable ? (
                <button
                  type="button"
                  onClick={() => void openFile(entry.path)}
                  disabled={opening !== null}
                  data-testid="sheet-ws-open"
                  className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-primary hover:bg-surface-base"
                >
                  {opening === entry.path ? 'Membuka…' : 'Buka'}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="border-t border-line px-2 py-1 text-[9px] text-muted">
        Hanya .xlsx/.csv yang bisa dibuka di domain ini; file lain hanya terdaftar.
      </p>
    </section>
  )
}
