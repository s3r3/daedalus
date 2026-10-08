import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { TopBar } from './components/layout/top-bar'
import { Composer } from './components/composer/composer'
import { WorkspacePanel } from './components/workspace/workspace-panel'
import { SettingsDialog } from './components/settings/settings-dialog'
import { ExtensionsPanel } from './components/settings/extensions-panel'
import { EditorPane } from './components/editor/editor-pane'
import { DiffViewer } from './components/editor/diff-viewer'
import { PlanPanel } from './components/agent/plan-panel'
import { ActivityTimeline } from './components/agent/activity-timeline'
import { ChatPanel } from './components/agent/chat-panel'
import { PlanChipsBar } from './components/agent/plan-chips-bar'
import { TerminalPane } from './components/terminal/terminal-pane'
import { ValidationPanel } from './components/validation/validation-panel'
import { ErrorPanel, RecoveryPanel } from './components/recovery/recovery-panel'
import { AttachmentsPanel, ChildTasksPanel, FinalReportView } from './components/report/report-panels'
import { ScrollArea } from './components/ui/scroll-area'
import { useEventStream } from './api/useEventStream'
import { api } from './api/client'
import { readStoredTheme, applyPaletteVars } from './theme/theme'
import { useDaedalusStore } from './state/taskStore'
import {
  COLUMN_WIDTHS,
  WORKSPACE_PANEL_HEIGHT,
  loadActiveConversationId,
  loadColumnWidths,
  loadComposerPrefs,
  loadWorkspacePanelHeight,
  saveActiveConversationId,
  saveColumnWidths,
  saveWorkspacePanelHeight,
  type ColumnWidths,
} from './state/prefs'
import { VERSION } from '@daedalus/core/version'

/**
 * Daedalus web interface: a thin control plane over Daedalus Core.
 *
 * Layout (PLAN.md §3.0): the browser composes and observes — task entry, plan,
 * timeline, file tree, editor, diff, terminal, validation, approvals, report.
 * It executes nothing; every fact it shows comes from the recorded event log.
 */
export function App() {
  useEventStream()

  const theme = useDaedalusStore((state) => state.theme)
  const setTheme = useDaedalusStore((state) => state.setTheme)
  const workspace = useDaedalusStore((state) => state.workspace)
  const report = useDaedalusStore((state) => state.report)
  const openFilePath = useDaedalusStore((state) => state.openFilePath)
  const settingsOpen = useDaedalusStore((state) => state.settingsOpen)
  const setSession = useDaedalusStore((state) => state.setSession)
  const setProviders = useDaedalusStore((state) => state.setProviders)
  const setModels = useDaedalusStore((state) => state.setModels)
  const setWorkspace = useDaedalusStore((state) => state.setWorkspace)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const setComposer = useDaedalusStore((state) => state.setComposer)
  const setConversation = useDaedalusStore((state) => state.setConversation)
  const workspaceRoot = workspace.root

  // Side-column widths are user layout, persisted across visits. They only
  // take effect in the wide three-column layout; below it the columns stack.
  const [columns, setColumns] = useState<ColumnWidths>(() => loadColumnWidths())

  const clampColumn = (side: 'left' | 'right', value: number): number => {
    const range = COLUMN_WIDTHS[side]
    return Math.min(range.max, Math.max(range.min, Math.round(value)))
  }

  const startColumnResize = (side: 'left' | 'right') => (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = columns[side]
    let latest = columns
    const onMove = (move: globalThis.PointerEvent): void => {
      const delta = side === 'left' ? move.clientX - startX : startX - move.clientX
      const next = { ...latest, [side]: clampColumn(side, startWidth + delta) }
      latest = next
      setColumns(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      saveColumnWidths(latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const onColumnKeyDown = (side: 'left' | 'right') => (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 8
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = columns[side] + (side === 'left' ? -step : step)
    else if (event.key === 'ArrowRight') next = columns[side] + (side === 'left' ? step : -step)
    if (next === undefined) return
    event.preventDefault()
    const updated = { ...columns, [side]: clampColumn(side, next) }
    setColumns(updated)
    saveColumnWidths(updated)
  }

  // Workspace-panel height in the left column: 0 = unset, the panel shares
  // the column evenly with the scroll stack below. Dragging the divider
  // pins an explicit height (persisted); double-click releases it.
  const [workspacePanelHeight, setWorkspacePanelHeight] = useState<number>(() => loadWorkspacePanelHeight())
  const workspacePanelHeightRef = useRef(workspacePanelHeight)
  workspacePanelHeightRef.current = workspacePanelHeight
  const clampWorkspacePanelHeight = (value: number): number =>
    Math.min(WORKSPACE_PANEL_HEIGHT.max, Math.max(WORKSPACE_PANEL_HEIGHT.min, Math.round(value)))

  const effectiveWorkspacePanelHeight = (aside: HTMLElement | null): number => {
    if (workspacePanelHeightRef.current > 0) return workspacePanelHeightRef.current
    // Unset: measure the panel as currently laid out so the first drag
    // starts from what is on screen instead of jumping.
    const measured = aside?.querySelector<HTMLElement>('[data-testid="workspace-panel"]')?.clientHeight ?? 0
    return measured > 0 ? measured : 260
  }

  const startWorkspacePanelResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const aside = event.currentTarget.closest('aside')
    const startY = event.clientY
    const startHeight = effectiveWorkspacePanelHeight(aside)
    let latest = startHeight
    const onMove = (move: globalThis.PointerEvent): void => {
      latest = clampWorkspacePanelHeight(startHeight + move.clientY - startY)
      setWorkspacePanelHeight(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      saveWorkspacePanelHeight(latest)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const onWorkspacePanelResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let next: number | undefined
    if (event.key === 'ArrowDown') next = effectiveWorkspacePanelHeight(event.currentTarget.closest('aside')) + step
    else if (event.key === 'ArrowUp') next = effectiveWorkspacePanelHeight(event.currentTarget.closest('aside')) - step
    else if (event.key === 'Home') next = WORKSPACE_PANEL_HEIGHT.min
    else if (event.key === 'End') next = WORKSPACE_PANEL_HEIGHT.max
    if (next === undefined) return
    event.preventDefault()
    const clamped = clampWorkspacePanelHeight(next)
    setWorkspacePanelHeight(clamped)
    saveWorkspacePanelHeight(clamped)
  }

  const resetWorkspacePanelHeight = (): void => {
    setWorkspacePanelHeight(0)
    saveWorkspacePanelHeight(0)
  }

  useEffect(() => {
    setTheme(readStoredTheme())
  }, [setTheme])

  // Browser-persisted run defaults (mode/model/pool/max-iterations…) seed the
  // composer first; the gateway session fetch below then overlays the values
  // it shares with the CLI, so the server stays the source of truth and the
  // browser values only fill gaps (or a disconnected gateway).
  useEffect(() => {
    const prefs = loadComposerPrefs()
    if (Object.keys(prefs).length > 0) setComposer(prefs)
  }, [setComposer])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    applyPaletteVars(theme === 'daedalus-light' ? 'light' : 'dark')
  }, [theme])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [settings, providers, models] = await Promise.allSettled([api.settings(), api.providers(), api.models()])
      if (cancelled) return
      if (settings.status === 'fulfilled') {
        setSession(settings.value.session)
        if (settings.value.providers) setProviders(settings.value.providers)
      }
      if (providers.status === 'fulfilled') setProviders(providers.value.providers, providers.value.presets)
      if (models.status === 'fulfilled') setModels(models.value.models)
    })()
    return () => {
      cancelled = true
    }
  }, [setModels, setProviders, setSession])

  // Restore the workspace's chat conversation: the browser remembers which
  // one was open (localStorage), falling back to the newest on the server,
  // so a reload returns to the same session instead of an empty panel.
  useEffect(() => {
    if (!workspaceRoot) return
    if (useDaedalusStore.getState().conversation?.root === workspaceRoot) return
    let cancelled = false
    void (async () => {
      const savedId = loadActiveConversationId(workspaceRoot)
      if (savedId) {
        try {
          const { conversation } = await api.getConversation(workspaceRoot, savedId)
          if (!cancelled) setConversation(conversation)
          return
        } catch {
          /* pointer is stale (deleted/never existed) — fall back to newest */
        }
      }
      try {
        const { conversations } = await api.listConversations(workspaceRoot)
        const latest = conversations[0]
        if (!cancelled && latest) {
          setConversation(latest)
          saveActiveConversationId(workspaceRoot, latest.id)
        }
      } catch {
        /* gateway unreachable: the panel stays task-only for now */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, setConversation])

  return (
    <div className="flex h-full flex-col bg-surface-base text-foreground" data-testid="app-shell" data-theme={theme}>
      <TopBar />
      <Composer />
      <PlanChipsBar />

      <main
        className="relative grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 lg:grid-cols-[var(--daedalus-col-left)_minmax(0,1fr)_var(--daedalus-col-right)] lg:overflow-hidden"
        style={{ '--daedalus-col-left': `${columns.left}px`, '--daedalus-col-right': `${columns.right}px` } as CSSProperties}
      >
        {/* Column resize handles — only meaningful in the wide layout. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="resize left column"
          aria-valuemin={COLUMN_WIDTHS.left.min}
          aria-valuemax={COLUMN_WIDTHS.left.max}
          aria-valuenow={columns.left}
          tabIndex={0}
          data-testid="column-resize-left"
          onPointerDown={startColumnResize('left')}
          onKeyDown={onColumnKeyDown('left')}
          className="absolute top-2 bottom-2 z-10 hidden w-2 cursor-col-resize touch-none rounded hover:bg-primary/30 focus:bg-primary/30 focus:outline-none lg:block"
          style={{ left: `calc(${columns.left}px + 4px)` }}
          title="Drag to resize the left column"
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="resize right column"
          aria-valuemin={COLUMN_WIDTHS.right.min}
          aria-valuemax={COLUMN_WIDTHS.right.max}
          aria-valuenow={columns.right}
          tabIndex={0}
          data-testid="column-resize-right"
          onPointerDown={startColumnResize('right')}
          onKeyDown={onColumnKeyDown('right')}
          className="absolute top-2 bottom-2 z-10 hidden w-2 cursor-col-resize touch-none rounded hover:bg-primary/30 focus:bg-primary/30 focus:outline-none lg:block"
          style={{ right: `calc(${columns.right}px + 4px)` }}
          title="Drag to resize the right column"
        />
        {/* Left column: workspace + agent state. The workspace panel takes a
            flexible share (or a pinned height from the divider below it) and
            the scroll stack takes the rest; each is bounded by the column
            and scrolls internally — the workspace panel used to sit at its
            natural (content) height and push this scroll region to zero. */}
        <aside className="flex min-h-0 flex-col gap-2 lg:overflow-hidden">
          <WorkspacePanel
            className={workspacePanelHeight > 0 ? 'min-h-0 shrink-0' : 'min-h-0 lg:flex-1'}
            style={workspacePanelHeight > 0 ? { height: `${workspacePanelHeight}px` } : undefined}
          />
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="resize workspace panel"
            aria-valuemin={WORKSPACE_PANEL_HEIGHT.min}
            aria-valuemax={WORKSPACE_PANEL_HEIGHT.max}
            aria-valuenow={workspacePanelHeight > 0 ? workspacePanelHeight : undefined}
            tabIndex={0}
            data-testid="workspace-resize-handle"
            onPointerDown={startWorkspacePanelResize}
            onDoubleClick={resetWorkspacePanelHeight}
            onKeyDown={onWorkspacePanelResizeKeyDown}
            className="group flex h-2 shrink-0 cursor-ns-resize touch-none items-center justify-center rounded hover:bg-primary/20 focus:bg-primary/20 focus:outline-none"
            title="Drag to resize the workspace panel (double-click resets, arrow keys work too)"
          >
            <span className="h-0.5 w-10 rounded bg-line group-hover:bg-primary" />
          </div>
          <ScrollArea className="min-h-[240px] lg:min-h-0 lg:flex-1">
            <div className="flex flex-col gap-2 pr-1">
              <ExtensionsPanel />
              <PlanPanel />
              <ActivityTimeline />
              <ValidationPanel />
              <RecoveryPanel />
              <ErrorPanel />
            </div>
          </ScrollArea>
        </aside>

        {/* Center: code surface + terminal */}
        <section className="flex min-h-[420px] min-w-0 flex-col gap-2 rounded-md border border-line bg-surface-base lg:min-h-0">
          <EditorPane
            path={openFilePath}
            content={workspace.content}
            loading={workspace.loading}
            error={workspace.error}
            size={workspace.size}
            root={workspace.root}
            kind={workspace.kind}
            imageSrc={workspace.imageSrc}
            mediaType={workspace.mediaType}
            onSaved={(path, content) => {
              setWorkspace({ path, content, size: new TextEncoder().encode(content).length, loading: false, error: null, kind: 'text', imageSrc: null, mediaType: null })
              bumpWorkspaceRevision()
            }}
          />
          <TerminalPane />
        </section>

        {/* Right: conversation + changes + final result */}
        <aside className="flex min-h-0 flex-col gap-2 lg:overflow-hidden">
          <ChatPanel />
          <ScrollArea className="min-h-[320px] lg:min-h-0 lg:flex-1">
            <div className="flex flex-col gap-2 pr-1">
              <DiffViewer />
              <AttachmentsPanel />
              <ChildTasksPanel />
              <FinalReportView report={report} />
              <p className="pb-2 text-center text-[9px] uppercase tracking-wider text-muted">daedalus core {VERSION}</p>
            </div>
          </ScrollArea>
        </aside>
      </main>

      {settingsOpen ? <SettingsDialog /> : null}
    </div>
  )
}

export default App