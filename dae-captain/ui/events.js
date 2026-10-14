// Dae Captain UI — WebSocket event stream client.
// Connects to ws://host:port/tasks/events with protocol "daedalus-events".
// Handles subscribe, replay (since_seq), reconnect with backoff, and
// falls back to HTTP polling if WebSocket is unavailable.

export const EVENT_PROTOCOL = "daedalus-events";

/**
 * Create an event stream client.
 * @param {object} opts
 * @param {() => string} opts.getWsUrl - returns ws:// URL (e.g. from server health)
 * @param {(events: object[]) => void} opts.onEvents - called with new events
 * @param {() => void} [opts.onConnect]
 * @param {() => void} [opts.onDisconnect]
 */
export function createEventStream({ getWsUrl, onEvents, onConnect, onDisconnect }) {
  let ws = null;
  let taskId = null;
  let lastSeq = 0;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let closed = false;
  let usePolling = false;
  let pollTimer = null;
  let pollFn = null;

  function connect() {
    if (closed) return;
    let url;
    try {
      url = getWsUrl();
    } catch {
      scheduleReconnect();
      return;
    }
    if (!url) {
      scheduleReconnect();
      return;
    }
    try {
      ws = new WebSocket(url, EVENT_PROTOCOL);
    } catch {
      startPollingFallback();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = 1000;
      // Subscribe to the task (or all tasks with "*")
      ws.send(JSON.stringify({ kind: "subscribe", task_id: taskId ?? "*", since_seq: lastSeq }));
      onConnect?.();
    };

    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (data.kind === "event" && data.event) {
        const ev = data.event;
        if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
        onEvents([ev]);
      } else if (data.kind === "subscribed") {
        // Replay done; last_seq tells us where we are
        if (typeof data.last_seq === "number") lastSeq = Math.max(lastSeq, data.last_seq);
      }
      // Ignore hello, pong, terminal_* for now
    };

    ws.onclose = () => {
      ws = null;
      onDisconnect?.();
      if (!closed) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire; if WebSocket keeps failing, fall back to polling
      try { ws?.close(); } catch {}
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  }

  function startPollingFallback() {
    // WebSocket unavailable — use HTTP polling as fallback.
    // The caller provides pollFn(taskId, sinceSeq) via setPollFn.
    if (usePolling || !pollFn) return;
    usePolling = true;
    const poll = async () => {
      if (closed || !usePolling) return;
      try {
        const events = await pollFn(taskId, lastSeq);
        if (events?.length) {
          for (const ev of events) {
            if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
          }
          onEvents(events);
        }
      } catch {
        /* keep polling */
      }
      pollTimer = setTimeout(poll, 2500);
    };
    poll();
  }

  return {
    /** Subscribe to a task's events (or "*" for all). Resets seq. */
    subscribe(newTaskId) {
      taskId = newTaskId;
      lastSeq = 0;
      usePolling = false;
      clearTimeout(pollTimer);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: "subscribe", task_id: taskId ?? "*", since_seq: 0 }));
      } else {
        try { ws?.close(); } catch {}
        connect();
      }
    },
    /** Provide HTTP polling fallback: (taskId, sinceSeq) => Promise<events[]> */
    setPollFn(fn) {
      pollFn = fn;
    },
    /** Send ping to keep connection alive */
    ping() {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: "ping" }));
      }
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(pollTimer);
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}
