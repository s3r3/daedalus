import { useCallback, useEffect, useState } from 'react'
import type { DeckSpec, Slide } from '@daedalus/core'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * Reads the workspace deck (`deck/deck.json`) through the existing file API.
 * The deck is a workspace artifact like any other file: agent writes bump
 * `workspaceRevision`, which re-reads it here, and `refresh()` forces a
 * re-read on demand. Task-event growth also re-reads while a run is
 * active, so a read that failed before the deck existed recovers on its
 * own once the run announces progress (the 2026-10-09 hang: a staged
 * outline waited behind a latched ENOENT and the Buat button could
 * never render). A missing or malformed deck is an honest empty state
 * (deck null + error), never a crash.
 */
export type UseDeckResult = {
  deck: DeckSpec | null
  loading: boolean
  error: string | null
  refresh: () => void
  /** Currently selected slide, clamped into range (null when no deck). */
  slide: Slide | null
  slideCount: number
  /** slideIndex clamped to the deck's range. */
  safeIndex: number
  root: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDeckSpec(value: unknown): value is DeckSpec {
  if (typeof value !== 'object' || value === null) return false
  const deck = value as Partial<DeckSpec>
  return deck.version === 1 && typeof deck.title === 'string' && Array.isArray(deck.slides)
}

export function useDeck(): UseDeckResult {
  const root = useDaedalusStore((state) => state.workspace.root)
  const revision = useDaedalusStore((state) => state.workspaceRevision)
  // Backstop retry driver: while a task runs, its event stream grows.
  // A deck read that failed before the engine wrote deck.json (the
  // pre-run ENOENT state) must not stay latched until a manual
  // refresh — the next task event re-reads. While a run is parked at
  // the staging gate no events arrive, so this never busy-polls.
  const eventCount = useDaedalusStore((state) => state.events.length)
  const slideIndex = useDaedalusStore((state) => state.slideIndex)
  const [deck, setDeck] = useState<DeckSpec | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    if (!root) {
      setDeck(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .file(root, 'deck/deck.json')
      .then((file) => {
        if (cancelled) return
        const raw = (file as { content?: unknown }).content
        if (typeof raw !== 'string' || raw.trim() === '') {
          setDeck(null)
          setError('deck/deck.json tidak berisi teks JSON.')
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (parseError) {
          setDeck(null)
          setError(`deck/deck.json tidak bisa dibaca: ${messageOf(parseError)}`)
          return
        }
        if (!isDeckSpec(parsed)) {
          setDeck(null)
          setError('deck/deck.json tidak valid: butuh {version:1, title, slides[]}.')
          return
        }
        setDeck(parsed)
        setError(null)
      })
      .catch((readError: unknown) => {
        if (cancelled) return
        setDeck(null)
        setError(`Belum bisa membaca deck/deck.json: ${messageOf(readError)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [root, revision, tick, eventCount])

  const slideCount = deck?.slides.length ?? 0
  const safeIndex = slideCount === 0 ? 0 : Math.min(Math.max(0, slideIndex), slideCount - 1)
  const slide = deck?.slides[safeIndex] ?? null

  return { deck, loading, error, refresh, slide, slideCount, safeIndex, root }
}
