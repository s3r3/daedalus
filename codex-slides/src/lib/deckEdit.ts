// Client-side helpers shared by the home live workspace and /project/[id].
// Keeps per-slide editing ("逐页编辑") in one place so both surfaces behave the same.

import type { ContextItem } from "@/lib/contextItems";
import type { AgentToolCall } from "@/lib/agentActivity";
import type {
  DesignFileReference,
  DeckVersionCaptureInput,
  OutlinePage,
  PptConfig,
  ProgressEvent,
  Project,
  ProjectRunInput,
  ProjectRunState,
  ProjectWorkflowState,
  SlideTransition,
} from "@/lib/types";

export interface ProjectRunResponse {
  project: Project;
  activeRun: ProjectRunState | null;
  queued?: boolean;
  queue?: ProjectWorkflowState["queuedRequests"];
}

/** Start a project-owned job. The HTTP request only enqueues the work; the
 * server keeps executing after this component unmounts or the route changes. */
export async function startProjectRun(
  projectId: string,
  input: ProjectRunInput,
): Promise<ProjectRunResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    // The enqueue payload is small and must survive a route change that happens
    // immediately after the user starts generation.
    keepalive: true,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as ProjectRunResponse;
}

export async function stopProjectRun(projectId: string): Promise<ProjectRunResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
    method: "DELETE",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as ProjectRunResponse;
}

export interface UiSlide {
  index: number;
  title: string;
  status: "pending" | "working" | "described" | "rendered" | "error";
  image?: string;
  error?: string;
  bust?: number;
  transition?: SlideTransition;
  speakerNotes?: string;
}

/** Live activity shown in the chat column while the deck is being built or edited. */
export interface GenStatus {
  /** outlining → planning the deck; rendering → drawing pages; editing → applying an edit. */
  phase: "outlining" | "rendering" | "editing";
  total: number;
  done: number;
  /** 1-based index of the slide currently being drawn, if any. */
  current?: number;
  currentTitle?: string;
  /** short label for the editing phase, e.g. "Re-tuning the whole deck". */
  note?: string;
}

/** Derive the live GenStatus from slide state. Returns null when idle. */
export function deriveStatus(
  slides: UiSlide[],
  opts: { streaming?: boolean; editing?: boolean; note?: string } = {},
): GenStatus | null {
  const { streaming, editing, note } = opts;
  if (!streaming && !editing) return null;
  const done = slides.filter((s) => s.status === "rendered").length;
  const workingList = slides.filter((s) => s.status === "working");
  const working = workingList[0];
  if (streaming && slides.length === 0) {
    return { phase: "outlining", total: 0, done: 0 };
  }
  // Fast mode draws several pages at once; surface that instead of a single
  // "Drawing slide N" line so the card matches what the filmstrip shows.
  const parallelNote =
    !note && !editing && workingList.length > 1
      ? `并行绘制 ${workingList.length} 页中…`
      : note;
  return {
    phase: editing && !streaming ? "editing" : "rendering",
    total: slides.length,
    done,
    current: working?.index,
    currentTitle: working?.title,
    note: parallelNote,
  };
}

export function fileUrl(projectId: string, name?: string, bust?: number) {
  if (!projectId || !name) return "";
  return `/api/files/${projectId}/${name}${bust ? `?t=${bust}` : ""}`;
}

// ---- staged flow: outline (step 2-4) then render (step 5) ----------------

/** Parse an SSE stream of ProgressEvent JSON frames (`data: {...}\n\n`). */
export async function readSSE(
  resp: Response,
  onEvent: (ev: ProgressEvent) => void,
): Promise<void> {
  if (!resp.ok || !resp.body) {
    throw new Error((await resp.text().catch(() => "")) || `HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ProgressEvent);
      } catch {
        /* ignore a malformed frame */
      }
    }
  }
}

/** Step 2: run (optional research +) outline generation → draft project. */
export async function streamOutline(
  config: PptConfig,
  onEvent: (ev: ProgressEvent) => void,
  projectId?: string | null,
): Promise<void> {
  const resp = await fetch("/api/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, projectId: projectId || undefined }),
  });
  await readSSE(resp, onEvent);
}

/** Stream clarification questions as soon as each JSON object is complete. */
export async function streamOnboard(
  input: { requirement: string; scenarioId?: string; uiLocale: string; projectId?: string },
  onEvent: (ev: ProgressEvent) => void,
): Promise<void> {
  const resp = await fetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await readSSE(resp, onEvent);
}

/** Create the project before clarification so every later step has a durable id. */
export async function createProjectCheckpoint(config: PptConfig): Promise<Project> {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, config }),
        keepalive: true,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data as Project;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not create project checkpoint");
}

const CHECKPOINT_CACHE_PREFIX = "codex-slides:project-checkpoint:v1:";

export interface ProjectCheckpointPatch {
  config?: PptConfig;
  title?: string;
  researchDoc?: string;
  workflow?: Partial<ProjectWorkflowState>;
}

export function cacheProjectCheckpoint(
  projectId: string,
  patch: ProjectCheckpointPatch,
): ProjectCheckpointPatch {
  const cachedPatch: ProjectCheckpointPatch = {
    ...patch,
    workflow: patch.workflow ? { ...patch.workflow, updatedAt: Date.now() } : undefined,
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        `${CHECKPOINT_CACHE_PREFIX}${projectId}`,
        JSON.stringify(cachedPatch),
      );
    } catch {
      // The project JSON remains canonical when local storage is unavailable.
    }
  }
  return cachedPatch;
}

export function readProjectCheckpointCache(projectId: string): ProjectCheckpointPatch | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(`${CHECKPOINT_CACHE_PREFIX}${projectId}`) ?? "null");
  } catch {
    return null;
  }
}

/** Best-effort workflow checkpoint. Project files and generation state remain
 * server-owned; this stores the client-only position and clarification form. */
export async function saveProjectCheckpoint(
  projectId: string,
  patch: ProjectCheckpointPatch,
): Promise<Project> {
  const cachedPatch = cacheProjectCheckpoint(projectId, patch);
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...cachedPatch,
      materialIds: patch.config?.materialIds,
    }),
    keepalive: true,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data as Project;
}

/** Step 5: render the confirmed draft's slides, one image per slide. */
export async function streamRender(
  projectId: string,
  onEvent: (ev: ProgressEvent) => void,
): Promise<void> {
  const resp = await fetch(`/api/projects/${projectId}/render`, { method: "POST" });
  await readSSE(resp, onEvent);
}

/** Inspiration step: codex-rank the community style catalog for this deck. */
export async function rankInspire(
  requirement: string,
  outlineTitles: string[],
): Promise<{ ranked: string[]; reasons: Record<string, string> }> {
  const r = await fetch("/api/inspire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requirement, outlineTitles }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

/** Apply a picked template/style to the draft before rendering (inspiration step). */
export async function patchProjectStyle(
  projectId: string,
  patch: { template?: string | null; style?: string },
  version?: DeckVersionCaptureInput,
): Promise<void> {
  const r = await fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...patch, ...versionRequest(version) }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
}

/** Persist an edited draft outline (title/points/order). */
export async function saveOutline(projectId: string, pages: OutlinePage[]): Promise<void> {
  const r = await fetch(`/api/projects/${projectId}/outline`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
}

/** Persist the conversation so reopening the project restores the dialogue. */
export async function saveChat(projectId: string, messages: unknown[]): Promise<void> {
  try {
    await fetch(`/api/projects/${projectId}/chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } catch {
    /* best-effort; the live chat state is the source of truth in-session */
  }
}

/** Persist all conversations plus the active selection. The server keeps
 *  `project.chat` mirrored to the active messages for backwards compatibility. */
export async function saveConversations(
  projectId: string,
  conversations: unknown[],
  activeConversationId: string,
): Promise<void> {
  try {
    await fetch(`/api/projects/${projectId}/chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations, activeConversationId }),
    });
  } catch {
    /* best-effort; the live conversation state remains authoritative in-session */
  }
}

/** Natural-language outline revision during the draft/edit stage. */
export async function reviseOutlineChat(
  projectId: string,
  message: string,
  designFiles: DesignFileReference[] = [],
): Promise<{ pages: OutlinePage[]; reply: string }> {
  const r = await fetch(`/api/projects/${projectId}/outline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, designFilePaths: designFiles.map((file) => file.path) }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  const pages: OutlinePage[] = (d.pages ?? []).map((p: any) => ({
    title: String(p.title ?? ""),
    points: Array.isArray(p.points) ? p.points.map((x: any) => String(x)) : [],
  }));
  return { pages, reply: String(d.reply ?? "") };
}

function toUiSlide(page: any): UiSlide {
  return {
    index: Number(page.index),
    title: String(page.title ?? `Slide ${page.index}`),
    status: page.status as UiSlide["status"],
    image: page.image || undefined,
    error: page.error || undefined,
    bust: Date.now(),
    transition: page.transition ?? "none",
    speakerNotes: typeof page.speakerNotes === "string" ? page.speakerNotes : undefined,
  };
}

export interface SpeakerNotesResponse {
  pages: UiSlide[];
  notes: Array<{ index: number; title: string; note: string }>;
  generated?: number[];
}

/** Persist one slide's presenter notes without redrawing or reloading it. */
export async function saveProjectSpeakerNote(
  projectId: string,
  index: number,
  note: string,
): Promise<SpeakerNotesResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/speaker-notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index, note }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return {
    ...data,
    pages: (data.pages ?? []).map(toUiSlide),
  } as SpeakerNotesResponse;
}

/** Ask the project's selected agent to write notes for one slide or the deck. */
export async function generateProjectSpeakerNotes(
  projectId: string,
  input: { index?: number; overwrite?: boolean; instruction?: string } = {},
): Promise<SpeakerNotesResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/speaker-notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return {
    ...data,
    pages: (data.pages ?? []).map(toUiSlide),
  } as SpeakerNotesResponse;
}

async function slideAction(
  projectId: string,
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
): Promise<UiSlide[]> {
  const response = await fetch(`/api/projects/${projectId}/slides`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return (data.pages ?? []).map(toUiSlide);
}

function versionRequest(version?: DeckVersionCaptureInput) {
  return version ? {
    versionPrompt: version.prompt,
    versionGroupId: version.groupId,
  } : {};
}

export function addProjectSlide(
  projectId: string,
  afterIndex?: number,
  title?: string,
  version?: DeckVersionCaptureInput,
): Promise<UiSlide[]> {
  return slideAction(projectId, "POST", { action: "add", afterIndex, title, ...versionRequest(version) });
}

export function duplicateProjectSlide(projectId: string, index: number): Promise<UiSlide[]> {
  return slideAction(projectId, "POST", { action: "duplicate", index });
}

export function moveProjectSlide(projectId: string, index: number, toIndex: number): Promise<UiSlide[]> {
  return slideAction(projectId, "POST", { action: "move", index, toIndex });
}

export function deleteProjectSlide(projectId: string, index: number): Promise<UiSlide[]> {
  return slideAction(projectId, "DELETE", { index });
}

export function setProjectSlideTransition(
  projectId: string,
  index: number,
  transition: SlideTransition,
): Promise<UiSlide[]> {
  return slideAction(projectId, "POST", { action: "transition", index, transition });
}

export async function generateSingleSlide(
  projectId: string,
  index: number,
  instruction: string,
  title?: string,
  version?: DeckVersionCaptureInput,
): Promise<UiSlide> {
  const response = await fetch(`/api/projects/${projectId}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index, instruction, title, ...versionRequest(version) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return toUiSlide(data.page);
}

export async function uploadProjectSlide(
  projectId: string,
  index: number,
  image: Blob,
  title: string,
  version?: DeckVersionCaptureInput,
): Promise<UiSlide> {
  const form = new FormData();
  form.append("image", image, "slide.png");
  form.append("title", title);
  if (typeof version?.prompt === "string") form.append("versionPrompt", version.prompt);
  if (version?.groupId) form.append("versionGroupId", version.groupId);
  const response = await fetch(`/api/projects/${projectId}/slides/${index}/image`, {
    method: "POST",
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return toUiSlide(data.page);
}

/** Regenerate a single slide, optionally with an edit instruction. Returns new image name. */
export async function regenerateSlide(
  projectId: string,
  index: number,
  instruction?: string,
  title?: string,
  version?: DeckVersionCaptureInput,
): Promise<string> {
  const r = await fetch(`/api/projects/${projectId}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      index,
      instruction: instruction || undefined,
      title: title || undefined,
      ...versionRequest(version),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.page.image as string;
}

/** Save the exact marked-up canvas so chat and the editor share one immutable input. */
export async function saveMarkSource(
  projectId: string,
  index: number,
  blob: Blob,
): Promise<string> {
  const fd = new FormData();
  fd.append("index", String(index));
  fd.append("image", blob, "mark.png");
  let response: Response;
  try {
    response = await fetch(`/api/projects/${projectId}/mark/source`, { method: "POST", body: fd });
  } catch {
    throw new Error("Connection to the local server was interrupted.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (!data.image) throw new Error("The marked image snapshot was not saved.");
  return String(data.image);
}

/** Submit a persisted marked-up canvas edit for a slide. Returns new image name. */
export async function markSlide(
  projectId: string,
  index: number,
  source: string,
  note: string,
): Promise<string> {
  const fd = new FormData();
  fd.append("index", String(index));
  fd.append("note", note);
  fd.append("source", source);
  let r: Response;
  try {
    r = await fetch(`/api/projects/${projectId}/mark`, { method: "POST", body: fd });
  } catch {
    throw new Error("Connection to the local server was interrupted.");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  if (!d.page?.image) throw new Error("The mark edit completed without an image.");
  return d.page.image as string;
}

export interface ChatPlan {
  action: "answer" | "edit" | "add";
  reply: string;
  targets: number[];
  afterIndex?: number;
  title?: string;
  instruction: string;
  readFiles?: boolean;
  activities?: AgentToolCall[];
}

export interface SlideChatContext {
  slideIndex: number;
  title: string;
  imageUrl?: string;
}

export interface ChatRequest {
  message: string;
  context?: SlideChatContext;
  attachments?: ContextItem[];
  designFiles?: DesignFileReference[];
}

/** Ask the agent to turn an NL edit into a plan (which slides + how). */
export async function planChatEdit(
  projectId: string,
  message: string,
  context?: SlideChatContext,
  attachments: ContextItem[] = [],
  designFiles: DesignFileReference[] = [],
): Promise<ChatPlan> {
  const r = await fetch(`/api/projects/${projectId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      context,
      attachmentIds: attachments.map((item) => item.id),
      designFilePaths: designFiles.map((file) => file.path),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.plan as ChatPlan;
}
