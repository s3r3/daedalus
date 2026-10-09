import type { AgentMode, Attachment, Event, FinalReport, PermissionKey } from '@daedalus/core'
import type {
  Conversation,
  FileChange,
  ProviderInput,
  ProviderConfigPublic,
  ProviderModel,
  ProviderPreset,
  ProviderTestResult,
  ReviewResponse,
  SessionState,
  SettingsResponse,
  ExtensionStatus,
  TaskAttachmentsResponse,
  TaskSnapshot,
  TaskSummary,
  UploadResponse,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceGitStatus,
  WorkspaceFiles,
  WorkspacePins,
  WorkspacePlans,
  WorkspaceRoot,
  WorkspaceTreeNode,
  TerminalSession,
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
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: isFormData ? { ...(init?.headers ?? {}) } : { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      // Prefer the server's human sentence when it sends one (e.g. the
      // task-ended question answer); machine error tokens are a last
      // resort, never what the user should read.
      if (body.message) message = body.message
      else if (body.error) message = body.error
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
  /** Domain produk aktif saat submit ('coding'|'slide'); server meneruskannya ke core agar task berjalan dengan toolset domain tersebut. */
  domain?: 'coding' | 'slide'
  auto_approve?: boolean
  max_iterations?: number
  constraints?: string[]
  done_criteria?: string[]
  mode?: AgentMode
  thinking?: boolean
  provider_id?: string
  model?: string
  /** Model pool (2+ models): core routes across them with model_strategy. */
  models?: string[]
  model_strategy?: 'failover' | 'round-robin'
  attachments?: Attachment[]
  isolation?: 'worktree'
  /** Follow up on a plan drafted by this earlier task; core injects its steps as a constraint. */
  plan_task_id?: string
  /** Chat conversation this submit belongs to; the server records the turns and feeds back the history. */
  conversation_id?: string
  /** Skill names explicitly invoked for this task (composer `/skill <name>`); the server validates them and core force-loads their bodies. */
  skills?: string[]
  /** Slide composer parameters (Agentic Slide v2); only sent in the slide domain, validated by the server. */
  slide?: { generation?: 'smart' | 'standard'; slide_count?: number; language?: string; template_id?: string }
}

/** One bundled slide template (design direction) from GET /slides/templates. */
export type SlideTemplateInfo = {
  id: string
  name: string
  description: string
  theme: { accent?: string; dark?: boolean; background?: string; surface?: string; text?: string; muted?: string; headingFont?: string; bodyFont?: string; templateId?: string }
}

export type DeckExportResult = { root: string; path: string; bytes: number; slides: number }
/** A deck image asset saved through POST /slides/deck/asset (deck/assets/). */
export type DeckAssetUploadResult = { root: string; name: string; path: string; size: number }

/** Verdict of POST /slides/deck/reset (Slide new chat's deck reset). */
export type DeckResetResult = {
  root: string
  /** Workspace-relative archive path (`.daedalus/deck-archive/<timestamp>`) of the deck moved aside, null when there was no deck. */
  archived: string | null
  /** True when a staged outline run was settled to make room for the fresh start. */
  staged_abandoned: boolean
}

/** Verdict of POST /slides/deck/generate (the Outline panel's Buat button). */
export type DeckGenerateResult = {
  root: string
  task_id?: string
  outcome: 'success' | 'partial' | 'failed'
  summary: string
  exported: { path: string; bytes: number; slides: number } | null
}

export const api = {
  health: () => request<{ status: string; service: string; active_tasks: number }>('/health'),

  settings: () => request<SettingsResponse>('/settings'),

  updateSettings: (input: Record<string, unknown>) =>
    request<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(input) }),

  session: () => request<{ session: SessionState }>('/session'),

  updateSession: (input: Partial<SessionState> & Record<string, unknown>) =>
    request<{ session: SessionState }>('/session', { method: 'PUT', body: JSON.stringify(input) }),

  setMode: (mode: AgentMode) =>
    request<{ session: SessionState }>('/session/mode', { method: 'POST', body: JSON.stringify({ mode }) }),

  cycleMode: () => request<{ session: SessionState }>('/session/mode', { method: 'POST', body: JSON.stringify({ cycle: true }) }),

  setAutoApprove: (enabled: boolean) =>
    request<{ session: SessionState }>('/session/auto-approve', { method: 'POST', body: JSON.stringify({ enabled }) }),

  providers: () => request<{ providers: ProviderConfigPublic[]; presets: ProviderPreset[] }>('/providers'),

  createProvider: (input: ProviderInput) =>
    request<{ provider: ProviderConfigPublic }>('/providers', { method: 'POST', body: JSON.stringify(input) }),

  updateProvider: (id: string, input: ProviderInput) =>
    request<{ provider: ProviderConfigPublic }>(`/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteProvider: (id: string) => request<{ removed: boolean; id: string }>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setProviderEnabled: (id: string, enabled: boolean) =>
    request<{ provider: ProviderConfigPublic }>(`/providers/${encodeURIComponent(id)}/enabled`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  testProvider: (id: string) => request<ProviderTestResult>(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),

  models: (providerId?: string) =>
    request<{ models: ProviderModel[]; session: SessionState; count: number }>(`/models${query({ provider_id: providerId })}`),

  listTasks: () => request<{ tasks: TaskSummary[]; count: number }>('/tasks'),

  /** Start a fresh chat conversation for a workspace. */
  createConversation: (root: string) =>
    request<{ conversation: Conversation }>('/conversations', { method: 'POST', body: JSON.stringify({ root }) }),

  /** Load one conversation (turns included) to render/restore the session. */
  getConversation: (root: string, id: string) =>
    request<{ conversation: Conversation }>(`/conversations/${encodeURIComponent(id)}${query({ root })}`),

  /** Conversations for a workspace, newest first — used to restore the latest session. */
  listConversations: (root: string) =>
    request<{ conversations: Conversation[]; count: number; root: string }>(`/conversations${query({ root })}`),

  createTask: (input: CreateTaskInput) =>
    request<{ id: string; goal: string; repo_path: string; created_at: string }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  task: (taskId: string) => request<TaskSnapshot>(`/tasks/${encodeURIComponent(taskId)}`),

  taskEvents: (taskId: string) => request<{ events: Event[]; count: number; task: TaskSummary }>(`/tasks/${encodeURIComponent(taskId)}/events`),

  /** Bundled slide templates (design directions) shipped with the install. */
  slideTemplates: () => request<{ templates: SlideTemplateInfo[] }>('/slides/templates'),

  /** The workspace deck via the core-gated slide API (404 when no deck exists). */
  deck: (root: string) => request<{ root: string; deck: import('@daedalus/core').DeckSpec }>(`/slides/deck${query({ root })}`),

  /** Apply a bundled template (or accent/dark) to the open deck; the server validates and returns the fresh deck. */
  deckTheme: (root: string, input: { template_id?: string; accent?: string; dark?: boolean }) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec }>('/slides/deck/theme', {
      method: 'POST',
      body: JSON.stringify({ root, ...input }),
    }),

  deckAddSlide: (root: string, input: { layout: string; content?: Record<string, unknown>; index?: number }) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec; slide_id: string }>('/slides/deck/slide/add', {
      method: 'POST',
      body: JSON.stringify({ root, ...input }),
    }),

  deckRegenerateSlide: (root: string, slideId: string, input: { model?: string; provider_id?: string } = {}) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec; slide_id: string }>('/slides/deck/regenerate', {
      method: 'POST',
      body: JSON.stringify({ root, slide_id: slideId, ...input }),
    }),

  deckUpdateSlide: (root: string, slideId: string, input: { content?: Record<string, unknown>; layout?: string; positions?: Record<string, import('@daedalus/core').BlockPosition> | null }) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec }>('/slides/deck/slide/update', {
      method: 'POST',
      body: JSON.stringify({ root, slide_id: slideId, ...input }),
    }),

  deckDeleteSlide: (root: string, slideId: string) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec }>('/slides/deck/slide/delete', {
      method: 'POST',
      body: JSON.stringify({ root, slide_id: slideId }),
    }),

  deckMoveSlide: (root: string, slideId: string, toIndex: number) =>
    request<{ root: string; deck: import('@daedalus/core').DeckSpec }>('/slides/deck/slide/move', {
      method: 'POST',
      body: JSON.stringify({ root, slide_id: slideId, to_index: toIndex }),
    }),

  /**
   * Slide new chat's reset: archive the current deck aside (never
   * deleted) and settle any staged outline, so the next prompt starts
   * from an empty deck. Rejects while a generation is actively filling.
   */
  deckReset: (root: string) =>
    request<DeckResetResult>('/slides/deck/reset', { method: 'POST', body: JSON.stringify({ root }) }),

  /**
   * The Outline panel's Buat button: generate the staged outline deck
   * (fill → validate → export) with the settled template. The server
   * answers with the run's verdict once generation settles.
   */
  deckGenerate: (root: string, input: { template_id?: string } = {}) =>
    request<DeckGenerateResult>('/slides/deck/generate', {
      method: 'POST',
      body: JSON.stringify({ root, ...(input.template_id ? { template_id: input.template_id } : {}) }),
    }),

  /** Export the open deck to .pptx through core's native exporter. */
  deckExport: (root: string) =>
    request<DeckExportResult>('/slides/deck/export', { method: 'POST', body: JSON.stringify({ root }) }),

  /** Direct download URL for an exported deck file (deck/*.pptx). */
  deckDownloadUrl: (root: string, path: string) => `/slides/deck/download${query({ root, path })}`,
  deckAssetUrl: (root: string, name: string) => `/slides/deck/asset${query({ root, name })}`,
  deckUploadAsset: (root: string, file: File) => {
    const form = new FormData()
    form.set('root', root)
    form.set('file', file)
    return request<DeckAssetUploadResult>('/slides/deck/asset', { method: 'POST', body: form })
  },

  extensionsStatus: (root: string) => request<ExtensionStatus>(`/extensions/status${query({ root })}`),

  /** Enable/disable one skill for a workspace (writes the shared .daedalus/skills.json). */
  toggleSkill: (input: { root: string; name: string; disabled: boolean }) =>
    request<{ root: string; name: string; disabled: boolean; disabledSkills: string[] }>('/extensions/skills/toggle', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  review: (input: { root: string; task_id?: string; model?: string; provider_id?: string }) =>
    request<ReviewResponse>('/review', { method: 'POST', body: JSON.stringify(input) }),

  report: (taskId: string) => request<{ report: FinalReport }>(`/tasks/${encodeURIComponent(taskId)}/report`),

  changes: (taskId: string) => request<{ changes: FileChange[]; count: number }>(`/tasks/${encodeURIComponent(taskId)}/changes`),

  taskAttachments: (taskId: string) => request<TaskAttachmentsResponse>(`/tasks/${encodeURIComponent(taskId)}/attachments`),

  cancelTask: (taskId: string) =>
    request<{ cancelled: boolean; task_id: string }>(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),

  approve: (taskId: string, key: PermissionKey, decision: 'grant' | 'deny', remember: boolean) =>
    request<{ success: boolean; decision: string; remember: boolean }>(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ key, decision, remember }),
    }),

  /**
   * Decide one pending approval by its id. `allow_remember` stores the exact
   * pattern shown on the card for the rest of this server session; `decline`
   * can carry the user's redirect text, and a command can run edited args.
   */
  decideApproval: (
    taskId: string,
    approvalId: string,
    decision: 'allow' | 'allow_remember' | 'decline',
    extra?: { note?: string; editedArgs?: Record<string, unknown> },
  ) =>
    request<{ success: boolean; decision: string; approval_id: string }>(
      `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
      { method: 'POST', body: JSON.stringify({ decision, ...(extra ?? {}) }) },
    ),

  /**
   * Answer one pending user question (the Plan mode ask_user card): the
   * answer is delivered to the agent verbatim — a chosen option's label or
   * the user's own typed text.
   */
  answerQuestion: (taskId: string, questionId: string, answer: string) =>
    request<{ success: boolean; question_id: string }>(
      `/tasks/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(questionId)}`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),

  roots: () => request<{ roots: WorkspaceRoot[]; cwd: string }>('/workspace/roots'),

  tree: (root: string, path = '.', depth = 2) =>
    request<WorkspaceTreeNode>(`/workspace/tree${query({ root, path, depth })}`),

  list: (root: string, path = '.') => request<{ path: string; items: WorkspaceEntry[] }>(`/workspace/list${query({ root, path })}`),

  file: (root: string, path: string) => request<WorkspaceFile>(`/workspace/file${query({ root, path })}`),

  gitStatus: (root: string) => request<WorkspaceGitStatus>(`/workspace/git-status${query({ root })}`),

  gitRevert: (root: string, path: string) =>
    request<{ reverted: string; root: string }>('/workspace/git-revert', {
      method: 'POST',
      body: JSON.stringify({ root, path }),
    }),

  /** Plan documents the Plan-mode flow wrote under .daedalus/plans (chips above the composer). */
  plans: (root: string) => request<WorkspacePlans>(`/workspace/plans${query({ root })}`),

  files: (root: string) => request<WorkspaceFiles>(`/workspace/files${query({ root })}`),

  createWorkspace: (input: { root?: string; path?: string; name?: string }) =>
    request<{ path: string; name: string; root?: string; session: SessionState }>('/workspace/create', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  createFolder: (root: string, path: string) =>
    request<{ path: string; absolute: string; root: string }>('/workspace/folders', {
      method: 'POST',
      body: JSON.stringify({ root, path }),
    }),

  createFile: (root: string, path: string, content = '', overwrite = false) =>
    request<{ path: string; absolute: string; root: string; size: number }>('/workspace/files', {
      method: 'POST',
      body: JSON.stringify({ root, path, content, overwrite }),
    }),

  renameWorkspaceEntry: (root: string, from: string, to: string) =>
    request<{ from: string; to: string; root: string }>('/workspace/rename', {
      method: 'POST',
      body: JSON.stringify({ root, from, to }),
    }),

  saveFile: (root: string, path: string, content: string) =>
    request<{ path: string; absolute: string; root: string }>('/workspace/file', {
      method: 'PUT',
      body: JSON.stringify({ root, path, content }),
    }),

  pins: (root: string) => request<WorkspacePins>(`/workspace/pins${query({ root })}`),

  savePins: (root: string, pins: string[]) =>
    request<WorkspacePins>('/workspace/pins', { method: 'PUT', body: JSON.stringify({ root, pins }) }),

  /** Terminal sessions for one workspace root (the agent sink is ensured server-side). */
  terminals: (root: string) => request<{ terminals: TerminalSession[]; root: string }>(`/terminals${query({ root })}`),

  createTerminal: (input: { root: string; kind?: 'user' | 'agent'; title?: string }) =>
    request<{ terminal: TerminalSession }>('/terminals', { method: 'POST', body: JSON.stringify(input) }),

  terminal: (id: string) => request<{ terminal: TerminalSession; output: string }>(`/terminals/${encodeURIComponent(id)}`),

  terminalInput: (id: string, data: string) =>
    request<{ terminal: TerminalSession }>(`/terminals/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  terminalSignal: (id: string, signal: 'SIGINT' | 'SIGTERM') =>
    request<{ terminal: TerminalSession }>(`/terminals/${encodeURIComponent(id)}/signal`, {
      method: 'POST',
      body: JSON.stringify({ signal }),
    }),

  deleteTerminal: (id: string) =>
    request<{ killed: boolean; terminal: TerminalSession }>(`/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  upload: (form: FormData) => request<UploadResponse>('/uploads', { method: 'POST', body: form }),

  uploadJson: (input: Record<string, unknown>) => request<UploadResponse>('/uploads', { method: 'POST', body: JSON.stringify(input) }),
}

export const apiBase = BASE