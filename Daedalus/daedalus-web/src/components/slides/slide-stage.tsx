import { useState } from 'react'
import { ChevronLeft, ChevronRight, FileDown, Pencil, Presentation, RefreshCw } from 'lucide-react'
import type { BlockPosition } from '@daedalus/core'
import { getLayout } from '@daedalus/core/slides/layouts'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { api, type DeckExportResult } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { SlideRenderer } from './slide-renderer'
import { SlideEditor } from './slide-editor'

/**
 * Slide canvas (domain Slide): the deck rendered on a 16:9 stage with a
 * filmstrip underneath. The deck itself lives in the workspace
 * (`deck/deck.json`) and is produced through chat like any other artifact;
 * the Edit toggle opens the in-canvas editor and Export runs core's
 * native PPTX exporter — the canvas is a working surface, not a preview.
 */
export function SlideStage() {
  const { deck, loading, error, refresh, slide, slideCount, safeIndex, root } = useDeck()
  const setSlideIndex = useDaedalusStore((state) => state.setSlideIndex)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [editing, setEditing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<DeckExportResult | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const go = (index: number): void => setSlideIndex(Math.min(Math.max(0, index), Math.max(0, slideCount - 1)))

  const onDeckChanged = (): void => {
    refresh()
    bumpWorkspaceRevision()
  }

  const [dragError, setDragError] = useState<string | null>(null)

  // A finished canvas drag persists the slide's whole position map
  // through the same core-gated update endpoint as form edits; the deck
  // refresh then re-renders from disk, so what the user sees after the
  // drop is exactly what was stored (and what the exporter will draw).
  const persistPositions = async (slideId: string, positions: Record<string, BlockPosition>): Promise<void> => {
    if (!root) return
    setDragError(null)
    try {
      await api.deckUpdateSlide(root, slideId, { positions })
      onDeckChanged()
    } catch (dragErr: unknown) {
      setDragError(`Posisi tidak tersimpan: ${dragErr instanceof Error ? dragErr.message : String(dragErr)}`)
    }
  }

  const exportDeck = async (): Promise<void> => {
    if (!root) return
    setExporting(true)
    setExportError(null)
    try {
      const result = await api.deckExport(root)
      setExported(result)
      bumpWorkspaceRevision()
    } catch (exportErr: unknown) {
      setExportError(exportErr instanceof Error ? exportErr.message : String(exportErr))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div data-testid="slide-stage" className={`flex h-full min-h-0 flex-col gap-2 p-3 ${editing ? 'overflow-y-auto' : 'overflow-hidden'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Presentation className="size-4 text-primary" aria-hidden />
        <strong className="min-w-0 truncate text-xs">{deck ? deck.title : 'Slide'}</strong>
        {deck && slide ? <Badge tone="neutral">{getLayout(slide.layout)?.label ?? slide.layout}</Badge> : null}
        <span className="text-[10px] text-muted">deck/deck.json</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            onClick={() => go(safeIndex - 1)}
            disabled={!deck || safeIndex <= 0}
            aria-label="slide sebelumnya"
            data-testid="slide-prev"
          >
            <ChevronLeft />
          </Button>
          <span data-testid="slide-counter" className="min-w-12 text-center text-[11px] text-muted">
            {deck ? `${safeIndex + 1} / ${slideCount}` : '0 / 0'}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => go(safeIndex + 1)}
            disabled={!deck || safeIndex >= slideCount - 1}
            aria-label="slide berikutnya"
            data-testid="slide-next"
          >
            <ChevronRight />
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} aria-label="muat ulang deck" data-testid="slide-refresh">
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          <Button
            variant={editing ? 'default' : 'outline'}
            size="sm"
            onClick={() => setEditing((value) => !value)}
            disabled={!deck || !slide}
            aria-pressed={editing}
            data-testid="slide-edit-toggle"
          >
            <Pencil />
            Edit
          </Button>
          <Button size="sm" onClick={() => void exportDeck()} disabled={!deck || exporting} data-testid="slide-export">
            <FileDown />
            {exporting ? ' mengekspor…' : ' Export .pptx'}
          </Button>
        </div>
      </div>

      {exported ? (
        <p data-testid="slide-exported" className="text-[11px] text-muted">
          Terekspor: {exported.path} ({Math.max(1, Math.round(exported.bytes / 1024))} KB, {exported.slides} slide) —{' '}
          <a className="text-primary underline" href={api.deckDownloadUrl(exported.root, exported.path)} download>
            unduh .pptx
          </a>
        </p>
      ) : null}
      {exportError ? <p className="text-[11px] text-error">{exportError}</p> : null}
      {dragError ? (
        <p data-testid="slide-drag-error" className="text-[11px] text-error">
          {dragError}
        </p>
      ) : null}

      {!root ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-3 py-6 text-center text-muted">
          <p className="text-xs">Buka workspace dulu…</p>
          <p className="max-w-[44ch] text-[11px] opacity-80">Deck dibaca dari deck/deck.json di workspace aktif.</p>
        </div>
      ) : !deck ? (
        <div data-testid="slide-empty" className="flex flex-1 flex-col items-center justify-center gap-1.5 px-3 py-6 text-center text-muted">
          <p className="text-xs text-foreground">Belum ada deck (deck/deck.json) di workspace ini — minta agent membuatnya lewat chat.</p>
          {error ? <p className="max-w-[52ch] text-[11px] opacity-80">{error}</p> : null}
          {loading ? <p className="text-[11px]">Memuat deck…</p> : null}
        </div>
      ) : slide ? (
        <>
          <div
            data-testid="slide-preview"
            className={`flex items-center justify-center [container-type:size] ${editing ? 'min-h-48 shrink-0' : 'min-h-0 flex-1'}`}
          >
            <div className="aspect-video w-[min(1100px,100%,177.78cqh)] overflow-hidden rounded-md border border-line [container-type:inline-size]">
              <SlideRenderer slide={slide} theme={deck.theme} editable={editing} onPositionsChange={(id, positions) => void persistPositions(id, positions)} />
            </div>
          </div>

          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1" data-testid="slide-filmstrip" aria-label="filmstrip slide">
            {deck.slides.map((entry, index) => {
              const active = index === safeIndex
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-testid={`slide-thumb-${index}`}
                  aria-label={`slide ${index + 1}: ${getLayout(entry.layout)?.label ?? entry.layout}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => go(index)}
                  className={`w-32 shrink-0 overflow-hidden rounded-md border text-left ${active ? 'border-primary' : 'border-line hover:border-primary'}`}
                  style={active ? { boxShadow: '0 0 0 1px var(--daedalus-primary)' } : undefined}
                >
                  <span className="relative block aspect-video w-full [container-type:inline-size]">
                    <span className="pointer-events-none absolute inset-0">
                      <SlideRenderer slide={entry} theme={deck.theme} />
                    </span>
                  </span>
                  <span className="block truncate px-1.5 py-1 text-[10px] text-muted">
                    {index + 1} · {getLayout(entry.layout)?.label ?? entry.layout}
                  </span>
                </button>
              )
            })}
          </div>

          {editing && root ? <SlideEditor root={root} deck={deck} slide={slide} index={safeIndex} onChanged={onDeckChanged} /> : null}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">Deck tidak punya slide.</div>
      )}
    </div>
  )
}
