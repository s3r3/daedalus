import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EventStreamClient } from './api/eventStream'
import type { Event } from '@daedalus/core'

const OPEN = 1

type Timer = { handler: () => void; ms: number }

/**
 * The client only touches readyState, send, close and the four handler props,
 * so a structural cast is enough — jsdom's WebSocket is never constructed here.
 */
class FakeSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  open(): void {
    this.readyState = OPEN
    this.onopen?.()
  }

  deliver(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }

  close(): void {
    this.readyState = 3
    this.closed = true
    this.onclose?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }
}

/** Present a FakeSocket where the client's `socketFactory` contract expects a WebSocket. */
function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket
}

describe('EventStreamClient', () => {
  const ev = (seq: number, taskId = 'task-1'): Event =>
    ({ seq, task_id: taskId, type: 'FILE_CHANGED', payload: { path: 'a.ts' }, ts: seq }) as unknown as Event

  const wire = (raw: string) => JSON.parse(raw) as Record<string, unknown>

  let sockets: FakeSocket[]
  let timers: Timer[]
  let cleared: unknown[]
  let onEvent: ReturnType<typeof vi.fn>
  let onStatus: ReturnType<typeof vi.fn>
  let onProtocol: ReturnType<typeof vi.fn>
  /** A factory may throw to simulate an unreachable gateway. */
type SocketFactory = (url: string) => WebSocket

  let make: (factory?: SocketFactory) => EventStreamClient

  /** Last socket handed out by the factory. */
  const latest = (): FakeSocket => sockets[sockets.length - 1]

  const open = (): FakeSocket => {
    const socket = latest()
    socket.open()
    return socket
  }

  /** Fire the most recently scheduled retry timer. */
  const fireRetry = (): void => {
    const timer = timers[timers.length - 1]
    timers.pop()
    timer.handler()
  }

  beforeEach(() => {
    sockets = []
    timers = []
    cleared = []
    onEvent = vi.fn()
    onStatus = vi.fn()
    onProtocol = vi.fn()

    make = (factory) =>
      new EventStreamClient({
        url: 'ws://gateway/tasks/events',
        taskId: 'task-1',
        handlers: { onEvent, onStatus },
        onProtocol,
        socketFactory: factory ?? ((url: string) => {
          const socket = new FakeSocket(url)
          sockets.push(socket)
          return asWebSocket(socket)
        }),
        setTimeoutFn: (handler, ms) => {
          const timer = { handler, ms }
          timers.push(timer)
          return timer
        },
        clearTimeoutFn: (handle) => cleared.push(handle),
        maxRetryMs: 8_000,
      })
  })

  describe('subscribe', () => {
    test('sends {kind,task_id,since_seq} over the open socket', () => {
      const client = make()
      client.start()
      const socket = open()

      client.subscribe('task-1', 12)

      expect(socket.sent).toHaveLength(2)
      expect(wire(socket.sent[0])).toEqual({ kind: 'subscribe', task_id: 'task-1', since_seq: 0 })
      expect(wire(socket.sent[1])).toEqual({ kind: 'subscribe', task_id: 'task-1', since_seq: 12 })
    })

    test('start() then onopen auto-subscribes with the constructor taskId', () => {
      const client = make()
      client.start()
      const socket = open()

      expect(wire(socket.sent[0])).toEqual({ kind: 'subscribe', task_id: 'task-1', since_seq: 0 })
    })

    test('start(taskId) overrides the constructor taskId', () => {
      const client = make()
      client.start('task-7')
      const socket = open()

      expect(wire(socket.sent[0])).toEqual({ kind: 'subscribe', task_id: 'task-7', since_seq: 0 })
    })

    test('start() with no taskId subscribes to the wildcard task', () => {
      const client = new EventStreamClient({
        url: 'ws://gateway/tasks/events',
        handlers: { onEvent, onStatus },
        socketFactory: (url) => {
          const socket = new FakeSocket(url)
          sockets.push(socket)
          return asWebSocket(socket)
        },
      })
      client.start()
      const socket = open()

      expect(wire(socket.sent[0])).toEqual({ kind: 'subscribe', task_id: '*', since_seq: 0 })
    })

    test('subscribe before the socket is open is dropped, not queued', () => {
      const client = make()
      client.start()
      client.subscribe('task-1', 5)

      expect(latest().sent).toEqual([])
    })

    test('subscribe(task, 0) clears a lastSeq left by a wildcard replay', () => {
      // Regression: a wildcard subscription replays every task and advances
      // lastSeq for all of them. A later subscribe(task, 0) must reset that
      // entry, otherwise the client asks the server to resume AFTER events it
      // already holds and the UI renders an empty log. Found by the e2e suite.
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: ev(1) }))
      expect(client.lastSeqs).toEqual({ 'task-1': 1 })

      onEvent.mockClear()
      client.subscribe('task-1', 0)

      expect(client.lastSeqs).toEqual({ 'task-1': 0 })
      expect(wire(latest().sent[latest().sent.length - 1]).since_seq).toBe(0)

      // The replayed event now flows through again rather than being deduped.
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(1) }))
      expect(onEvent).toHaveBeenCalledTimes(1)
    })
  })

  describe('delivery', () => {
    test('an event at or below lastSeq is dropped', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: ev(5) }))
      expect(onEvent).toHaveBeenCalledTimes(1)

      socket.deliver(JSON.stringify({ kind: 'event', event: ev(5) }))
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(4) }))
      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(client.lastSeqs).toEqual({ 'task-1': 5 })
    })

    test('a higher seq is delivered and advances lastSeqs', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: ev(1) }))
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(2) }))

      expect(onEvent.mock.calls.map(([e]) => e.seq)).toEqual([1, 2])
      expect(client.lastSeqs).toEqual({ 'task-1': 2 })
    })

    test('lastSeqs are tracked per task', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: ev(9, 'task-a') }))
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(3, 'task-b') }))
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(1, 'task-b') }))

      expect(client.lastSeqs).toEqual({ 'task-a': 9, 'task-b': 3 })
      expect(onEvent).toHaveBeenCalledTimes(2)
    })

    test('lastSeqs returns a defensive copy', () => {
      const client = make()
      client.seed([ev(4)])
      client.lastSeqs['task-1'] = 999

      expect(client.lastSeqs).toEqual({ 'task-1': 4 })
    })

    test('seed pre-populates lastSeq so a later subscribe resumes after it', () => {
      const client = make()
      client.seed([ev(30, 'task-a'), ev(40, 'task-b'), ev(20, 'task-a')])
      client.start()
      const socket = open()

      client.subscribe('task-a')
      client.subscribe('task-b')

      expect(client.lastSeqs).toEqual({ 'task-a': 30, 'task-b': 40 })
      expect(wire(socket.sent[1])).toEqual({ kind: 'subscribe', task_id: 'task-a', since_seq: 30 })
      expect(wire(socket.sent[2])).toEqual({ kind: 'subscribe', task_id: 'task-b', since_seq: 40 })
    })
  })

  describe('message filtering', () => {
    test('malformed JSON is ignored without throwing', () => {
      const client = make()
      client.start()
      const socket = open()

      expect(() => socket.deliver('{not json')).not.toThrow()
      expect(onEvent).not.toHaveBeenCalled()
      expect(onProtocol).not.toHaveBeenCalled()
    })

    test('non-string frames are coerced then parsed', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.onmessage?.({ data: { seq: 1 } } as MessageEvent<unknown>)
      socket.deliver(JSON.stringify({ kind: 'event', event: ev(1) }))

      expect(onEvent).toHaveBeenCalledTimes(1)
    })

    test('kind !== "event" is ignored by onEvent but surfaced to onProtocol', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'ack', message_id: 'm1' }))

      expect(onEvent).not.toHaveBeenCalled()
      expect(onProtocol).toHaveBeenCalledWith({ kind: 'ack', message_id: 'm1' })
    })

    test('an event frame without an event payload is ignored', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event' }))

      expect(onEvent).not.toHaveBeenCalled()
    })

    test('a non-numeric seq is ignored', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: { task_id: 'task-1', seq: 'abc' } }))

      expect(onEvent).not.toHaveBeenCalled()
      expect(client.lastSeqs).toEqual({})
    })

    test('a missing task_id is ignored', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: { seq: 1 } }))

      expect(onEvent).not.toHaveBeenCalled()
      expect(client.lastSeqs).toEqual({})
    })

    test('a non-string task_id is ignored', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.deliver(JSON.stringify({ kind: 'event', event: { seq: 1, task_id: 7 } }))

      expect(onEvent).not.toHaveBeenCalled()
    })
  })

  describe('reconnect', () => {
    test('close emits reconnecting and schedules a retry', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.close()

      expect(onStatus).toHaveBeenCalledWith('reconnecting', { attempt: 1, nextRetryMs: 500 })
      expect(timers).toHaveLength(1)
      expect(timers[0].ms).toBe(500)
    })

    test('backoff grows and is capped at maxRetryMs', () => {
      const client = make(() => {
        throw new Error('no socket')
      })

      client.start()

      const delays = [timers[timers.length - 1].ms]
      for (let i = 0; i < 6; i += 1) {
        fireRetry()
        delays.push(timers[timers.length - 1].ms)
      }

      expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000])
    })

    // Each attempt opens with a bare "reconnecting" (no delay known yet — the
// socket has not been created), then the failure reports the real delay. The
// delay is derived after #attempt is incremented, so it cannot drift from the
// timer. Before the fix, a retry announced TWICE and nextRetryMs trailed the
// actual scheduled delay by one backoff step.
test('a failed retry reports the delay it actually schedules', () => {
      const client = make(() => {
        throw new Error('no socket')
      })

      client.start()
      fireRetry()

      const announced = onStatus.mock.calls.filter(([status]) => status === 'reconnecting')
      // Sequence for a gateway that always throws:
      //   start()      → #open() as 'connecting', then failure reports 500ms at attempt 1
      //   fireRetry()  → #open() bare at attempt 1 (counter not yet bumped),
      //                  then failure reports 1000ms at attempt 2
      // The bare announcement carries the PRE-increment attempt; the reported
      // delay always matches the delay the timer was actually given.
      expect(announced.map(([, detail]) => detail)).toEqual([
        { attempt: 1, nextRetryMs: 500 },
        { attempt: 1 },
        { attempt: 2, nextRetryMs: 1_000 },
      ])
      // The reported delay must equal the scheduled delay, never lag behind it.
      expect(timers[timers.length - 1].ms).toBe(1_000)
    })

    test('a socketFactory throw schedules a retry instead of propagating', () => {
      const client = make(() => {
        throw new Error('no socket')
      })

      expect(() => client.start()).not.toThrow()
      expect(onStatus).toHaveBeenCalledWith('reconnecting', { attempt: 1, nextRetryMs: 500 })
      expect(timers).toHaveLength(1)
      expect(timers[0].ms).toBe(500)
    })

    test('the retry builds a new socket and re-subscribes with the same since_seq', () => {
      const client = make()
      client.start()
      const first = open()

      first.deliver(JSON.stringify({ kind: 'event', event: ev(41) }))
      first.close()
      fireRetry()

      const second = open()
      expect(second).not.toBe(first)
      expect(sockets).toHaveLength(2)
      expect(wire(second.sent[0])).toEqual({ kind: 'subscribe', task_id: 'task-1', since_seq: 41 })
    })

    test('the backoff resets after a successful open', () => {
      const client = make()
      client.start()
      const first = open()

      first.close()
      fireRetry()
      const second = open()
      second.close()

      expect(timers[timers.length - 1].ms).toBe(500)
    })

    test('an onclose from a stale socket is ignored', () => {
      const client = make()
      client.start()
      const first = open()

      first.close()
      fireRetry()
      open()

      onStatus.mockClear()
      timers.length = 0
      first.close()

      expect(onStatus).not.toHaveBeenCalled()
      expect(timers).toHaveLength(0)
    })
  })

  describe('stop', () => {
    test('closes the socket and emits closed', () => {
      const client = make()
      client.start()
      const socket = open()

      client.stop()

      expect(socket.closed).toBe(true)
      expect(onStatus).toHaveBeenCalledWith('closed')
    })

    test('clears a pending retry and never reconnects', () => {
      const client = make()
      client.start()
      const socket = open()

      socket.close()
      expect(timers).toHaveLength(1)
      const pending = timers[0]

      onStatus.mockClear()
      client.stop()
      pending.handler()

      expect(cleared).toEqual([pending])
      expect(sockets).toHaveLength(1)
      expect(onStatus).not.toHaveBeenCalledWith('reconnecting', expect.anything())
    })

    test('closing after stop does not schedule anything', () => {
      const client = make()
      client.start()
      const socket = open()

      client.stop()
      onStatus.mockClear()
      timers.length = 0
      socket.close()

      expect(timers).toHaveLength(0)
      expect(onStatus).not.toHaveBeenCalled()
    })

    test('reconnect() after stop is a no-op', () => {
      const client = make()
      client.start()
      open()
      client.stop()

      timers.length = 0
      client.reconnect()

      expect(timers).toHaveLength(0)
      expect(sockets).toHaveLength(1)
    })
  })

  describe('reconnect()', () => {
    test('closes the live socket, which schedules a new connection', () => {
      const client = make()
      client.start()
      const first = open()

      client.reconnect()

      expect(first.closed).toBe(true)
      expect(onStatus).toHaveBeenCalledWith('reconnecting', { attempt: 1, nextRetryMs: 500 })
      expect(timers).toHaveLength(1)

      fireRetry()
      open()
      expect(sockets).toHaveLength(2)
    })
  })
})