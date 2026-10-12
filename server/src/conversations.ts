import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message } from "@daedalus/core";

/**
 * Web chat conversations (Farid's main workflow complaint): a chat is one
 * continuing session, not one isolated task per prompt. A conversation is a
 * persisted, per-workspace list of turns; tasks and fast-path answers append
 * to it, and the recent turns ride back into the next prompt (fast-path
 * history, or prior-context for a real task) so follow-ups like "di mana
 * plan-nya?" are answered with session memory.
 *
 * Storage follows the TaskStore pattern: plain files under the workspace's
 * Daedalus home (`<workspace>/.daedalus/conversations/<id>.json`), surviving
 * server restarts. Synchronous fs on purpose — one small JSON document per
 * conversation, rewritten on append, matching the store it sits beside.
 */

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  task_id?: string;
  mode?: string;
  ts: string;
};

export type Conversation = {
  id: string;
  root: string;
  created_at: string;
  turns: ConversationTurn[];
};

/** How many recent turns feed a prompt, and the total character budget. */
export const MAX_HISTORY_TURNS = 12;
export const MAX_HISTORY_CHARS = 6_000;
/** A single turn is clipped before it can eat the whole budget. */
const MAX_TURN_CHARS = 1_200;

export class ConversationStore {
  readonly dir: string;

  constructor(daedalusHome: string) {
    this.dir = join(daedalusHome, "conversations");
  }

  create(root: string, id?: string): Conversation {
    const conversation: Conversation = {
      id: id && id.trim() ? id.trim() : crypto.randomUUID(),
      root: resolve(root),
      created_at: new Date().toISOString(),
      turns: [],
    };
    this.#save(conversation);
    return conversation;
  }

  load(id: string): Conversation | undefined {
    try {
      const raw = readFileSync(this.#path(id), "utf8");
      const parsed = JSON.parse(raw) as Conversation;
      if (typeof parsed?.id !== "string" || !Array.isArray(parsed.turns)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Load, or create on first use (task creation may carry a fresh id). */
  ensure(root: string, id: string): Conversation {
    return this.load(id) ?? this.create(root, id);
  }

  list(): Conversation[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const conversations: Conversation[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const conversation = this.load(name.slice(0, -".json".length));
      if (conversation) conversations.push(conversation);
    }
    // Newest first: last turn (or creation) descends, id breaks ties.
    return conversations.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || b.id.localeCompare(a.id));
  }

  append(root: string, id: string, turn: ConversationTurn): Conversation {
    const conversation = this.ensure(root, id);
    conversation.turns.push(turn);
    this.#save(conversation);
    return conversation;
  }

  #path(id: string): string {
    // Ids are uuids in practice; refuse anything that could escape the dir.
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..")) return join(this.dir, "__invalid__.json");
    return join(this.dir, `${id}.json`);
  }

  #save(conversation: Conversation): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.#path(conversation.id), JSON.stringify(conversation, null, 2), "utf8");
  }
}

function lastActivity(conversation: Conversation): string {
  return conversation.turns.at(-1)?.ts ?? conversation.created_at;
}

/** Most recent turns within the caps, oldest first. */
export function recentTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const kept: ConversationTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length < MAX_HISTORY_TURNS; index--) {
    const turn = turns[index]!;
    const cost = Math.min(turn.text.length, MAX_TURN_CHARS);
    if (kept.length > 0 && used + cost > MAX_HISTORY_CHARS) break;
    used += cost;
    kept.push({ ...turn, text: clip(turn.text) });
  }
  return kept.reverse();
}

function clip(text: string): string {
  return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text;
}

/** Prior turns as LLM messages for the fast paths (core accepts history). */
export function historyMessages(turns: ConversationTurn[]): Message[] {
  return recentTurns(turns).map((turn) => ({
    role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
    content: turn.text,
  }));
}

/**
 * Prior turns rendered as one bounded context block for a real task (rides
 * the prompt constraints, like the plan-task steps). Returns undefined for
 * an empty history so a fresh conversation changes nothing.
 */
export function priorContextSection(turns: ConversationTurn[]): string | undefined {
  const recent = recentTurns(turns);
  if (recent.length === 0) return undefined;
  const lines = recent.map((turn) => `${turn.role === "user" ? "User" : "Daedalus"}: ${turn.text.replace(/\s*\n\s*/g, " ")}`);
  return [
    "Earlier in this conversation (most recent last) — the user's follow-ups refer to this; continue from it instead of starting cold:",
    ...lines,
  ].join("\n");
}

/** Short assistant summary recorded when a task completes inside a conversation. */
export function taskSummaryText(input: { outcome: string; goal: string; evidence?: string[] }): string {
  const headline =
    input.outcome === "success"
      ? "Selesai."
      : input.outcome === "partial"
        ? "Selesai sebagian."
        : "Berhenti sebelum selesai.";
  const evidence = (input.evidence ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  return clip([`${headline} (${input.goal})`, ...evidence].join("\n"));
}
