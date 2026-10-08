"use client";

import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChatMsg } from "@/components/ChatColumn";
import type { GlobalTodoItem } from "@/lib/agentActivity";
import type { StoredConversation } from "@/lib/types";

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMsg[];
  /** Project-wide checklist that persists across turns in this conversation. */
  todos: GlobalTodoItem[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

interface ConversationSeed {
  conversations: ChatConversation[];
  activeConversationId: string;
}

function conversationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function tidyTitle(value: string, fallback = "新会话") {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return fallback;
  return oneLine.length > 32 ? `${oneLine.slice(0, 31)}…` : oneLine;
}

function isProvisionalTitle(title: string) {
  return /^新会话(?:\s+\d+)?$/.test(title) || title === "New conversation";
}

function titleFromMessages(messages: ChatMsg[], fallback: string) {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  return firstUser ? tidyTitle(firstUser.content, fallback) : fallback;
}

function stampMessages(messages: ChatMsg[], previous: ChatMsg[], now: number) {
  return messages.map((message, index) => {
    if (typeof message.ts === "number") return message;
    const previousTimestamp = previous[index] === message ? previous[index]?.ts : undefined;
    return { ...message, ts: previousTimestamp ?? now };
  });
}

function makeConversation(messages: ChatMsg[], title: string): ChatConversation {
  const now = Date.now();
  return {
    id: conversationId(),
    title: titleFromMessages(messages, tidyTitle(title)),
    createdAt: now,
    updatedAt: now,
    messages: stampMessages(messages, [], now),
    todos: [],
  };
}

function buildSeed(
  stored: StoredConversation[] | undefined,
  requestedActiveId: string | undefined,
  fallbackMessages: ChatMsg[],
  fallbackTitle: string,
): ConversationSeed {
  const hydrated = Array.isArray(stored)
    ? stored
      .filter((conversation) => conversation && conversation.id)
      .map((conversation) => ({
        id: String(conversation.id),
        title: tidyTitle(conversation.title, fallbackTitle),
        createdAt: Number(conversation.createdAt) || Date.now(),
        updatedAt: Number(conversation.updatedAt) || Number(conversation.createdAt) || Date.now(),
        messages: Array.isArray(conversation.messages)
          ? conversation.messages as unknown as ChatMsg[]
          : [],
        todos: Array.isArray(conversation.todos)
          ? conversation.todos as GlobalTodoItem[]
          : [],
      }))
    : [];
  const conversations = hydrated.length ? hydrated : [makeConversation(fallbackMessages, fallbackTitle)];
  const activeConversationId = conversations.some((conversation) => conversation.id === requestedActiveId)
    ? requestedActiveId!
    : conversations[0].id;
  return { conversations, activeConversationId };
}

export function useChatConversations({
  initialConversations,
  initialActiveConversationId,
  initialMessages,
  initialTitle = "新会话",
}: {
  initialConversations?: StoredConversation[];
  initialActiveConversationId?: string;
  initialMessages: ChatMsg[];
  initialTitle?: string;
}) {
  const seedRef = useRef<ConversationSeed | null>(null);
  if (!seedRef.current) {
    seedRef.current = buildSeed(
      initialConversations,
      initialActiveConversationId,
      initialMessages,
      initialTitle,
    );
  }
  const [conversations, setConversations] = useState<ChatConversation[]>(seedRef.current.conversations);
  const [activeConversationId, setActiveConversationId] = useState(seedRef.current.activeConversationId);
  const activeConversationIdRef = useRef(seedRef.current.activeConversationId);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
    ?? conversations[0];
  const messages = activeConversation?.messages ?? [];

  const setMessages: Dispatch<SetStateAction<ChatMsg[]>> = useCallback((update) => {
    const targetId = activeConversationIdRef.current;
    setConversations((current) => current.map((conversation) => {
      if (conversation.id !== targetId) return conversation;
      const nextRaw = typeof update === "function" ? update(conversation.messages) : update;
      const now = Date.now();
      const nextMessages = stampMessages(nextRaw, conversation.messages, now);
      return {
        ...conversation,
        title: isProvisionalTitle(conversation.title)
          ? titleFromMessages(nextMessages, conversation.title)
          : conversation.title,
        updatedAt: now,
        messages: nextMessages,
      };
    }));
  }, []);

  const createConversation = useCallback((starterMessages: ChatMsg[] = []) => {
    const next = makeConversation(starterMessages, `新会话 ${conversations.length + 1}`);
    setConversations((current) => [...current, next]);
    activeConversationIdRef.current = next.id;
    setActiveConversationId(next.id);
    return next.id;
  }, [conversations.length]);

  const selectConversation = useCallback((id: string) => {
    if (!conversations.some((conversation) => conversation.id === id)) return;
    activeConversationIdRef.current = id;
    setActiveConversationId(id);
  }, [conversations]);

  const renameConversation = useCallback((id: string, title: string) => {
    const nextTitle = tidyTitle(title);
    setConversations((current) => current.map((conversation) => (
      conversation.id === id
        ? { ...conversation, title: nextTitle, updatedAt: Date.now() }
        : conversation
    )));
  }, []);

  const deleteConversation = useCallback((id: string) => {
    if (conversations.length <= 1) return;
    const index = conversations.findIndex((conversation) => conversation.id === id);
    if (index < 0) return;
    const next = conversations.filter((conversation) => conversation.id !== id);
    setConversations(next);
    if (activeConversationId === id) {
      const nextActiveId = next[Math.min(index, next.length - 1)].id;
      activeConversationIdRef.current = nextActiveId;
      setActiveConversationId(nextActiveId);
    }
  }, [activeConversationId, conversations]);

  const resetConversations = useCallback((starterMessages: ChatMsg[], title = initialTitle) => {
    const next = makeConversation(starterMessages, title);
    setConversations([next]);
    activeConversationIdRef.current = next.id;
    setActiveConversationId(next.id);
  }, [initialTitle]);

  const restoreConversations = useCallback((
    stored: StoredConversation[] | undefined,
    requestedActiveId: string | undefined,
    fallbackMessages: ChatMsg[] = [],
    fallbackTitle = initialTitle,
  ) => {
    const next = buildSeed(stored, requestedActiveId, fallbackMessages, fallbackTitle);
    seedRef.current = next;
    setConversations(next.conversations);
    activeConversationIdRef.current = next.activeConversationId;
    setActiveConversationId(next.activeConversationId);
  }, [initialTitle]);

  const summaries = useMemo<ConversationSummary[]>(() => conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    messageCount: conversation.messages.length,
    updatedAt: conversation.updatedAt,
  })), [conversations]);

  const todos = activeConversation?.todos ?? [];

  const mutateTodos = useCallback((updater: (todos: GlobalTodoItem[]) => GlobalTodoItem[]) => {
    const targetId = activeConversationIdRef.current;
    setConversations((current) => current.map((conversation) => (
      conversation.id === targetId
        ? { ...conversation, todos: updater(conversation.todos ?? []), updatedAt: Date.now() }
        : conversation
    )));
  }, []);

  /** Append this turn's tasks, replacing any earlier tasks owned by the same turn. */
  const appendTodos = useCallback((items: GlobalTodoItem[]) => {
    if (!items.length) return;
    const turnIds = new Set(items.map((item) => item.turnId).filter(Boolean));
    mutateTodos((current) => [
      ...current.filter((todo) => !todo.turnId || !turnIds.has(todo.turnId)),
      ...items,
    ]);
  }, [mutateTodos]);

  const patchTodo = useCallback((id: string, patch: Partial<GlobalTodoItem>) => {
    mutateTodos((current) => current.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo)));
  }, [mutateTodos]);

  const clearTodos = useCallback(() => mutateTodos(() => []), [mutateTodos]);

  return {
    conversations,
    summaries,
    activeConversationId,
    messages,
    setMessages,
    todos,
    appendTodos,
    patchTodo,
    clearTodos,
    createConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
    resetConversations,
    restoreConversations,
  };
}
