import { create } from 'zustand'
import type { Event, FinalReport } from '@daedalus/core'
import type { StreamStatus } from '../api/eventStream'
import type { TaskSummary } from '../api/types'

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
  autoApprove: boolean
  maxIterations: number
  submitting: boolean
  error: string | null
}

export type DaedalusState = {
  connection: StreamStatus
  reconnectAttempt: number
  tasks: TaskSummary[]
  taskId: string | null
  events: Event[]
  report: FinalReport | null
  workspace: WorkspaceState
  composer: ComposerState
  theme: 'daedalus-dark' | 'daedalus-light'
  openFilePath: string | null
  error: string | null

  setConnection: (status: StreamStatus, attempt?: number) => void
  setTasks: (tasks: TaskSummary[]) => void
  setTask: (taskId: string, goal?: string) => void
  appendEvent: (event: Event) => void
  seedEvents: (events: Event[]) => void
  setReport: (report: FinalReport | null) => void
  setWorkspace: (patch: Partial<WorkspaceState>) => void
  setComposer: (patch: Partial<ComposerState>) => void
  setTheme: (theme: 'daedalus-dark' | 'daedalus-light') => void
  setOpenFile: (path: string | null) => void
  setError: (error: string | null) => void
  reset: () => void
}

const initialWorkspace: WorkspaceState = { root: '', path: '', content: '', loading: false, error: null, size: 0 }
const initialComposer: ComposerState = { goal: '', autoApprove: false, maxIterations: 25, submitting: false, error: null }

export const useDaedalusStore = create<DaedalusState>((set) => ({
  connection: 'idle',
  reconnectAttempt: 0,
  tasks: [],
  taskId: null,
  events: [],
  report: null,
  workspace: initialWorkspace,
  composer: initialComposer,
  theme: 'daedalus-dark',
  openFilePath: null,
  error: null,

  setConnection: (connection, reconnectAttempt = 0) => set({ connection, reconnectAttempt }),
  setTasks: (tasks) => set({ tasks }),
  setTask: (taskId, goal) =>
    set((state) => ({
      taskId,
      events: [],
      report: null,
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
  setTheme: (theme) => set({ theme }),
  setOpenFile: (openFilePath) => set({ openFilePath }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      connection: 'idle',
      reconnectAttempt: 0,
      taskId: null,
      events: [],
      report: null,
      workspace: initialWorkspace,
      composer: initialComposer,
      openFilePath: null,
      error: null,
    }),
}))

/** Events for the active task in seq order — the single feed every panel reads. */
export function selectTaskEvents(state: DaedalusState): Event[] {
  if (!state.taskId) return []
  return state.events.filter((event) => event.task_id === state.taskId).sort((a, b) => a.seq - b.seq)
}