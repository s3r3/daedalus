import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, Download, File as FileIcon, FileJson2, FileType2, Folder, FolderOpen } from 'lucide-react'
import { api } from '../../api/client'
import type { WorkspaceEntry } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

/**
 * Slide-domain workspace panel (Farid's rule): in Slide mode the workspace
 * is fully LISTED — every folder and file is browsable by name — but only
 * presentation artifacts can be OPENED here: `deck/deck.json` (which focuses
 * the slide canvas on the deck) and the exported `deck/*.pptx` files (the
 * download affordance). Any other file renders as a plain listed row: no
 * editor, no navigation, no open handler. The listing itself reuses the same
 * `/workspace/list` machinery as the Coding workspace panel.
 */
export function SlideWorkspacePanel({ className, style }: { className?: string; style?: CSSProperties }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const setSlideIndex = useDaedalusStore((state) => state.setSlideIndex)
  const [items, setItems] = useState<WorkspaceEntry[]>([])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expandedRef = useRef<string[]>([])
  const autoExpandedRoot = useRef<string | null>(null)
  expandedRef.current = expanded

  const loadChildren = useCallback(
    async (path: string): Promise<void> => {
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
    const isNewRoot = autoExpandedRoot.current !== root
    if (isNewRoot) {
      autoExpandedRoot.current = root
      setItems([])
      setChildren({})
      setExpanded([])
    }
    api
      .list(root, '.')
      .then(({ items: rootItems }) => {
        if (cancelled) return
        setItems(rootItems)
        setError(null)
        if (isNewRoot) {
          // Keep the deck artifacts one click away (as before): open deck/
          // by default in a fresh workspace.
          const deckDir = rootItems.find((entry) => entry.isDirectory && entry.path === 'deck')
          if (deckDir) {
            setExpanded(['deck'])
            void loadChildren('deck')
          }
        } else {
          // A revision bump means files changed on disk: refresh whatever
          // directories the user currently has open.
          for (const path of expandedRef.current) void loadChildren(path)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setItems([])
          setError(error instanceof Error ? error.message : String(error))
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

  const openDeck = (): void => {
    // Focusing the canvas: the deck hook re-reads deck/deck.json on the
    // revision bump, and the stage selection returns to the first slide.
    bumpWorkspaceRevision()
    setSlideIndex(0)
  }

  return (
    <section data-testid="slide-workspace" className={cn('flex min-h-0 flex-col rounded-md border border-line bg-surface-base', className)} style={style}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FolderOpen className="size-3.5 text-primary" aria-hidden />
        <strong className="text-[11px] uppercase tracking-wide text-muted">Deck workspace</strong>
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
              <SlideTreeRow
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                childrenMap={children}
                loadingPath={loadingPath}
                root={root}
                onToggle={toggle}
                onOpenDeck={openDeck}
              />
            ))}
          </ul>
        )}
      </div>
      {root ? <p className="truncate border-t border-line px-3 py-1.5 text-[10px] text-muted" title={root}>{root}</p> : null}
    </section>
  )
}

function formatSize(size: number): string {
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

function SlideTreeRow({
  entry,
  depth,
  expanded,
  childrenMap,
  loadingPath,
  root,
  onToggle,
  onOpenDeck,
}: {
  entry: WorkspaceEntry
  depth: number
  expanded: string[]
  childrenMap: Record<string, WorkspaceEntry[]>
  loadingPath: string | null
  root: string
  onToggle: (entry: WorkspaceEntry) => void
  onOpenDeck: () => void
}) {
  const padding = { paddingLeft: `${depth * 12 + 8}px` }
  const kids = childrenMap[entry.path] ?? []
  const isOpen = expanded.includes(entry.path)

  if (entry.isDirectory) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(entry)}
          data-testid="slide-ws-dir"
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
            {kids.length === 0 && loadingPath !== entry.path ? (
              <li className="px-2 py-0.5 text-[10px] text-muted" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                empty
              </li>
            ) : null}
            {kids.map((child) => (
              <SlideTreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                childrenMap={childrenMap}
                loadingPath={loadingPath}
                root={root}
                onToggle={onToggle}
                onOpenDeck={onOpenDeck}
              />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const size = typeof entry.size === 'number' ? <span className="shrink-0 text-[10px] text-muted">{formatSize(entry.size)}</span> : null

  if (entry.path === 'deck/deck.json') {
    return (
      <li>
        <div className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-raised" style={padding}>
          <button
            type="button"
            onClick={onOpenDeck}
            data-testid="slide-ws-open-deck"
            data-path={entry.path}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-[11px] text-foreground"
            title="Buka deck di canvas"
          >
            <FileJson2 className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>
          {size}
        </div>
      </li>
    )
  }

  if (entry.path.startsWith('deck/') && entry.name.toLowerCase().endsWith('.pptx')) {
    return (
      <li>
        <div className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-raised" style={padding}>
          <FileType2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{entry.name}</span>
          {size}
          <a
            href={api.deckDownloadUrl(root, entry.path)}
            download={entry.name}
            data-testid={`slide-download-${entry.name}`}
            className="shrink-0 rounded border border-line p-1 text-muted hover:border-primary hover:text-foreground"
            aria-label={`unduh ${entry.name}`}
          >
            <Download className="size-3.5" aria-hidden />
          </a>
        </div>
      </li>
    )
  }

  // Listed but not openable in Slide: plain row, no click handler, no editor.
  return (
    <li>
      <div
        data-testid="slide-ws-file"
        data-path={entry.path}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-[11px] text-muted"
        style={padding}
        title="Hanya bisa dilihat di daftar dalam mode Slide"
      >
        <FileIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {size}
      </div>
    </li>
  )
}
