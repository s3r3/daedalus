import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Copy, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { LAYOUTS } from '@daedalus/core/slides/layouts'
import type { DeckSpec, Slide } from '@daedalus/core'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * In-canvas slide editor (Slide domain): the deck is editable by hand,
 * not preview-only — layout, title, points and the full content JSON of
 * the selected slide, plus add/duplicate/delete/move and a per-slide regenerate.
 * Every write goes through the server's core gate (validateDeck), so an
 * edit that would corrupt the deck is refused with the issues shown.
 * The JSON box is the source of truth; the quick fields write into it.
 */
export function SlideEditor({ root, deck, slide, index, onChanged }: {
  root: string
  deck: DeckSpec
  slide: Slide
  index: number
  onChanged: () => void
}) {
  const setSlideIndex = useDaedalusStore((state) => state.setSlideIndex)
  const [layout, setLayout] = useState(slide.layout)
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newLayout, setNewLayout] = useState('bullets')

  useEffect(() => {
    setLayout(slide.layout)
    setJson(JSON.stringify(slide.content, null, 2))
    setError(null)
    setStatus(null)
  }, [slide.id, slide.layout, slide.content])

  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(json)
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }, [json])

  const patchJson = (patch: Record<string, unknown>): void => {
    if (!parsed) return
    setJson(JSON.stringify({ ...parsed, ...patch }, null, 2))
  }

  const titleValue = parsed && typeof parsed.title === 'string' ? parsed.title : ''
  const pointsValue = parsed && Array.isArray(parsed.points) ? parsed.points.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n') : ''

  const run = async (action: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await action()
      onChanged()
      setStatus(done)
    } catch (actionError: unknown) {
      setError(messageOf(actionError))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (!parsed) {
      setError('JSON konten tidak valid — perbaiki dulu sebelum menyimpan.')
      return
    }
    void run(() => api.deckUpdateSlide(root, slide.id, { content: parsed, layout }), 'Slide tersimpan.')
  }

  const duplicate = (): void => {
    // Same server-gated add path as a new slide, seeded with a deep copy
    // of this slide's content; the copy lands right after the original
    // and becomes the selection.
    const content = JSON.parse(JSON.stringify(slide.content)) as Record<string, unknown>
    void run(async () => {
      const result = await api.deckAddSlide(root, { layout: slide.layout, content, index: index + 1 })
      setSlideIndex(index + 1)
      return result
    }, 'Slide diduplikasi.')
  }

  const addSlide = (): void => {
    const def = LAYOUTS.find((entry) => entry.id === newLayout)
    void run(async () => {
      const result = await api.deckAddSlide(root, { layout: newLayout, content: { ...(def?.defaults ?? {}) }, index: index + 1 })
      setSlideIndex(index + 1)
      return result
    }, 'Slide baru ditambahkan.')
  }

  const variant = (): void => {
    // Engine endpoint, not a task: the slide engine regenerates this one
    // slide in place and the fresh deck comes back in the response.
    // Send the composer's current selection — the same model/provider a
    // task run would use. Without it the resolution chain comes up
    // empty for dynamic-model providers (9Router stores no model list)
    // and the request dies upstream with a bare "Missing model".
    const composer = useDaedalusStore.getState().composer
    const pool = composer.modelPool.split(',').map((entry) => entry.trim()).filter(Boolean)
    const model = composer.model || pool[0] || undefined
    void run(
      () =>
        api.deckRegenerateSlide(root, slide.id, {
          ...(model ? { model } : {}),
          ...(composer.providerId ? { provider_id: composer.providerId } : {}),
        }),
      'Slide diganti dengan varian baru.',
    )
  }

  const positionCount = slide.positions ? Object.keys(slide.positions).length : 0

  return (
    <div data-testid="slide-editor" className="flex flex-col gap-2 rounded-md border border-line bg-surface-base p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[11px] uppercase tracking-wide text-muted">Edit slide {index + 1}</strong>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy || index <= 0} onClick={() => void run(() => api.deckMoveSlide(root, slide.id, index - 1), 'Slide dipindah.')} data-testid="slide-move-up">
            <ArrowLeft /> Geser
          </Button>
          <Button variant="outline" size="sm" disabled={busy || index >= deck.slides.length - 1} onClick={() => void run(() => api.deckMoveSlide(root, slide.id, index + 1), 'Slide dipindah.')} data-testid="slide-move-down">
            Geser <ArrowRight />
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={variant} data-testid="slide-variant">
            <Sparkles /> Varian via AI
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={duplicate} data-testid="slide-duplicate">
            <Copy /> Duplikat
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => api.deckDeleteSlide(root, slide.id), 'Slide dihapus.')} data-testid="slide-delete">
            <Trash2 /> Hapus
          </Button>
          {positionCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => api.deckUpdateSlide(root, slide.id, { positions: null }), 'Posisi blok direset ke layout.')}
              data-testid="slide-reset-positions"
            >
              <RotateCcw /> Reset posisi ({positionCount})
            </Button>
          ) : null}
        </div>
      </div>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Layout
        <select
          value={layout}
          onChange={(event) => setLayout(event.target.value)}
          data-testid="slide-editor-layout"
          className="rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-foreground"
        >
          {LAYOUTS.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label} ({entry.id})</option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Judul
        <input
          value={titleValue}
          onChange={(event) => patchJson({ title: event.target.value })}
          data-testid="slide-editor-title"
          className="rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-foreground"
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Poin (satu per baris — untuk layout berbasis poin)
        <textarea
          value={pointsValue}
          onChange={(event) => patchJson({ points: event.target.value.split('\n') })}
          rows={4}
          data-testid="slide-editor-points"
          className="rounded border border-line bg-surface-raised px-2 py-1.5 font-mono text-[11px] text-foreground"
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Konten (JSON — sumber kebenaran slide ini)
        <textarea
          value={json}
          onChange={(event) => setJson(event.target.value)}
          rows={7}
          spellCheck={false}
          data-testid="slide-editor-json"
          className="rounded border border-line bg-surface-raised px-2 py-1.5 font-mono text-[11px] text-foreground"
        />
      </label>

      {error ? <p data-testid="slide-editor-error" className="text-[11px] text-error">{error}</p> : null}
      {status ? <p className="text-[11px] text-muted">{status}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save} data-testid="slide-editor-save">Simpan slide</Button>
        <span className="mx-1 hidden h-4 w-px bg-line sm:block" aria-hidden />
        <select
          value={newLayout}
          onChange={(event) => setNewLayout(event.target.value)}
          data-testid="slide-add-layout"
          className="rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-foreground"
          aria-label="layout slide baru"
        >
          {LAYOUTS.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label}</option>
          ))}
        </select>
        <Button variant="outline" size="sm" disabled={busy} onClick={addSlide} data-testid="slide-add">
          <Plus /> Tambah slide
        </Button>
      </div>
    </div>
  )
}
