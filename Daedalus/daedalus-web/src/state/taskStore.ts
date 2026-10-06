import { create } from 'zustand'
import type { AgentMode, Attachment, Event, FinalReport, ProviderConfigPublic } from '@daedalus/core'
import type { StreamStatus, TerminalWireMessage } from '../api/eventStream'
import type { Conversation, ProviderModel, ProviderPreset, SessionState, TaskSummary, TerminalSession } from '../api/types'
import { composerPrefsOf, saveComposerPrefs } from './prefs'

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
}

export type ComposerState = {
  goal: string
  mode: AgentMode
  providerId: string
  model: string
  /** Comma-separated model pool; with 2+ models the task runs against the pool. */
  modelPool: string
  modelStrategy: 'failover' | 'round-robin'
  autoApprove: boolean
  thinking: boolean
  maxIterations: number
  attachments: Attachment[]
  submitting: boolean
  error: string | null
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
  providers: ProviderConfigPublic[]
  providerPresets: ProviderPreset[]
  models: ProviderModel[]
  taskAttachments: Attachment[]
  settingsOpen: boolean
  workspaceRevision: number
  theme: 'daedalus-dark' | 'daedalus-light'
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
  setProviders: (providers: ProviderConfigPublic[], presets?: ProviderPreset[]) => void
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
  setOpenFile: (path: string | null) => void
  setError: (error: string | null) => void
  reset: () => void
}

const initialWorkspace: WorkspaceState = { root: '', path: '', content: '', loading: false, error: null, size: 0 }
const initialComposer: ComposerState = {
  goal: '',
  mode: 'auto',
  providerId: '',
  model: '',
  modelPool: '',
  modelStrategy: 'failover',
  autoApprove: false,
  thinking: true,
  maxIterations: 25,
  attachments: [],
  submitting: false,
  error: null,
}

const initialTerminals: TerminalState = { sessions: [], buffers: {}, activeId: null, subscribe: null }

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
      return { events: [...state.events, event] }
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
              thinking: session.thinking !== false,
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