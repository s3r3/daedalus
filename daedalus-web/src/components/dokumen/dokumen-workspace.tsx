import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, FilePlus2, Folder, FolderOpen, Paintbrush, RefreshCw } from 'lucide-react'
import { api } from '../../api/client'
import { Button } from '../ui/button'
import type { WorkspaceEntry } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

const SUPPORTED = ['.pdf', '.docx', '.eml', '.txt', '.md']

function isSupported(name: string): boolean {
  const lower = name.toLowerCase()
  return SUPPORTED.some((ext) => lower.endsWith(ext))
}

/**
 * Dokumen workspace panel (Slide-workspace doctrine, Farid's rule):
 * the workspace is fully LISTED — every folder and file visible by
 * name — but only document sources OPEN here (PDF/DOCX/EML/TXT/MD
 * attach as extraction sources; a DOCX can also become the re-layout
 * target). Anything else is listed plainly: it opens in Coding, not
 * here. Listing reuses the same /workspace/list machinery.
 */
export function DokumenWorkspacePanel({ className, style }: { className?: string; style?: CSSProperties }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [items, setItems] = useState<WorkspaceEntry[]>([])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expandedRef = useRef<string[]>([])
  expandedRef.current = expanded

  const loadChildren = useCallback(
    async (path: string): Promise<void> => {
      if (!root) return
      setLoadingPath(path)
      try {
        const response = await api.list(root, path)
        setChildren((current) => ({ ...current, [path]: response.items }))
      } catch {
        setChildren((current) => ({ ...current, [path]: [] }))
      } finally {
        setLoadingPath(null)
      }
    },
    [root],
  )

  useEffect(() => {
    if (!root) {
      setItems([])
      setChildren({})
      setExpanded([])
      return
    }
    let cancelled = false
    api
      .list(root, '.')
      .then(({ items: rootItems }) => {
        if (cancelled) return
        setItems(rootItems)
        setError(null)
        for (const path of expandedRef.current) void loadChildren(path)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setItems([])
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [root, revision, loadChildren])

  const toggle = (entry: WorkspaceEntry): void => {
    if (!entry.isDirectory) return
    if (expanded.includes(entry.path)) {
      setExpanded((current) => current.filter((path) => path !== entry.path))
      return
    }
    setExpanded((current) => [...current, entry.path])
    if (!children[entry.path]) void loadChildren(entry.path)
  }

  return (
    <section data-testid="dokumen-workspace" className={cn('flex min-h-0 flex-col rounded-md border border-line bg-surface-base', className)} style={style}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FolderOpen className="size-3.5 text-primary" aria-hidden />
        <strong className="text-[11px] uppercase tracking-wide text-muted">Workspace dokumen</strong>
        <Button type="button" variant="ghost" size="sm" onClick={bumpWorkspaceRevision} disabled={!root} className="ml-auto" aria-label="refresh workspace">
          <RefreshCw /> refresh
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!root ? (
          <p className="px-1 py-1 text-[11px] text-muted">Buka workspace dulu…</p>
        ) : error ? (
          <p className="px-1 py-1 text-[11px] text-muted">{error}</p>
        ) : items.length === 0 ? (
          <p className="px-1 py-1 text-[11px] text-muted">Workspace kosong.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((entry) => (
              <DokumenTreeRow key={entry.path} entry={entry} depth={0} expanded={expanded} childrenMap={children} loadingPath={loadingPath} onToggle={toggle} />
            ))}
          </ul>
        )}
      </div>
      {root ? (
        <p className="truncate border-t border-line px-3 py-1.5 text-[10px] text-muted" title={root}>
          {root}
        </p>
      ) : null}
    </section>
  )
}

function DokumenTreeRow({
  entry,
  depth,
  expanded,
  childrenMap,
  loadingPath,
  onToggle,
}: {
  entry: WorkspaceEntry
  depth: number
  expanded: string[]
  childrenMap: Record<string, WorkspaceEntry[]>
  loadingPath: string | null
  onToggle: (entry: WorkspaceEntry) => void
}) {
  const dokumenOptions = useDaedalusStore((state) => state.dokumenOptions)
  const setDokumenOptions = useDaedalusStore((state) => state.setDokumenOptions)
  const padding = { paddingLeft: `${depth * 12 + 8}px` }
  const kids = childrenMap[entry.path] ?? []
  const isOpen = expanded.includes(entry.path)

  if (entry.isDirectory) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(entry)}
          data-testid="dokumen-ws-dir"
          data-path={entry.path}
          aria-expanded={isOpen}
          className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-surface-raised"
          style={padding}
        >
          {isOpen ? <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden /> : <ChevronRight className="size-3 shrink-0 text-muted" aria-hidden />}
          {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-muted" aria-hidden /> : <Folder className="size-3.5 shrink-0 text-muted" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {loadingPath === entry.path ? <span className="shrink-0 text-[9px] text-muted">…</span> : null}
        </button>
        {isOpen ? (
          <ul className="flex flex-col gap-0.5">
            {kids.map((kid) => (
              <DokumenTreeRow key={kid.path} entry={kid} depth={depth + 1} expanded={expanded} childrenMap={childrenMap} loadingPath={loadingPath} onToggle={onToggle} />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const supported = isSupported(entry.name)
  const picked = dokumenOptions.sources.includes(entry.path)
  const isDocx = entry.name.toLowerCase().endsWith('.docx')
  const isRelayoutTarget = dokumenOptions.docxPath === entry.path

  return (
    <li>
      <div
        data-testid="dokumen-ws-file"
        data-path={entry.path}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] hover:bg-surface-raised"
        style={padding}
        title={supported ? entry.path : 'Hanya terdaftar di sini — berkas ini dibuka di domain Coding'}
      >
        <FileIcon className={cn('size-3.5 shrink-0', supported ? 'text-primary' : 'text-muted')} aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', supported ? '' : 'text-muted')}>{entry.name}</span>
        {typeof entry.size === 'number' ? <span className="shrink-0 text-[9px] text-muted">{Math.max(1, Math.round(entry.size / 1024))} KB</span> : null}
        {supported ? (
          <button
            type="button"
            data-testid="dokumen-ws-attach"
            className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 text-[9px] font-semibold', picked ? 'border-emerald-500/50 text-emerald-500' : 'border-line text-muted hover:text-foreground')}
            onClick={() =>
              setDokumenOptions({
                sources: picked ? dokumenOptions.sources.filter((s) => s !== entry.path) : [...dokumenOptions.sources, entry.path],
                ...(isDocx ? {} : {}),
              })
            }
          >
            <FilePlus2 className="size-3" aria-hidden /> {picked ? 'Sumber ✓' : 'Sumber'}
          </button>
        ) : null}
        {isDocx ? (
          <button
            type="button"
            data-testid="dokumen-ws-relayout"
            className={cn('inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 text-[9px] font-semibold', isRelayoutTarget ? 'border-primary text-primary' : 'border-line text-muted hover:text-foreground')}
            onClick={() => setDokumenOptions({ docxPath: isRelayoutTarget ? null : entry.path, subMode: 'susun' })}
            title="Jadikan target tata ulang (sub-mode Susun)"
          >
            <Paintbrush className="size-3" aria-hidden /> Tata ulang
          </button>
        ) : null}
      </div>
    </li>
  )
}
