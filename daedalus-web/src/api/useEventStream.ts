import { useEffect, useRef } from 'react'
import { EventStreamClient, defaultEventStreamUrl, type StreamStatus } from './eventStream'
import { useDaedalusStore } from '../state/taskStore'

/**
 * Owns the single WebSocket for the app: connects once, feeds the store, and
 * re-subscribes with the active task's last seq so reconnects never duplicate.
 */
export function useEventStream(url: string = defaultEventStreamUrl()): void {
  const taskId = useDaedalusStore((state) => state.taskId)
  const clientRef = useRef<EventStreamClient | null>(null)

  useEffect(() => {
    const client = new EventStreamClient({
      url,
      handlers: {
        onEvent: (event) => useDaedalusStore.getState().appendEvent(event),
        onStatus: (status, detail) => useDaedalusStore.getState().setConnection(status, detail?.attempt ?? 0),
        onTerminal: (message) => useDaedalusStore.getState().applyTerminalMessage(message),
      },
    })
    clientRef.current = client
    useDaedalusStore.getState().setTerminalSubscribe((sessionId) => client.subscribeTerminal(sessionId))
    client.seed(useDaedalusStore.getState().events)
    client.start()
    return () => {
      useDaedalusStore.getState().setTerminalSubscribe(null)
      client.stop()
      clientRef.current = null
    }
  }, [url])

  useEffect(() => {
    if (!taskId) return
    const client = clientRef.current
    if (!client) return
    const lastSeq = useDaedalusStore.getState().events.filter((event) => event.task_id === taskId).at(-1)?.seq ?? 0
    client.subscribe(taskId, lastSeq)
  }, [taskId])
}

export type { StreamStatus }