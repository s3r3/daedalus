import { useCallback, useEffect, useState } from 'react'
import type { DocumentState } from '@daedalus/core'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Reads the workspace's active document (`.daedalus/documents/<id>/
 * document.json`) through the panel API — the useDeck pattern: engine
 * writes bump `workspaceRevision` (FILE_CHANGED), task events re-read
 * while a run is active so a read that failed before the document
 * existed recovers on its own, and `refresh()` forces a re-read. A
 * missing document is an honest empty state, never a crash.
 */
export type UseDokumenResult = {
  document: DocumentState | null
  loading: boolean
  error: string | null
  refresh: () => void
  root: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useDokumen(): UseDokumenResult {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  const eventCount = useDaedalusStore((state) => state.events.length)
  const [document, setDocument] = useState<DocumentState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    if (!root) {
      setDocument(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .dokumenDocument(root)
      .then((result) => {
        if (cancelled) return
        setDocument(result.document)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDocument(null)
        setError(messageOf(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, revision, eventCount, tick])

  return { document, loading, error, refresh, root }
}

/** Decision → display classes (the grid and report share the vocabulary). */
export function decisionClass(decision: string): string {
  if (decision === 'auto-clear') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40'
  if (decision === 'flag') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40'
  return 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/40'
}

export function fieldStatusClass(status: string): string {
  if (status === 'auto') return 'bg-emerald-500/10'
  if (status === 'corrected') return 'bg-sky-500/10'
  if (status === 'flagged') return 'bg-amber-500/15'
  return 'bg-rose-500/15'
}

export function decisionLabel(decision: string): string {
  if (decision === 'auto-clear') return 'Lolos otomatis'
  if (decision === 'flag') return 'Ditandai'
  return 'Dinaikkan'
}
