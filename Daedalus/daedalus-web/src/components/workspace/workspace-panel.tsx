import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ErrorState, LoadingState, Panel } from '../common/panel'
import { api } from '../../api/client'
import type { WorkspaceEntry, WorkspaceRoot, WorkspaceTreeNode } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Workspace surface: pick the target repository, then browse it. Directories
 * load their children on demand so a large tree never blocks first paint.
 */
export function WorkspacePanel() {
  const workspace = useDaedalusStore((state) => state.workspace)
  const setWorkspace = useDaedalusStore((state) => state.setWorkspace)
  const openFilePath = useDaedalusStore((state) => state.openFilePath)
  const setOpenFile = useDaedalusStore((state) => state.setOpenFile)
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [rootError, setRootError] = useState<string | null>(null)
  const [tree, setTree] = useState<WorkspaceTreeNode | null>(null)
  const [treeRoot, setTreeRoot] = useState<string | null>(null)
  const [treeFailure, setTreeFailure] = useState<{ root: string; message: string } | null>(null)
  const [expanded, setExpanded] = useState<string[]>(['.'])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .roots()
      .then((response) => {
        if (cancelled) return
        setRoots(response.roots)
        if (useDaedalusStore.getState().workspace.root.length === 0) setWorkspace({ root: response.cwd })
      })
      .catch((error: unknown) => setRootError(error instanceof Error ? error.message : String(error)))
    return () => {
      cancelled = true
    }
  }, [setWorkspace])

  const root = workspace.root

  /**
   * Reading and applying a root are split so the fetch never touches state
   * itself: the effect and the retry handler both commit through
   * `applyRoot`, and every write lands after an await tagged with the root it
   * belongs to. Switching repositories therefore never paints another root's
   * tree or its error.
   */
  const readRoot = useCallback(
    async (nextRoot: string): Promise<{ kind: 'ok'; node: WorkspaceTreeNode } | { kind: 'error'; message: string }> => {
      try {
        return { kind: 'ok', node: await api.tree(nextRoot, '.', 1) }
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    },
    [],
  )

  const applyRoot = useCallback(
    (nextRoot: string) => (result: { kind: 'ok'; node: WorkspaceTreeNode } | { kind: 'error'; message: string }) => {
      if (result.kind === 'error') {
        setTreeFailure({ root: nextRoot, message: result.message })
        return
      }
      setTree(result.node)
      setTreeRoot(nextRoot)
      setChildren((current) => ({ ...current, '.': result.node.children ?? [] }))
    },
    [],
  )

  const loadRoot = useCallback(
    (nextRoot: string) => void readRoot(nextRoot).then(applyRoot(nextRoot)),
    [readRoot, applyRoot],
  )

  useEffect(() => {
    if (root.length === 0) return
    let cancelled = false
    void readRoot(root).then((result) => {
      if (!cancelled) applyRoot(root)(result)
    })
    return () => {
      cancelled = true
    }
  }, [root, readRoot, applyRoot])

  const treeError = treeFailure?.root === root ? treeFailure.message : null
  const visibleTree = treeRoot === root ? tree : null
  const readingRoot = root.length > 0 && treeRoot !== root && treeError === null

  const toggle = async (entry: WorkspaceEntry): Promise<void> => {
    if (!entry.isDirectory) return
    if (expanded.includes(entry.path)) {
      setExpanded((current) => current.filter((path) => path !== entry.path))
      return
    }
    setExpanded((current) => [...current, entry.path])
    if (children[entry.path]) return
    setLoadingPath(entry.path)
    try {
      const response = await api.list(root, entry.path)
      setChildren((current) => ({ ...current, [entry.path]: response.items }))
    } catch (error) {
      setTreeFailure({ root, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoadingPath(null)
    }
  }

  const open = async (entry: WorkspaceEntry): Promise<void> => {
    setWorkspace({ path: entry.path, loading: true, error: null })
    setOpenFile(entry.path)
    try {
      const file = await api.file(root, entry.path)
      setWorkspace({ content: file.content, size: file.size, loading: false })
    } catch (error) {
      setWorkspace({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const roots_ = roots

  return (
    <Panel
      title="workspace"
      data-testid="workspace-panel"
      action={
        root.length > 0 ? (
          <Badge tone="primary" className="max-w-[150px] truncate">
            {root}
          </Badge>
        ) : null
      }
      bodyClassName="flex min-h-0 flex-col gap-2 overflow-y-auto"
    >
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        repository
        <select
          aria-label="workspace root"
          data-testid="workspace-root"
          className="h-7 w-full rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
          value={workspace.root}
          onChange={(event) => setWorkspace({ root: event.target.value, content: '', path: '' })}
        >
          {roots_.length === 0 ? <option value="">{root || 'loading…'}</option> : null}
          {roots_.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.name} — {candidate.path}
            </option>
          ))}
        </select>
      </label>

      {rootError ? <ErrorState title="cannot list repositories" message={rootError} /> : null}
      {treeError ? <ErrorState title="cannot read workspace" message={treeError} onRetry={() => void loadRoot(root)} /> : null}
      {readingRoot ? <LoadingState label="reading workspace" /> : null}

      {visibleTree ? (
        <ul className="flex flex-col gap-0.5 text-[11px]" data-testid="file-tree">
          {(children['.'] ?? []).map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              depth={0}
              expanded={expanded}
              children={children}
              loadingPath={loadingPath}
              selectedPath={openFilePath}
              onToggle={toggle}
              onOpen={open}
            />
          ))}
        </ul>
      ) : null}

      {visibleTree && (children['.'] ?? []).length === 0 ? <p className="text-[11px] text-muted">workspace is empty</p> : null}

      {openFilePath ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpenFile(null)}>
          close file
        </Button>
      ) : null}
    </Panel>
  )
}

function TreeRow({
  entry,
  depth,
  expanded,
  children,
  loadingPath,
  selectedPath,
  onToggle,
  onOpen,
}: {
  entry: WorkspaceEntry
  depth: number
  expanded: string[]
  children: Record<string, WorkspaceEntry[]>
  loadingPath: string | null
  selectedPath: string | null
  onToggle: (entry: WorkspaceEntry) => Promise<void>
  onOpen: (entry: WorkspaceEntry) => Promise<void>
}) {
  const isOpen = expanded.includes(entry.path)
  const padding = { paddingLeft: `${depth * 12 + 4}px` }

  if (!entry.isDirectory) {
    return (
      <li>
        <button
          type="button"
          onClick={() => void onOpen(entry)}
          data-testid="file-tree-item"
          data-path={entry.path}
          style={padding}
          className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface ${
            selectedPath === entry.path ? 'bg-surface text-primary' : 'text-foreground'
          }`}
        >
          <FileIcon className="size-3 shrink-0 text-muted" />
          <span className="truncate">{entry.name}</span>
        </button>
      </li>
    )
  }

  const grandchildren = children[entry.path] ?? []
  return (
    <li>
      <button
        type="button"
        onClick={() => void onToggle(entry)}
        data-testid="file-tree-dir"
        data-path={entry.path}
        style={padding}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-foreground hover:bg-surface"
        aria-expanded={isOpen}
      >
        {isOpen ? <ChevronDown className="size-3 shrink-0 text-muted" /> : <ChevronRight className="size-3 shrink-0 text-muted" />}
        {isOpen ? <FolderOpen className="size-3 shrink-0 text-muted" /> : <Folder className="size-3 shrink-0 text-muted" />}
        <span className="truncate">{entry.name}</span>
        {loadingPath === entry.path ? <span className="text-[9px] text-muted">…</span> : null}
      </button>
      {isOpen ? (
        <ul>
          {grandchildren.length === 0 && loadingPath !== entry.path ? (
            <li style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }} className="text-[10px] text-muted">
              empty
            </li>
          ) : null}
          {grandchildren.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              children={children}
              loadingPath={loadingPath}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}