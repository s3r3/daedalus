import type { ChatRequest } from "@/lib/deckEdit";
import type { ContextItem } from "@/lib/contextItems";
import type { DesignFileReference } from "@/lib/types";

/** A project-chat turn captured before execution. Attachments and file
 * references are snapshots so later composer changes cannot mutate the turn. */
export interface QueuedChatRequest extends ChatRequest {
  id: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const QUEUE_STORAGE_VERSION = 1;
export const MAX_QUEUED_CHAT_REQUESTS = 100;

export function chatQueueStorageKey(projectId: string): string {
  return `codex-slides:chat-queue:${projectId}:v${QUEUE_STORAGE_VERSION}`;
}

function requestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function cloneContextItem(item: ContextItem): ContextItem {
  return { ...item };
}

function cloneDesignFile(file: DesignFileReference): DesignFileReference {
  return { ...file };
}

/** Clone every mutable collection carried by a composer turn. */
export function snapshotChatRequest(request: ChatRequest): ChatRequest {
  return {
    message: request.message,
    ...(request.context ? { context: { ...request.context } } : {}),
    ...(request.attachments?.length
      ? { attachments: request.attachments.map(cloneContextItem) }
      : {}),
    ...(request.designFiles?.length
      ? { designFiles: request.designFiles.map(cloneDesignFile) }
      : {}),
  };
}

export function createQueuedChatRequest(
  conversationId: string,
  request: ChatRequest,
  options: { id?: string; now?: number } = {},
): QueuedChatRequest {
  const now = options.now ?? Date.now();
  return {
    id: options.id ?? requestId(),
    conversationId,
    ...snapshotChatRequest(request),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateQueuedChatRequest(
  item: QueuedChatRequest,
  request: ChatRequest,
  now = Date.now(),
): QueuedChatRequest {
  return {
    id: item.id,
    conversationId: item.conversationId,
    ...snapshotChatRequest(request),
    createdAt: item.createdAt,
    updatedAt: now,
  };
}

/** Reorder only one conversation's turns while preserving every other
 * conversation's positions in the project-level persisted array. */
export function reorderConversationQueue(
  items: QueuedChatRequest[],
  conversationId: string,
  orderedIds: string[],
): QueuedChatRequest[] {
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const current = items.filter((item) => item.conversationId === conversationId);
  const sorted = [...current].sort((a, b) => {
    const aOrder = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
  let cursor = 0;
  return items.map((item) => (
    item.conversationId === conversationId ? (sorted[cursor++] ?? item) : item
  ));
}

export function prioritizeQueuedChatRequest(
  items: QueuedChatRequest[],
  id: string,
): QueuedChatRequest[] {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return items;
  const conversationItems = items.filter((candidate) => candidate.conversationId === item.conversationId);
  const orderedIds = [
    id,
    ...conversationItems.filter((candidate) => candidate.id !== id).map((candidate) => candidate.id),
  ];
  return reorderConversationQueue(items, item.conversationId, orderedIds);
}

function finiteTime(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sanitizeContext(value: unknown): ChatRequest["context"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const slideIndex = Math.trunc(Number(raw.slideIndex));
  if (!Number.isInteger(slideIndex) || slideIndex < 1) return undefined;
  return {
    slideIndex,
    title: String(raw.title ?? "").slice(0, 500),
    ...(typeof raw.imageUrl === "string" ? { imageUrl: raw.imageUrl.slice(0, 4_000) } : {}),
  };
}

function sanitizeAttachments(value: unknown): ContextItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry): ContextItem[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const id = String(raw.id ?? "").trim();
    const name = String(raw.name ?? "").trim();
    const url = String(raw.url ?? "").trim();
    if (!id || !name || !url) return [];
    return [{
      id: id.slice(0, 240),
      name: name.slice(0, 500),
      url: url.slice(0, 4_000),
      kind: raw.kind === "image" ? "image" : "file",
      mimeType: String(raw.mimeType ?? "application/octet-stream").slice(0, 240),
      size: Math.max(0, Number(raw.size) || 0),
    }];
  }).slice(0, 24);
  return items.length ? items : undefined;
}

function sanitizeDesignFiles(value: unknown): DesignFileReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const files = value.flatMap((entry): DesignFileReference[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const path = String(raw.path ?? "").trim();
    const relativePath = String(raw.relativePath ?? "").trim();
    const name = String(raw.name ?? "").trim();
    if (!path || !relativePath || !name || seen.has(path)) return [];
    seen.add(path);
    const kind = ["document", "image", "data", "code", "other"].includes(String(raw.kind))
      ? raw.kind as DesignFileReference["kind"]
      : undefined;
    return [{
      path: path.slice(0, 2_000),
      relativePath: relativePath.slice(0, 500),
      name: name.slice(0, 500),
      ...(kind ? { kind } : {}),
    }];
  }).slice(0, 24);
  return files.length ? files : undefined;
}

export function parseQueuedChatRequests(raw: string | null): QueuedChatRequest[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): QueuedChatRequest[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const value = entry as Record<string, unknown>;
      const id = String(value.id ?? "").trim();
      const conversationId = String(value.conversationId ?? "").trim();
      const message = String(value.message ?? "");
      const createdAt = finiteTime(value.createdAt);
      const updatedAt = finiteTime(value.updatedAt) ?? createdAt;
      if (!id || !conversationId || createdAt == null || updatedAt == null) return [];
      const context = sanitizeContext(value.context);
      const attachments = sanitizeAttachments(value.attachments);
      const designFiles = sanitizeDesignFiles(value.designFiles);
      return [{
        id: id.slice(0, 240),
        conversationId: conversationId.slice(0, 240),
        message: message.slice(0, 40_000),
        ...(context ? { context } : {}),
        ...(attachments ? { attachments } : {}),
        ...(designFiles ? { designFiles } : {}),
        createdAt,
        updatedAt,
      }];
    }).slice(0, MAX_QUEUED_CHAT_REQUESTS);
  } catch {
    return [];
  }
}

export function loadQueuedChatRequests(
  projectId: string,
  storage?: QueueStorage,
): QueuedChatRequest[] {
  if (!storage && typeof window === "undefined") return [];
  try {
    const target = storage ?? window.localStorage;
    return parseQueuedChatRequests(target.getItem(chatQueueStorageKey(projectId)));
  } catch {
    return [];
  }
}

export function saveQueuedChatRequests(
  projectId: string,
  items: QueuedChatRequest[],
  storage?: QueueStorage,
): void {
  if (!storage && typeof window === "undefined") return;
  try {
    const target = storage ?? window.localStorage;
    const key = chatQueueStorageKey(projectId);
    if (!items.length) {
      target.removeItem(key);
      return;
    }
    target.setItem(key, JSON.stringify(items.slice(0, MAX_QUEUED_CHAT_REQUESTS)));
  } catch {
    // Private browsing and quota failures must not break the live in-memory queue.
  }
}
