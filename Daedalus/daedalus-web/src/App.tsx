import { useEffect } from 'react'
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
import { TerminalPane } from './components/terminal/terminal-pane'
import { ValidationPanel } from './components/validation/validation-panel'
import { ErrorPanel, RecoveryPanel } from './components/recovery/recovery-panel'
import { ApprovalCard } from './components/approval/approval-card'
import { AttachmentsPanel, ChildTasksPanel, FilesChangedPanel, FinalReportView, ValidationSummary } from './components/report/report-panels'
import { ScrollArea } from './components/ui/scroll-area'
import { useEventStream } from './api/useEventStream'
import { api } from './api/client'
import { readStoredTheme, applyPaletteVars } from './theme/theme'
import { useDaedalusStore } from './state/taskStore'
import { loadComposerPrefs } from './state/prefs'
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

  return (
    <div className="flex h-full flex-col bg-surface-base text-foreground" data-testid="app-shell" data-theme={theme}>
      <TopBar />
      <Composer />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 lg:grid-cols-[320px_minmax(0,1fr)_360px] lg:overflow-hidden">
        {/* Left column: workspace + agent state */}
        <aside className="flex min-h-0 flex-col gap-2 lg:overflow-hidden">
          <WorkspacePanel />
          <ScrollArea className="min-h-[240px] lg:min-h-0 lg:flex-1">
            <div className="flex flex-col gap-2 pr-1">
              <ExtensionsPanel />
              <PlanPanel />
              <ApprovalCard />
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
            onSaved={(path, content) => {
              setWorkspace({ path, content, size: new TextEncoder().encode(content).length, loading: false, error: null })
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
              <FilesChangedPanel />
              <ValidationSummary />
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