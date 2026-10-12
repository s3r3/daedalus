import { useMemo } from 'react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './taskStore'

/**
 * Derived hooks. Panels read the raw store slices (stable references) and derive
 * with `useMemo`, which keeps zustand v5 snapshots referentially stable.
 */
export function useTaskEvents(): Event[] {
  const taskId = useDaedalusStore((state) => state.taskId)
  const events = useDaedalusStore((state) => state.events)
  return useMemo(
    () => (taskId ? events.filter((event) => event.task_id === taskId).sort((a, b) => a.seq - b.seq) : []),
    [events, taskId],
  )
}

export function useActiveTaskId(): string | null {
  return useDaedalusStore((state) => state.taskId)
}

export function useConnection(): string {
  return useDaedalusStore((state) => state.connection)
}