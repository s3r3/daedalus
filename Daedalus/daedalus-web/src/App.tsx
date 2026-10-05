import { useEffect } from 'react'
import { TopBar } from './components/layout/top-bar'
import { Composer } from './components/composer/composer'
import { WorkspacePanel } from './components/workspace/workspace-panel'
import { EditorPane } from './components/editor/editor-pane'
import { DiffViewer } from './components/editor/diff-viewer'
import { PlanPanel } from './components/agent/plan-panel'
import { ActivityTimeline } from './components/agent/activity-timeline'
import { TerminalPane } from './components/terminal/terminal-pane'
import { ValidationPanel } from './components/validation/validation-panel'
import { ErrorPanel, RecoveryPanel } from './components/recovery/recovery-panel'
import { ApprovalCard } from './components/approval/approval-card'
import { FilesChangedPanel, FinalReportView, ValidationSummary } from './components/report/report-panels'
import { ScrollArea } from './components/ui/scroll-area'
import { useEventStream } from './api/useEventStream'
import { readStoredTheme, applyPaletteVars } from './theme/theme'
import { useDaedalusStore } from './state/taskStore'
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

  useEffect(() => {
    setTheme(readStoredTheme())
  }, [setTheme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    applyPaletteVars(theme === 'daedalus-light' ? 'light' : 'dark')
  }, [theme])

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
          />
          <TerminalPane />
        </section>

        {/* Right: changes + final result */}
        <aside className="flex min-h-0 flex-col gap-2 lg:overflow-hidden">
          <ScrollArea className="min-h-[320px] lg:min-h-0 lg:flex-1">
            <div className="flex flex-col gap-2 pr-1">
              <DiffViewer />
              <FilesChangedPanel />
              <ValidationSummary />
              <FinalReportView report={report} />
              <p className="pb-2 text-center text-[9px] uppercase tracking-wider text-muted">daedalus core {VERSION}</p>
            </div>
          </ScrollArea>
        </aside>
      </main>
    </div>
  )
}

export default App