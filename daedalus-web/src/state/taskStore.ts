import { create } from 'zustand'
import type { AgentMode, Attachment, Event, FinalReport, ToolRules } from '@s3r3/core'
import type { StreamStatus, TerminalWireMessage } from '../api/eventStream'
import type { Conversation, ProviderModel, ProviderPreset, ProviderPublic, SessionState, TaskSummary, TerminalSession } from '../api/types'
import type { AnalysisDataset, AnalysisPlan, AnalysisRunResult } from '../api/client'
import type { ResearchPlanSpec, ResearchProgressEvent, ResearchReportView } from '../api/client'
import { composerPrefsOf, domainFromPathname, saveComposerPrefs, type WebDomain } from './prefs'

export type { WebDomain }

/**
 * Client state for the control plane. Only genuinely shared state lives here
 * (task list, active task, the event log, connection health); panel-local UI
 * state stays in the components (Zustand is used where the architecture needs it).
 */

export type WorkspaceState = {
  root: string
  path: string
  content: string
  loading: boolean
  error: string | null
  size: number
  kind: 'text' | 'image'
  imageSrc: string | null
  mediaType: string | null
}

export type ComposerState = {
  goal: string
  mode: AgentMode
  providerId: string
  model: string
  autoApprove: boolean
  /** Per-task token budget (positive int); undefined = no cap. */
  tokenBudget: number | undefined
  /** One-shot model override for the next task, `providerId::model`; '' = follow the session model. */
  taskModel: string
  /** Per-task tool approval rules; empty lists = no overrides. */
  toolRules: ToolRules
  attachments: Attachment[]
  submitting: boolean
  error: string | null
}

/** Dokumen composer choices: Ekstrak|Susun sub-mode (a composer switch, never an ask_user question), picked sources, DOCX re-layout target. */
export type DokumenOptions = {
  subMode: 'ekstrak' | 'susun'
  /** Workspace-relative source paths attached to the next task. */
  sources: string[]
  /** DOCX (workspace-relative) to re-layout; the prompt carries the style instruction. */
  docxPath: string | null
}

/** Canvas focus in the Dokumen domain: the field whose provenance is being inspected. */
export type DokumenFocus = {
  recordId: string
  field: string
  sourceId: string
  page: number
} | null

/**
 * Spreadsheet composer mode: 'susun' builds a workbook (the existing
 * blueprint → build → verify → export flow), 'analis' answers a
 * business question from a dataset (question + dataset → staged plan
 * → run → insight report). An explicit switch in the composer, never
 * an ask_user question — Slide's Standard|Smart picker is the model.
 */
export type SheetOptions = {
  mode: 'susun' | 'analis'
}

/** An analysis plan staged for review (Analis mode): the server's plan id plus its spec. */
export type StagedAnalysisPlan = {
  planId: string
  plan: AnalysisPlan
  /** Deterministic profiler output that grounded the planner (opaque to the web). */
  profiles: unknown
  complexity: string | null
}

/** Why an analysis run produced no report. */
export type AnalysisRunError = {
  /**
   * 'verify_failed' — the 422 gate verdict: issues are listed, no
   * report is shown. 'plan_expired' — the 410: the staged plan is
   * gone, the user re-creates it. 'error' — anything else.
   */
  code: 'verify_failed' | 'plan_expired' | 'error'
  message: string
  issues?: Array<{ message: string; [key: string]: unknown }>
}

/** Slide composer choices (Agentic Slide v2): explicit controls replace ask_user questions for count/language. */
export type SlideOptions = {
  generation: 'standard' | 'smart'
  /** Target slide count; null lets the agent decide (Presenton's "Auto"). */
  slideCount: number | null
  /** Content language label sent to the agent ('' = follow the prompt). */
  language: string
  /** Bundled template pre-picked for the next task; null = let the outline checkpoint ask. */
  templateId: string | null
  /** Built-in design template ("Template bawaan") pre-picked for the next task; always set (panel default), cleared by an imported pick. */
  designId: string | null
  /** Imported PPT template (Template dari PPT) pre-picked for the next task; wins over templateId and is cleared when a bundled pick is made. */
  customTemplateId: string | null
}

export type TerminalState = {
  sessions: TerminalSession[]
  /** session id → accumulated output (server buffer is the authority; this mirrors it live). */
  buffers: Record<string, string>
  activeId: string | null
  /** WS replay requester, registered by the event-stream owner while connected. */
  subscribe: ((sessionId: string) => void) | null
}

export type DaedalusState = {
  connection: StreamStatus
  reconnectAttempt: number
  tasks: TaskSummary[]
  taskId: string | null
  /** The active chat conversation (turns included); null for task-only views. */
  conversation: Conversation | null
  events: Event[]
  report: FinalReport | null
  terminals: TerminalState
  workspace: WorkspaceState
  composer: ComposerState
  session: SessionState | null
  providers: ProviderPublic[]
  providerPresets: ProviderPreset[]
  models: ProviderModel[]
  taskAttachments: Attachment[]
  settingsOpen: boolean
  workspaceRevision: number
  theme: 'daedalus-dark' | 'daedalus-light'
  /** Active product domain: shared core/workspace, different center canvas. */
  domain: WebDomain
  /** Selected slide in the open deck (clamped by the deck hook when read). */
  slideIndex: number
  /** Slide composer choices (Agentic Slide v2): generation flow, target count (null = auto), content language ('' = auto), pre-picked template. */
  slideOptions: SlideOptions
  /** Dokumen composer choices (Ekstrak|Susun, picked sources, DOCX re-layout target). */
  dokumenOptions: DokumenOptions
  /** Field whose provenance the Dokumen canvas is showing (null = none). */
  dokumenFocus: DokumenFocus
  /** Spreadsheet composer choices (Susun|Analis mode switch). */
  sheetOptions: SheetOptions
  /** Analis mode: the dataset staged for the next plan (CSV text / XLSX base64 / current workbook). */
  analysisDataset: AnalysisDataset | null
  /** Analis mode: true while POST /sheets/analyze/plan is in flight. */
  analysisPlanning: boolean
  /** Analis mode: the last plan failure, cleared on the next attempt. */
  analysisPlanError: string | null
  /** Analis mode: the staged plan under review in the Blueprint panel. */
  analysisPlan: StagedAnalysisPlan | null
  /** Analis mode: true while POST /sheets/analyze/run is in flight. */
  analysisRunning: boolean
  /** Analis mode: the last run's verify verdict + insight report. */
  analysisResult: AnalysisRunResult | null
  /** Analis mode: why the last run produced no report (422/410/other). */
  analysisRunError: AnalysisRunError | null
  /** Research: the staged plan under review in the left panel (single confirmation gate). */
  researchPlan: ResearchPlanSpec | null
  /** Research: planId of the staged plan (for the run gate + progress polling). */
  researchPlanId: string | null
  /** Research: true while POST /research/plan is in flight. */
  researchPlanning: boolean
  /** Research: the last plan failure, cleared on the next attempt. */
  researchPlanError: string | null
  /** Research: true while POST /research/run is in flight. */
  researchRunning: boolean
  /** Research: live progress events polled from the server while running. */
  researchProgress: ResearchProgressEvent[]
  /** Research: the last completed report (center panel). */
  researchReport: ResearchReportView | null
  /** Research: why the last run produced no report (422/410/other). */
  researchRunError: string | null
  /** Research: source ids lit up by claim-trace (click a claim → sources glow). */
  researchTraceSourceIds: string[]
  /** Research: sumber yang sedang di-preview inline di panel tengah (null = laporan). */
  researchPreviewSourceId: string | null
  openFilePath: string | null
  error: string | null

  setConnection: (status: StreamStatus, attempt?: number) => void
  setTasks: (tasks: TaskSummary[]) => void
  setTask: (taskId: string, goal?: string) => void
  setConversation: (conversation: Conversation | null) => void
  appendEvent: (event: Event) => void
  seedEvents: (events: Event[]) => void
  setReport: (report: FinalReport | null) => void
  setWorkspace: (patch: Partial<WorkspaceState>) => void
  setComposer: (patch: Partial<ComposerState>) => void
  setSession: (session: SessionState | null) => void
  setProviders: (providers: ProviderPublic[], presets?: ProviderPreset[]) => void
  setModels: (models: ProviderModel[]) => void
  setTaskAttachments: (attachments: Attachment[]) => void
  addAttachments: (attachments: Attachment[]) => void
  removeAttachment: (id: string) => void
  setSettingsOpen: (open: boolean) => void
  setTerminalSessions: (sessions: TerminalSession[]) => void
  upsertTerminalSession: (session: TerminalSession) => void
  removeTerminalSession: (id: string) => void
  setActiveTerminal: (id: string | null) => void
  setTerminalSubscribe: (subscribe: ((sessionId: string) => void) | null) => void
  applyTerminalMessage: (message: TerminalWireMessage) => void
  bumpWorkspaceRevision: () => void
  setTheme: (theme: 'daedalus-dark' | 'daedalus-light') => void
  setDomain: (domain: WebDomain) => void
  setSlideIndex: (index: number) => void
  setSlideOptions: (patch: Partial<SlideOptions>) => void
  setDokumenOptions: (patch: Partial<DokumenOptions>) => void
  setDokumenFocus: (focus: DokumenFocus) => void
  setSheetOptions: (patch: Partial<SheetOptions>) => void
  setAnalysisDataset: (dataset: AnalysisDataset | null) => void
  setAnalysisPlanning: (planning: boolean) => void
  setAnalysisPlanError: (error: string | null) => void
  setAnalysisPlan: (plan: StagedAnalysisPlan | null) => void
  setAnalysisRunning: (running: boolean) => void
  setAnalysisResult: (result: AnalysisRunResult | null) => void
  setAnalysisRunError: (error: AnalysisRunError | null) => void
  /** Clear a staged plan and its run outcome (the staged dataset is kept for a retry). */
  clearAnalysis: () => void
  setResearchPlan: (planId: string | null, plan: ResearchPlanSpec | null) => void
  setResearchPlanning: (planning: boolean) => void
  setResearchPlanError: (error: string | null) => void
  setResearchRunning: (running: boolean) => void
  setResearchProgress: (events: ResearchProgressEvent[]) => void
  setResearchReport: (report: ResearchReportView | null) => void
  setResearchRunError: (error: string | null) => void
  setResearchTraceSourceIds: (ids: string[]) => void
  setResearchPreviewSourceId: (sourceId: string | null) => void
  /** Clear the staged research plan and its run outcome. */
  clearResearch: () => void
  setOpenFile: (path: string | null) => void
  setError: (error: string | null) => void
  reset: () => void
}

const initialWorkspace: WorkspaceState = { root: '', path: '', content: '', loading: false, error: null, size: 0, kind: 'text', imageSrc: null, mediaType: null }
const initialComposer: ComposerState = {
  goal: '',
  mode: 'auto',
  providerId: '',
  model: '',
  autoApprove: false,
  tokenBudget: undefined,
  taskModel: '',
  toolRules: { allow: [], ask: [], deny: [] },
  attachments: [],
  submitting: false,
  error: null,
}

const initialTerminals: TerminalState = { sessions: [], buffers: {}, activeId: null, subscribe: null }

/**
 * Initial domain comes from the route (see domainFromPathname): the URL
 * names the domain, so a '/slide' link opens Slide even when the persisted
 * pref says Coding — the pathname wins over localStorage.
 */
function initialDomain(): WebDomain {
  return typeof window !== 'undefined' ? domainFromPathname(window.location.pathname) : 'coding'
}

/** Client mirror of the server's ring buffer (same cap, same marker spirit). */
const TERMINAL_BUFFER_CAP = 200_000
function capBuffer(text: string): string {
  return text.length <= TERMINAL_BUFFER_CAP ? text : text.slice(-TERMINAL_BUFFER_CAP)
}

export const useDaedalusStore = create<DaedalusState>((set) => ({
  connection: 'idle',
  reconnectAttempt: 0,
  tasks: [],
  taskId: null,
  conversation: null,
  events: [],
  report: null,
  terminals: initialTerminals,
  workspace: initialWorkspace,
  composer: initialComposer,
  session: null,
  providers: [],
  providerPresets: [],
  models: [],
  taskAttachments: [],
  settingsOpen: false,
  workspaceRevision: 0,
  theme: 'daedalus-dark',
  domain: initialDomain(),
  slideIndex: 0,
  slideOptions: { generation: 'standard', slideCount: null, language: '', templateId: null, designId: 'standar', customTemplateId: null },
  dokumenOptions: { subMode: 'ekstrak', sources: [], docxPath: null },
  dokumenFocus: null,
  sheetOptions: { mode: 'susun' },
  analysisDataset: null,
  analysisPlanning: false,
  analysisPlanError: null,
  analysisPlan: null,
  analysisRunning: false,
  analysisResult: null,
  analysisRunError: null,
  researchPlan: null,
  researchPlanId: null,
  researchPlanning: false,
  researchPlanError: null,
  researchRunning: false,
  researchProgress: [],
  researchReport: null,
  researchRunError: null,
  researchTraceSourceIds: [],
  researchPreviewSourceId: null,
  openFilePath: null,
  error: null,

  setConnection: (connection, reconnectAttempt = 0) => set({ connection, reconnectAttempt }),
  setTasks: (tasks) => set({ tasks }),
  setConversation: (conversation) => set({ conversation }),
  setTask: (taskId, goal) =>
    set((state) => ({
      taskId,
      events: [],
      report: null,
      taskAttachments: [],
      openFilePath: null,
      workspace: { ...initialWorkspace, root: state.workspace.root },
      ...(goal === undefined ? {} : { composer: { ...state.composer, goal } }),
    })),
  appendEvent: (event) =>
    set((state) => {
      if (state.events.some((existing) => existing.task_id === event.task_id && existing.seq === event.seq)) return state
      // Any recorded file change — the selected task's own writes and the
      // mirrored copies of orchestrator children's writes alike — bumps
      // the workspace revision so the file tree refreshes on agent writes,
      // not only on editor saves. A finished task bumps once more as the
      // safety net: writes that produce no per-file event (binary
      // artifacts like an exported .pptx) still refresh the trees when
      // the run ends instead of leaving a stale panel.
      return {
        events: [...state.events, event],
        ...(event.type === 'FILE_CHANGED' || event.type === 'TASK_COMPLETED' ? { workspaceRevision: state.workspaceRevision + 1 } : {}),
      }
    }),
  seedEvents: (events) =>
    set((state) => {
      const seen = new Set(state.events.map((event) => `${event.task_id}:${event.seq}`))
      const additions = events.filter((event) => !seen.has(`${event.task_id}:${event.seq}`))
      return additions.length === 0 ? state : { events: [...state.events, ...additions] }
    }),
  setReport: (report) => set({ report }),
  setWorkspace: (patch) => set((state) => ({ workspace: { ...state.workspace, ...patch } })),
  setComposer: (patch) => set((state) => ({ composer: { ...state.composer, ...patch } })),
  setSession: (session) =>
    set((state) => ({
      session,
      ...(session
        ? {
            composer: {
              ...state.composer,
              mode: session.mode,
              autoApprove: session.autoApprove,
              providerId: session.providerId ?? state.composer.providerId,
              model: session.model ?? state.composer.model,
            },
            workspace: { ...state.workspace, root: session.workspaceRoot || state.workspace.root },
          }
        : {}),
    })),
  setProviders: (providers, presets) =>
    set(() => ({ providers, ...(presets ? { providerPresets: presets } : {}) })),
  setModels: (models) => set({ models }),
  setTaskAttachments: (taskAttachments) => set({ taskAttachments }),
  addAttachments: (attachments) =>
    set((state) => {
      const known = new Set(state.composer.attachments.map((attachment) => attachment.id))
      return { composer: { ...state.composer, attachments: [...state.composer.attachments, ...attachments.filter((a) => !known.has(a.id))] } }
    }),
  removeAttachment: (id) =>
    set((state) => ({ composer: { ...state.composer, attachments: state.composer.attachments.filter((attachment) => attachment.id !== id) } })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setTerminalSessions: (sessions) =>
    set((state) => ({
      terminals: {
        ...state.terminals,
        sessions,
        activeId:
          state.terminals.activeId && sessions.some((session) => session.id === state.terminals.activeId)
            ? state.terminals.activeId
            : (sessions.find((session) => session.kind === 'agent')?.id ?? sessions[0]?.id ?? null),
      },
    })),
  upsertTerminalSession: (session) =>
    set((state) => {
      const known = state.terminals.sessions.some((existing) => existing.id === session.id)
      return {
        terminals: {
          ...state.terminals,
          sessions: known
            ? state.terminals.sessions.map((existing) => (existing.id === session.id ? session : existing))
            : [...state.terminals.sessions, session],
          activeId: state.terminals.activeId ?? session.id,
        },
      }
    }),
  removeTerminalSession: (id) =>
    set((state) => {
      const sessions = state.terminals.sessions.filter((session) => session.id !== id)
      const buffers = { ...state.terminals.buffers }
      delete buffers[id]
      return {
        terminals: {
          ...state.terminals,
          sessions,
          buffers,
          activeId: state.terminals.activeId === id ? (sessions.find((s) => s.kind === 'agent')?.id ?? sessions[0]?.id ?? null) : state.terminals.activeId,
        },
      }
    }),
  setActiveTerminal: (activeId) => set((state) => ({ terminals: { ...state.terminals, activeId } })),
  setTerminalSubscribe: (subscribe) => set((state) => ({ terminals: { ...state.terminals, subscribe } })),
  applyTerminalMessage: (message) =>
    set((state) => {
      if (message.kind === 'terminal_status') {
        const known = state.terminals.sessions.some((existing) => existing.id === message.session.id)
        return {
          terminals: {
            ...state.terminals,
            sessions: known
              ? state.terminals.sessions.map((existing) => (existing.id === message.session.id ? message.session : existing))
              : [...state.terminals.sessions, message.session],
            activeId: state.terminals.activeId ?? message.session.id,
          },
        }
      }
      const current = state.terminals.buffers[message.session_id] ?? ''
      const next = message.replay ? message.data : capBuffer(current + message.data)
      if (!message.replay && next === current) return state
      return { terminals: { ...state.terminals, buffers: { ...state.terminals.buffers, [message.session_id]: next } } }
    }),
  bumpWorkspaceRevision: () => set((state) => ({ workspaceRevision: state.workspaceRevision + 1 })),
  setTheme: (theme) => set({ theme }),
  setDomain: (domain) => set({ domain }),
  setSlideIndex: (slideIndex) => set({ slideIndex: Number.isFinite(slideIndex) ? Math.max(0, Math.floor(slideIndex)) : 0 }),
  setSlideOptions: (patch) => set((state) => ({ slideOptions: { ...state.slideOptions, ...patch } })),
  setDokumenOptions: (patch: Partial<DokumenOptions>) => set((state) => ({ dokumenOptions: { ...state.dokumenOptions, ...patch } })),
  setDokumenFocus: (focus: DokumenFocus) => set({ dokumenFocus: focus }),
  setSheetOptions: (patch) => set((state) => ({ sheetOptions: { ...state.sheetOptions, ...patch } })),
  setAnalysisDataset: (dataset) => set({ analysisDataset: dataset }),
  setAnalysisPlanning: (planning) => set({ analysisPlanning: planning }),
  setAnalysisPlanError: (error) => set({ analysisPlanError: error }),
  setAnalysisPlan: (plan) => set({ analysisPlan: plan }),
  setAnalysisRunning: (running) => set({ analysisRunning: running }),
  setAnalysisResult: (result) => set({ analysisResult: result }),
  setAnalysisRunError: (error) => set({ analysisRunError: error }),
  clearAnalysis: () =>
    set({ analysisPlanning: false, analysisPlanError: null, analysisPlan: null, analysisRunning: false, analysisResult: null, analysisRunError: null }),
  setResearchPlan: (planId, plan) => set({ researchPlanId: planId, researchPlan: plan }),
  setResearchPlanning: (planning) => set({ researchPlanning: planning }),
  setResearchPlanError: (error) => set({ researchPlanError: error }),
  setResearchRunning: (running) => set({ researchRunning: running }),
  setResearchProgress: (events) => set({ researchProgress: events }),
  setResearchReport: (report) => set({ researchReport: report }),
  setResearchRunError: (error) => set({ researchRunError: error }),
  setResearchTraceSourceIds: (ids) => set({ researchTraceSourceIds: ids }),
  setResearchPreviewSourceId: (sourceId) => set({ researchPreviewSourceId: sourceId }),
  clearResearch: () =>
    set({
      researchPlan: null, researchPlanId: null, researchPlanning: false, researchPlanError: null,
      researchRunning: false, researchProgress: [], researchReport: null, researchRunError: null,
      researchTraceSourceIds: [], researchPreviewSourceId: null,
    }),
  setOpenFile: (openFilePath) => set({ openFilePath }),
  setError: (error) => set({ error }),
  reset: () =>
    set((state) => ({
      connection: 'idle',
      reconnectAttempt: 0,
      tasks: [],
      taskId: null,
      conversation: null,
      events: [],
      report: null,
      terminals: { ...initialTerminals, subscribe: state.terminals.subscribe },
      workspace: initialWorkspace,
      composer: initialComposer,
      session: null,
      providers: [],
      providerPresets: [],
      models: [],
      taskAttachments: [],
      settingsOpen: false,
      workspaceRevision: 0,
      domain: initialDomain(),
      slideIndex: 0,
      slideOptions: { generation: 'standard', slideCount: null, language: '', templateId: null, designId: 'standar', customTemplateId: null },
  dokumenOptions: { subMode: 'ekstrak', sources: [], docxPath: null },
  dokumenFocus: null,
  sheetOptions: { mode: 'susun' },
  analysisDataset: null,
  analysisPlanning: false,
  analysisPlanError: null,
  analysisPlan: null,
  analysisRunning: false,
  analysisResult: null,
  analysisRunError: null,
  researchPlan: null,
  researchPlanId: null,
  researchPlanning: false,
  researchPlanError: null,
  researchRunning: false,
  researchProgress: [],
  researchReport: null,
  researchRunError: null,
  researchTraceSourceIds: [],
      openFilePath: null,
      error: null,
    })),
}))

/** Events for the active task in seq order — the single feed every panel reads. */
export function selectTaskEvents(state: DaedalusState): Event[] {
  if (!state.taskId) return []
  return state.events.filter((event) => event.task_id === state.taskId).sort((a, b) => a.seq - b.seq)
}

// Run defaults persist in this browser (see prefs.ts): every composer change
// is saved, and App hydrates them back on load before the gateway session
// overlays its shared values, so what the settings panel shows is what the
// next task payload carries.
useDaedalusStore.subscribe((state, previous) => {
  if (state.composer !== previous.composer) saveComposerPrefs(composerPrefsOf(state.composer))
})