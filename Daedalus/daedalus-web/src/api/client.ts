import type { FinalReport, PermissionKey } from '@daedalus/core'
import type {
  FileChange,
  TaskSnapshot,
  TaskSummary,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceRoot,
  WorkspaceTreeNode,
} from './types'

/**
 * Thin REST client for the gateway. The web interface executes nothing: every
 * call is a command or a read against the server, which drives Daedalus Core.
 */

const BASE = (import.meta.env.VITE_DAEDALUS_API ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* keep the status text */
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text.length > 0 ? `?${text}` : ''
}

export type CreateTaskInput = {
  goal: string
  repo_path: string
  auto_approve?: boolean
  max_iterations?: number
  constraints?: string[]
  done_criteria?: string[]
}

export const api = {
  health: () => request<{ status: string; service: string; active_tasks: number }>('/health'),

  listTasks: () => request<{ tasks: TaskSummary[]; count: number }>('/tasks'),

  createTask: (input: CreateTaskInput) =>
    request<{ id: string; goal: string; repo_path: string; created_at: string }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  task: (taskId: string) => request<TaskSnapshot>(`/tasks/${encodeURIComponent(taskId)}`),

  report: (taskId: string) => request<{ report: FinalReport }>(`/tasks/${encodeURIComponent(taskId)}/report`),

  changes: (taskId: string) => request<{ changes: FileChange[]; count: number }>(`/tasks/${encodeURIComponent(taskId)}/changes`),

  cancelTask: (taskId: string) =>
    request<{ cancelled: boolean; task_id: string }>(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),

  approve: (taskId: string, key: PermissionKey, decision: 'grant' | 'deny', remember: boolean) =>
    request<{ success: boolean; decision: string; remember: boolean }>(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ key, decision, remember }),
    }),

  roots: () => request<{ roots: WorkspaceRoot[]; cwd: string }>('/workspace/roots'),

  tree: (root: string, path = '.', depth = 2) =>
    request<WorkspaceTreeNode>(`/workspace/tree${query({ root, path, depth })}`),

  list: (root: string, path = '.') => request<{ path: string; items: WorkspaceEntry[] }>(`/workspace/list${query({ root, path })}`),

  file: (root: string, path: string) => request<WorkspaceFile>(`/workspace/file${query({ root, path })}`),
}

export const apiBase = BASE