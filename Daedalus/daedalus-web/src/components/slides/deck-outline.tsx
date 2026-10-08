import type { Slide } from '@daedalus/core'
import { getLayout } from '@daedalus/core/slides/layouts'
import { Panel } from '../common/panel'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { cn } from '../../lib/utils'

/**
 * Left-column deck outline for the Slide domain: a numbered list that
 * mirrors the filmstrip selection. It reads the same deck hook as the
 * stage, so both surfaces always agree about which slide is open.
 */
function previewOf(slide: Slide): string {
  const title = slide.content.title
  if (typeof title === 'string' && title.trim() !== '') return title
  const text = slide.content.text
  if (typeof text === 'string' && text.trim() !== '') return text
  return slide.id
}

export function DeckOutlinePanel() {
  const { deck, loading, error, safeIndex } = useDeck()
  const setSlideIndex = useDaedalusStore((state) => state.setSlideIndex)

  return (
    <Panel title="Outline deck" data-testid="deck-outline">
      {!deck ? (
        <p className="px-1 py-1 text-[11px] text-muted">
          {loading ? 'Memuat deck…' : 'Tidak ada deck'}
          {error ? <span className="block opacity-80">{error}</span> : null}
        </p>
      ) : (
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
      )}
    </Panel>
  )
}
