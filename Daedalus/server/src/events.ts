import type { Server } from "node:http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { AppContext } from "./app.ts";
import type { Event } from "@daedalus/core";

/**
 * WebSocket channel for the browser control plane (PLAN.md §3.6).
 *
 * Protocol (versioned):
 *   client → { kind: "subscribe", task_id: "<id>" | "*", since_seq: <number> }
 *   client → { kind: "ping" }
 *   server → { kind: "hello", protocol, version, server_ts }
 *   server → { kind: "subscribed", task_id, since_seq, replayed, last_seq }
 *   server → { kind: "event", event: Event }      // replayed first, then live
 *   server → { kind: "pong" }
 *   server → { kind: "error", error }
 *
 * A reconnecting client sends its last seen seq per task; the server replays
 * only the missing suffix, so the UI never refetches a whole log. seq is
 * per task, so `"*"` replay is grouped per task rather than merged.
 */

export const EVENT_PROTOCOL = "daedalus-events";
export const EVENT_PROTOCOL_VERSION = 1;

export type EventChannel = {
  wss: WebSocketServer;
  close: () => void;
};

export function attachWebSocket(ctx: AppContext, server: Server): EventChannel {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server, path: "/tasks/events" });

  wss.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    send(socket, { kind: "hello", protocol: EVENT_PROTOCOL, version: EVENT_PROTOCOL_VERSION, server_ts: new Date().toISOString() });

    socket.on("message", (raw: unknown) => {
      let parsed: { kind?: unknown; task_id?: unknown; since_seq?: unknown };
      try {
        parsed = JSON.parse(String(raw)) as typeof parsed;
      } catch {
        send(socket, { kind: "error", error: "invalid_json" });
        return;
      }
      if (parsed.kind === "ping") {
        send(socket, { kind: "pong", server_ts: new Date().toISOString() });
        return;
      }
      if (parsed.kind !== "subscribe") {
        send(socket, { kind: "error", error: "unsupported_message" });
        return;
      }
      const taskId = parsed.task_id === undefined || parsed.task_id === "*" ? "*" : String(parsed.task_id);
      const sinceSeq = typeof parsed.since_seq === "number" && Number.isFinite(parsed.since_seq) ? parsed.since_seq : 0;
      const replay = replayFor(ctx, taskId, sinceSeq);
      for (const event of replay) send(socket, { kind: "event", event });
      send(socket, {
        kind: "subscribed",
        task_id: taskId,
        since_seq: sinceSeq,
        replayed: replay.length,
        last_seq: taskId === "*" ? 0 : (ctx.store.replay(taskId).at(-1)?.seq ?? sinceSeq),
      });
    });

    const drop = (): void => {
      sockets.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  const unsubscribe = ctx.bus.on("*", (event: Event) => {
    const message = JSON.stringify({ kind: "event", event });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    wss,
    close(): void {
      clearInterval(heartbeat);
      unsubscribe();
      for (const socket of sockets) socket.close();
      sockets.clear();
      wss.close();
    },
  };
}

export function replayFor(ctx: AppContext, taskId: string, sinceSeq: number): Event[] {
  if (taskId !== "*") return ctx.store.replay(taskId).filter((event) => event.seq > sinceSeq);
  return ctx.store
    .listTasks()
    .sort()
    .flatMap((id) => ctx.store.replay(id).filter((event) => event.seq > sinceSeq));
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}