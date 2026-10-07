import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, ImagePlus, Pin, PinOff, UploadCloud } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ErrorState, LoadingState, Panel } from '../common/panel'
import { api } from '../../api/client'
import type { WorkspaceEntry, WorkspaceRoot, WorkspaceTreeNode } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Workspace surface: pick the target repository, then browse it. Directories
 * load their children on demand so a large tree never blocks first paint.
 *
 * `className` lets the app shell size the panel inside the left column: the
 * shell gives it a flexible share (App.tsx) so the panel can never grow to
 * its full content height and starve the scroll region below it.
 */
export function WorkspacePanel({ className }: { className?: string } = {}) {
  const workspace = useDaedalusStore((state) => state.workspace)
  const setWorkspace = useDaedalusStore((state) => state.setWorkspace)
  const setSession = useDaedalusStore((state) => state.setSession)
  const workspaceRevision = useDaedalusStore((state) => state.workspaceRevision)
  const openFilePath = useDaedalusStore((state) => state.openFilePath)
  const setOpenFile = useDaedalusStore((state) => state.setOpenFile)
  const activeTaskId = useDaedalusStore((state) => state.taskId)
  const addAttachments = useDaedalusStore((state) => state.addAttachments)
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [rootError, setRootError] = useState<string | null>(null)
  const [tree, setTree] = useState<WorkspaceTreeNode | null>(null)
  const [treeRoot, setTreeRoot] = useState<string | null>(null)
  const [treeFailure, setTreeFailure] = useState<{ root: string; message: string } | null>(null)
  const [expanded, setExpanded] = useState<string[]>(['.'])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [filePath, setFilePath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [pins, setPins] = useState<string[]>([])
  const [mutationStatus, setMutationStatus] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

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

  // User pins (tailor suite): persisted server-side in .daedalus/pins.json
  // and injected into every task's workspace overview. Loaded per root.
  useEffect(() => {
    if (!root) {
      setPins([])
      return
    }
    let cancelled = false
    api
      .pins(root)
      .then((response) => {
        if (!cancelled) setPins(response.pins)
      })
      .catch(() => {
        if (!cancelled) setPins([])
      })
    return () => {
      cancelled = true
    }
  }, [root])

  const togglePin = async (entry: WorkspaceEntry): Promise<void> => {
    if (!root) return
    const next = pins.includes(entry.path) ? pins.filter((pin) => pin !== entry.path) : [...pins, entry.path]
    try {
      const response = await api.savePins(root, next)
      setPins(response.pins)
      setMutationStatus(response.pins.includes(entry.path) ? `Pinned ${entry.path} — the agent sees it in every task overview.` : `Unpinned ${entry.path}.`)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    }
  }

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

  const refreshTree = useCallback((): void => {
    if (!root) return
    setChildren({})
    setExpanded(['.'])
    loadRoot(root)
  }, [loadRoot, root])

  // Editor saves and other Web mutations bump this revision; reloading the
  // tree makes the same on-disk workspace (shared with the CLI) visible
  // without any export/import step.
  useEffect(() => {
    if (workspaceRevision > 0) refreshTree()
  }, [refreshTree, workspaceRevision])

  const runMutation = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMutationError(null)
    try {
      const message = await action()
      setMutationStatus(message)
      refreshTree()
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const createWorkspace = async (): Promise<void> => {
    const name = workspaceName.trim()
    if (!name) {
      setMutationError('workspace name is required')
      return
    }
    await runMutation(async () => {
      const created = await api.createWorkspace({ root: root || undefined, name })
      setRoots((current) => (current.some((entry) => entry.path === created.path) ? current : [...current, { path: created.path, name: created.name }]))
      setWorkspace({ root: created.path, content: '', path: '', kind: 'text', imageSrc: null, mediaType: null })
      setWorkspaceName('')
      return `Workspace ready: ${created.path}`
    })
  }

  const createFolder = async (): Promise<void> => {
    const path = folderPath.trim()
    if (!path) {
      setMutationError('folder path is required')
      return
    }
    await runMutation(async () => {
      await api.createFolder(root, path)
      setFolderPath('')
      return `Folder created: ${path}`
    })
  }

  const createFile = async (): Promise<void> => {
    const path = filePath.trim()
    if (!path) {
      setMutationError('file path is required')
      return
    }
    await runMutation(async () => {
      await api.createFile(root, path, fileContent)
      setFilePath('')
      setFileContent('')
      return `File created: ${path}`
    })
  }

  const renameEntry = async (): Promise<void> => {
    const from = renameFrom.trim()
    const to = renameTo.trim()
    if (!from || !to) {
      setMutationError('rename source and destination are required')
      return
    }
    await runMutation(async () => {
      await api.renameWorkspaceEntry(root, from, to)
      setRenameFrom('')
      setRenameTo('')
      return `Renamed ${from} → ${to}`
    })
  }

  const uploadFiles = async (files: FileList | File[], kind: 'file' | 'folder' | 'image' | 'zip'): Promise<void> => {
    const list = [...files]
    if (list.length === 0) return
    await runMutation(async () => {
      const form = new FormData()
      form.set('root', root)
      form.set('kind', kind)
      if (activeTaskId) form.set('task_id', activeTaskId)
      for (const file of list) {
        const path = kind === 'folder' ? relativePathOf(file) : file.name
        form.append('files', new File([file], path, { type: file.type, lastModified: file.lastModified }))
      }
      const response = await api.upload(form)
      addAttachments(response.attachments)
      return `Uploaded ${response.files.length} file(s) to ${response.destination}; ${response.attachments.length} attachment(s) staged.`
    })
  }

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
      setWorkspace({ content: file.content ?? '', size: file.size, loading: false, kind: file.kind ?? 'text', imageSrc: file.src ?? null, mediaType: file.mediaType ?? null })
    } catch (error) {
      setWorkspace({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const roots_ = roots

  return (
    <Panel
      title="workspace"
      data-testid="workspace-panel"
      className={className}
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
          onChange={(event) => {
            const nextRoot = event.target.value
            setWorkspace({ root: nextRoot, content: '', path: '', kind: 'text', imageSrc: null, mediaType: null })
            setOpenFile(null)
            void api
              .updateSession({ workspaceRoot: nextRoot })
              .then((response) => setSession(response.session))
              .catch((error: unknown) => setMutationError(error instanceof Error ? error.message : String(error)))
          }}
        >
          {roots_.length === 0 ? <option value="">{root || 'loading…'}</option> : null}
          {roots_.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.name} — {candidate.path}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid="workspace-actions">
        <div className="flex gap-1">
          <Input aria-label="new workspace name" placeholder="new workspace folder" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
          <Button type="button" size="sm" onClick={() => void createWorkspace()} disabled={busy || !workspaceName.trim()} data-testid="workspace-create">
            create workspace
          </Button>
        </div>
        <div className="flex gap-1">
          <Input aria-label="new folder path" placeholder="folder path e.g. src/components" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} />
          <Button type="button" variant="outline" size="sm" onClick={() => void createFolder()} disabled={busy || !root || !folderPath.trim()} data-testid="workspace-create-folder">
            folder
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <Input aria-label="new file path" placeholder="file path e.g. src/index.ts" value={filePath} onChange={(event) => setFilePath(event.target.value)} />
            <Button type="button" variant="outline" size="sm" onClick={() => void createFile()} disabled={busy || !root || !filePath.trim()} data-testid="workspace-create-file">
              file
            </Button>
          </div>
          <textarea
            aria-label="new file content"
            className="min-h-12 w-full rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-foreground placeholder:text-muted"
            placeholder="initial file content (optional)"
            value={fileContent}
            onChange={(event) => setFileContent(event.target.value)}
          />
        </div>
        <div className="flex gap-1">
          <Input aria-label="rename from path" placeholder="rename from" value={renameFrom} onChange={(event) => setRenameFrom(event.target.value)} />
          <Input aria-label="rename to path" placeholder="rename to" value={renameTo} onChange={(event) => setRenameTo(event.target.value)} />
          <Button type="button" variant="ghost" size="sm" onClick={() => void renameEntry()} disabled={busy || !root || !renameFrom.trim() || !renameTo.trim()} data-testid="workspace-rename">
            rename
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy || !root} data-testid="workspace-upload">
            <UploadCloud /> upload files/ZIP
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => folderInputRef.current?.click()} disabled={busy || !root} data-testid="workspace-upload-folder">
            <Folder /> upload folder
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} disabled={busy || !root} data-testid="workspace-upload-image">
            <ImagePlus /> image
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={refreshTree} disabled={!root}>
            refresh
          </Button>
        </div>
        <input ref={fileInputRef} type="file" multiple className="hidden" data-testid="workspace-file-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'file')} />
        <input ref={folderInputRef} type="file" multiple className="hidden" data-testid="workspace-folder-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'folder')} />
        <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" data-testid="workspace-image-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'image')} />
        {mutationStatus ? <p className="text-[11px] text-success" data-testid="workspace-status">{mutationStatus}</p> : null}
        {mutationError ? (
          <p role="alert" className="text-[11px] text-error">
            {mutationError}
          </p>
        ) : null}
      </div>

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
              pins={pins}
              onToggle={toggle}
              onOpen={open}
              onTogglePin={togglePin}
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

function relativePathOf(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string }
  return withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0 ? withPath.webkitRelativePath : file.name
}

function TreeRow({
  entry,
  depth,
  expanded,
  children,
  loadingPath,
  selectedPath,
  pins,
  onToggle,
  onOpen,
  onTogglePin,
}: {
  entry: WorkspaceEntry
  depth: number
  expanded: string[]
  children: Record<string, WorkspaceEntry[]>
  loadingPath: string | null
  selectedPath: string | null
  pins: string[]
  onToggle: (entry: WorkspaceEntry) => Promise<void>
  onOpen: (entry: WorkspaceEntry) => Promise<void>
  onTogglePin: (entry: WorkspaceEntry) => Promise<void>
}) {
  const isOpen = expanded.includes(entry.path)
  const pinned = pins.includes(entry.path)
  const padding = { paddingLeft: `${depth * 12 + 4}px` }
  const pinButton = (
    <button
      type="button"
      onClick={() => void onTogglePin(entry)}
      data-testid="file-tree-pin"
      data-path={entry.path}
      data-pinned={pinned ? 'true' : 'false'}
      aria-label={pinned ? `unpin ${entry.path}` : `pin ${entry.path}`}
      title={pinned ? 'Pinned: shown in every task overview (click to unpin)' : 'Pin: show in every task overview'}
      className={`shrink-0 rounded p-0.5 hover:bg-surface ${pinned ? 'text-primary' : 'text-muted opacity-50 hover:opacity-100'}`}
    >
      {pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
    </button>
  )

  if (!entry.isDirectory) {
    return (
      <li>
        <div className="flex w-full items-center" style={padding}>
          <button
            type="button"
            onClick={() => void onOpen(entry)}
            data-testid="file-tree-item"
            data-path={entry.path}
            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface ${
              selectedPath === entry.path ? 'bg-surface text-primary' : 'text-foreground'
            }`}
          >
            <FileIcon className="size-3 shrink-0 text-muted" />
            <span className="truncate">{entry.name}</span>
          </button>
          {pinButton}
        </div>
      </li>
    )
  }

  const grandchildren = children[entry.path] ?? []
  return (
    <li>
      <div className="flex w-full items-center" style={padding}>
        <button
          type="button"
          onClick={() => void onToggle(entry)}
          data-testid="file-tree-dir"
          data-path={entry.path}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-foreground hover:bg-surface"
          aria-expanded={isOpen}
        >
          {isOpen ? <ChevronDown className="size-3 shrink-0 text-muted" /> : <ChevronRight className="size-3 shrink-0 text-muted" />}
          {isOpen ? <FolderOpen className="size-3 shrink-0 text-muted" /> : <Folder className="size-3 shrink-0 text-muted" />}
          <span className="truncate">{entry.name}</span>
          {loadingPath === entry.path ? <span className="text-[9px] text-muted">…</span> : null}
        </button>
        {pinButton}
      </div>
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
              pins={pins}
              onToggle={onToggle}
              onOpen={onOpen}
              onTogglePin={onTogglePin}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}