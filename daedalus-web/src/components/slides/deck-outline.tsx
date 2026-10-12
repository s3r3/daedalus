import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { Slide } from '@daedalus/core'
import { getLayout } from '@daedalus/core/slides/layouts'
import { Panel } from '../common/panel'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { cn } from '../../lib/utils'

/**
 * Left-column deck outline for the Slide domain: a numbered list that
 * mirrors the filmstrip selection. It reads the same deck hook as the
 * stage, so both surfaces always agree about which slide is open.
 *
 * Outline-first flow: a Standard run stages its outline here as a
 * skeleton deck and waits. While any slide is still a skeleton this
 * panel offers the Buat button — generation (fill → validate →
 * export) starts only from that press, with the color & font settled
 * in the Warna & Font panel.
 */
function previewOf(slide: Slide): string {
  const title = slide.content.title
  if (typeof title === 'string' && title.trim() !== '') return title
  const text = slide.content.text
  if (typeof text === 'string' && text.trim() !== '') return text
  return slide.id
}

export function DeckOutlinePanel() {
  const { deck, loading, error, safeIndex, root, refresh } = useDeck()
  const setSlideIndex = useDaedalusStore((state) => state.setSlideIndex)
  const pendingTemplateId = useDaedalusStore((state) => state.slideOptions.templateId)
  const pendingDesignId = useDaedalusStore((state) => state.slideOptions.designId)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [generateNote, setGenerateNote] = useState<string | null>(null)

  const staged = deck !== null && deck.slides.some((slide) => slide.status === 'skeleton')

  const buat = async (): Promise<void> => {
    if (!root || generating) return
    setGenerating(true)
    setGenerateError(null)
    setGenerateNote(null)
    try {
      const templateId = deck?.theme.templateId ?? pendingTemplateId ?? undefined
      const designId = deck?.theme.designId ?? pendingDesignId ?? undefined
      const result = await api.deckGenerate(root, {
        ...(templateId ? { template_id: templateId } : {}),
        ...(designId ? { design_id: designId } : {}),
      })
      setGenerateNote(result.summary)
      refresh()
      bumpWorkspaceRevision()
    } catch (generateErr: unknown) {
      setGenerateError(generateErr instanceof Error ? generateErr.message : String(generateErr))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Panel title="Outline deck" data-testid="deck-outline">
      {!deck ? (
        <div className="px-1 py-1">
          <p className="text-[11px] text-muted">
            {loading ? 'Memuat deck…' : 'Tidak ada deck'}
            {error ? <span className="block opacity-80">{error}</span> : null}
          </p>
          {error && !loading ? (
            <Button size="sm" variant="ghost" onClick={refresh} data-testid="deck-outline-retry" className="mt-1.5">
              Coba lagi
            </Button>
          ) : null}
        </div>
      ) : (
        <>
        <ol className="flex flex-col gap-0.5">
          {deck.slides.map((slide, index) => {
            const active = index === safeIndex
            return (
              <li key={slide.id}>
                <button
                  type="button"
                  data-testid={`deck-outline-item-${index}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSlideIndex(index)}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors',
                    active ? 'border-primary bg-surface-raised text-foreground' : 'border-transparent text-muted hover:text-foreground',
                  )}
                >
                  <span className={cn('font-bold', active ? 'text-primary' : 'text-muted')}>{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{previewOf(slide)}</span>
                    <span className="block truncate text-[10px] uppercase tracking-wide opacity-80">
                      {getLayout(slide.layout)?.label ?? slide.layout}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {staged ? (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
            <Button size="sm" onClick={() => void buat()} disabled={generating || !root} data-testid="deck-generate" className="w-full">
              <Sparkles />
              {generating ? 'Membuat…' : 'Buat'}
            </Button>
            <p className="text-[10px] text-muted">
              Outline di atas masih kerangka — periksa judul, layout, dan urutannya, lalu tekan Buat untuk mengisi semua slide dan export .pptx.
            </p>
            {generateNote ? <p data-testid="deck-generate-note" className="text-[11px] text-muted">{generateNote}</p> : null}
            {generateError ? <p data-testid="deck-generate-error" className="text-[11px] text-error">{generateError}</p> : null}
          </div>
        ) : null}
        </>
      )}
    </Panel>
  )
}
