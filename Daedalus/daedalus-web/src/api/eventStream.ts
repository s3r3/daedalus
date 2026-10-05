import type { Event } from '@daedalus/core'

/**
 * WebSocket client for the per-task event stream (PLAN.md §3.6).
 *
 * Guarantees relied upon by the UI:
 *  - on every (re)connect it re-subscribes with the last seq it has *per task*,
 *    so the server replays only the missing suffix (no duplicated view, no gaps);
 *  - duplicates are dropped defensively on `(task_id, seq)`;
 *  - backoff is capped and the client never throws from its callbacks.
 */

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export type StreamHandlers = {
  onEvent: (event: Event) => void
  onStatus: (status: StreamStatus, detail?: { attempt: number; nextRetryMs?: number }) => void
  onProtocol?: (message: { kind: string; [key: string]: unknown }) => void
}

export type EventStreamOptions = {
  url: string
  taskId?: string
  handlers: StreamHandlers
  onProtocol?: (message: { kind: string; [key: string]: unknown }) => void
  socketFactory?: (url: string) => WebSocket
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  maxRetryMs?: number
}

type ResolvedOptions = {
  url: string
  taskId: string | undefined
  handlers: StreamHandlers
  onProtocol: ((message: { kind: string; [key: string]: unknown }) => void) | undefined
  socketFactory: (url: string) => WebSocket
  setTimeoutFn: (handler: () => void, ms: number) => unknown
  clearTimeoutFn: (handle: unknown) => void
  maxRetryMs: number
}

export class EventStreamClient {
  readonly #options: ResolvedOptions
  #socket: WebSocket | null = null
  #taskId: string | undefined
  #lastSeq: Record<string, number> = {}
  #attempt = 0
  #retryHandle: unknown = null
  #stopped = false

  constructor(options: EventStreamOptions) {
    this.#options = {
      url: options.url,
      taskId: options.taskId,
      handlers: options.handlers,
      socketFactory: options.socketFactory ?? ((url: string) => new WebSocket(url)),
      setTimeoutFn: options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms)),
      clearTimeoutFn: options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      maxRetryMs: options.maxRetryMs ?? 8_000,
      onProtocol: options.onProtocol,
    }
    this.#taskId = options.taskId
  }

  get lastSeqs(): Record<string, number> {
    return { ...this.#lastSeq }
  }

  /** Record events the client already holds, so a reconnect resumes after them. */
  seed(events: Event[]): void {
    for (const event of events) this.#observeSeq(event)
  }

  start(taskId?: string): void {
    this.#stopped = false
    if (taskId !== undefined) this.#taskId = taskId
    this.#attempt = 0
    this.#open()
  }

  /**
   * Point the client at one task.
   *
   * An explicit `sinceSeq` — including 0 — is authoritative: a wildcard
   * subscription already advances `#lastSeq` for every task it replays, so a
   * later `subscribe(task, 0)` must clear that entry or the client would ask
   * the server to resume AFTER events it has just discarded. Omitting the
   * argument leaves the tracked sequence alone, so a `seed()`-ed client keeps
   * its position.
   */
  subscribe(taskId: string, sinceSeq?: number): void {
    this.#taskId = taskId
    if (sinceSeq !== undefined) this.#lastSeq[taskId] = sinceSeq
    this.#sendSubscribe()
  }

  stop(): void {
    this.#stopped = true
    if (this.#retryHandle !== null) this.#options.clearTimeoutFn(this.#retryHandle)
    this.#retryHandle = null
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    this.#options.handlers.onStatus('closed')
  }

  /** Force a reconnect now (used by the "reconnect" affordance and by tests). */
  reconnect(): void {
    if (this.#stopped) return
    this.#socket?.close()
  }

  #open(): void {
    if (this.#stopped) return
    this.#options.handlers.onStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.#attempt })
    let socket: WebSocket
    try {
      socket = this.#options.socketFactory(this.#options.url)
    } catch {
      this.#reportRetry()
      return
    }
    this.#socket = socket

    socket.onopen = () => {
      this.#attempt = 0
      this.#options.handlers.onStatus('open')
      this.#sendSubscribe()
    }
    socket.onmessage = (message: MessageEvent<unknown>) => this.#onMessage(message)
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = null
      if (this.#stopped) {
        this.#options.handlers.onStatus('closed')
        return
      }
      this.#reportRetry()
    }
  }

  #sendSubscribe(): void {
    const socket = this.#socket
    if (!socket || socket.readyState !== 1) return
    socket.send(
      JSON.stringify({
        kind: 'subscribe',
        task_id: this.#taskId ?? '*',
        since_seq: this.#taskId ? (this.#lastSeq[this.#taskId] ?? 0) : 0,
      }),
    )
  }

  #onMessage(message: MessageEvent<unknown>): void {
    let parsed: { kind?: unknown; event?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) as typeof parsed;
    } catch {
      return
    }
    this.#options.onProtocol?.(parsed as { kind: string })
    if (parsed.kind !== 'event') return
    const event = parsed.event as Event | undefined
    if (!event || typeof event.seq !== 'number' || typeof event.task_id !== 'string') return
    if (this.#lastSeq[event.task_id] !== undefined && event.seq <= this.#lastSeq[event.task_id]) return
    this.#observeSeq(event)
    this.#options.handlers.onEvent(event)
  }

  #observeSeq(event: Event): void {
    const current = this.#lastSeq[event.task_id] ?? 0
    if (event.seq > current) this.#lastSeq[event.task_id] = event.seq
  }

  #retryDelay(): number {
    const base = Math.min(this.#options.maxRetryMs, 250 * 2 ** this.#attempt)
    return base
  }

  /**
 * Announce the pending retry and schedule it, computing the delay ONCE so the
   * `nextRetryMs` reported to the UI is exactly the delay the timer uses. The
   * attempt counter is incremented here, before the delay is derived.
   */
  #reportRetry(): void {
    if (this.#stopped) return
    this.#attempt += 1
    const delay = this.#retryDelay()
    this.#options.handlers.onStatus('reconnecting', { attempt: this.#attempt, nextRetryMs: delay })
    if (this.#retryHandle !== null) return
    this.#retryHandle = this.#options.setTimeoutFn(() => {
      this.#retryHandle = null
      this.#open()
    }, delay)
  }
}

/** Default gateway WS URL: same origin in dev (Vite proxy) or from env. */
export function defaultEventStreamUrl(): string {
  const api = (import.meta.env.VITE_DAEDALUS_API ?? '').replace(/\/$/, '')
  if (api.length > 0) return `${api.replace(/^http/, 'ws')}/tasks/events`
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    return `${window.location.origin.replace(/^http/, 'ws')}/tasks/events`
  }
  return 'ws://127.0.0.1:3080/tasks/events'
}