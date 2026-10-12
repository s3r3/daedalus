import { useCallback, useEffect, useState } from 'react'
import type { WorkbookSpec } from '@daedalus/core'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Reads the workspace workbook (`workbook/workbook.json`) through the
 * sheets API. Mirrors useDeck's discipline: agent writes bump
 * `workspaceRevision`, task-event growth re-reads while a run is active
 * (so a read that 404'd before the engine wrote the file recovers once
 * the staged blueprint lands), and a missing workbook is an honest
 * empty state (null + no error), never a crash. 404 specifically means
 * "no workbook yet"; other failures surface as error text.
 */
export type UseWorkbookResult = {
  workbook: WorkbookSpec | null
  loading: boolean
  error: string | null
  refresh: () => void
  root: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useWorkbook(): UseWorkbookResult {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const eventCount = useDaedalusStore((state) => state.events.length)
  const [workbook, setWorkbook] = useState<WorkbookSpec | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    if (!root) {
      setWorkbook(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .workbook(root)
      .then((result) => {
        if (cancelled) return
        setWorkbook(result.workbook)
        setError(null)
      })
      .catch((readError: unknown) => {
        if (cancelled) return
        const message = messageOf(readError)
        if (/404|workbook_not_found/i.test(message)) {
          setWorkbook(null)
          setError(null)
        } else {
          setError(message)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, revision, tick, eventCount])

  return { workbook, loading, error, refresh, root }
}
