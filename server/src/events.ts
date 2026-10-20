import type { Server } from "node:http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { allTaskIds, findTask, type AppContext } from "./app.ts";
import { requestAllowed } from "./security.ts";
import type { Event } from "@daedalus/core";

/**
 * WebSocket channel for the browser control plane (PLAN.md §3.6).
 *
 * Protocol (versioned):
 *   client → { kind: "subscribe", task_id: "<id>" | "*", since_seq: <number> }
 *   client → { kind: "terminal_subscribe", session_id: "<id>" }
 *   client → { kind: "ping" }
 *   server → { kind: "hello", protocol, version, server_ts }
 *   server → { kind: "subscribed", task_id, since_seq, replayed, last_seq }
 *   server → { kind: "event", event: Event }      // replayed first, then live
 *   server → { kind: "terminal_status", session }  // terminal lifecycle
 *   server → { kind: "terminal_output", session_id, data, replay? }
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
  const alive = new WeakMap<WebSocket, boolean>();
  const wss = new WebSocketServer({
    server,
    path: "/tasks/events",
    // CORS tidak berlaku untuk WebSocket: tanpa cek Origin, situs mana pun bisa menyadap seluruh event
    // (diff, perintah) lewat ws://127.0.0.1. Lihat security.ts.
    verifyClient: (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } }) =>
      requestAllowed({
        origin: info.origin ? info.origin : undefined,
        host: typeof info.req.headers.host === "string" ? info.req.headers.host : undefined,
        bindHost: ctx.settings.server.host,
      }),
  });

  wss.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    send(socket, { kind: "hello", protocol: EVENT_PROTOCOL, version: EVENT_PROTOCOL_VERSION, server_ts: new Date().toISOString() });

    socket.on("message", (raw: unknown) => {
      // Exception di handler event 'message' = uncaughtException (server mati): jangan sampai lolos.
      try {
        handleMessage(raw);
      } catch {
        send(socket, { kind: "error", error: "internal_error" });
      }
    });
    const handleMessage = (raw: unknown): void => {
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
      if (parsed.kind === "terminal_subscribe") {
        // Replay the session's buffered history, then live output follows
        // on the same socket — reopening a tab shows the whole transcript.
        const sessionId = typeof (parsed as { session_id?: unknown }).session_id === "string" ? (parsed as { session_id: string }).session_id : "";
        const session = ctx.terminals.get(sessionId);
        if (!session) {
          send(socket, { kind: "error", error: "terminal_not_found" });
          return;
        }
        send(socket, { kind: "terminal_status", session });
        const buffered = ctx.terminals.output(sessionId);
        if (buffered) send(socket, { kind: "terminal_output", session_id: sessionId, data: buffered, replay: true });
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
        last_seq: taskId === "*" ? 0 : ((findTask(ctx, taskId)?.store ?? ctx.store).replay(taskId).at(-1)?.seq ?? sinceSeq),
      });
    };

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

  const unsubscribeTerminals = ctx.terminals.onMessage((message) => {
    const wire = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(wire);
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      // Socket yang tidak membalas ping sejak heartbeat sebelumnya = koneksi setengah-mati (laptop tidur,
      // jaringan putus): putuskan, kalau tidak ia menumpuk di `sockets` selamanya.
      if (alive.get(socket) === false) {
        socket.terminate();
        sockets.delete(socket);
        continue;
      }
      alive.set(socket, false);
      if (socket.readyState === socket.OPEN) socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    wss,
    close(): void {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeTerminals();
      for (const socket of sockets) socket.close();
      sockets.clear();
      wss.close();
    },
  };
}

export function replayFor(ctx: AppContext, taskId: string, sinceSeq: number): Event[] {
  // Task bisa berada di store workspace lain (sama seperti route HTTP): cari lewat findTask, bukan ctx.store saja.
  const eventsOf = (id: string): Event[] => (findTask(ctx, id)?.store ?? ctx.store).replay(id).filter((event) => event.seq > sinceSeq);
  if (taskId !== "*") return eventsOf(taskId);
  return allTaskIds(ctx).sort().flatMap(eventsOf);
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}