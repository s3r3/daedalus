import { useState } from 'react'
import { X } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

const COUNT_PRESETS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
const LANGUAGES = ['', 'Bahasa Indonesia', 'English', 'Bahasa Melayu', 'العربية']

/**
 * Slide composer controls (Agentic Slide v2, Presenton's lesson):
 * generation flow (Standard's outline checkpoint vs Smart one-pass),
 * slide count and content language are EXPLICIT controls here, so the
 * agent's ask_user never burns a turn asking them. Ask/Manual/Auto/Plan
 * do not exist in this domain — this row replaces the mode picker.
 */
export function SlideComposerControls() {
  const slideOptions = useDaedalusStore((state) => state.slideOptions)
  const setSlideOptions = useDaedalusStore((state) => state.setSlideOptions)
  const [customCount, setCustomCount] = useState(false)

  const countValue = slideOptions.slideCount === null ? 'auto' : customCount ? 'custom' : String(slideOptions.slideCount)

  const onCountSelect = (value: string): void => {
    if (value === 'auto') {
      setCustomCount(false)
      setSlideOptions({ slideCount: null })
      return
    }
    if (value === 'custom') {
      setCustomCount(true)
      if (slideOptions.slideCount === null) setSlideOptions({ slideCount: 10 })
      return
    }
    setCustomCount(false)
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) setSlideOptions({ slideCount: parsed })
  }

  return (
    <>
      <span
        className="inline-flex items-center rounded border border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
        data-testid="slide-mode-badge"
      >
        Slide
      </span>
      <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="mode generasi slide">
        {(['standard', 'smart'] as const).map((generation) => (
          <button
            key={generation}
            type="button"
            data-testid={`slide-gen-${generation}`}
            aria-pressed={slideOptions.generation === generation}
            onClick={() => setSlideOptions({ generation })}
            className={cn(
              'px-2 py-1 text-[11px] capitalize',
              slideOptions.generation === generation ? 'bg-primary text-white' : 'bg-surface text-muted hover:text-foreground',
            )}
            title={generation === 'standard' ? 'Outline dulu, checkpoint arah desain, baru isi slide' : 'Langsung generate dalam satu jalan'}
          >
            {generation}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        slide
        <select
          aria-label="jumlah slide"
          data-testid="slide-count-select"
          className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
          value={countValue}
          onChange={(event) => onCountSelect(event.target.value)}
        >
          <option value="auto">Auto</option>
          {COUNT_PRESETS.map((count) => (
            <option key={count} value={count}>{count}</option>
          ))}
          <option value="custom">Kustom…</option>
        </select>
        {customCount || (slideOptions.slideCount !== null && !COUNT_PRESETS.includes(slideOptions.slideCount)) ? (
          <input
            type="number"
            min={1}
            max={40}
            aria-label="jumlah slide kustom"
            data-testid="slide-count-custom"
            className="h-6 w-16 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={slideOptions.slideCount ?? 10}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              if (Number.isFinite(parsed)) setSlideOptions({ slideCount: Math.max(1, Math.min(40, parsed)) })
            }}
          />
        ) : null}
      </label>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        bahasa
        <select
          aria-label="bahasa konten"
          data-testid="slide-language-select"
          className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
          value={slideOptions.language}
          onChange={(event) => setSlideOptions({ language: event.target.value })}
        >
          {LANGUAGES.map((language) => (
            <option key={language || 'auto'} value={language}>{language === '' ? 'Auto' : language}</option>
          ))}
        </select>
      </label>
      {slideOptions.templateId ? (
        <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted" data-testid="slide-template-chip">
          template: {slideOptions.templateId}
          <button type="button" aria-label="hapus pilihan template" onClick={() => setSlideOptions({ templateId: null })} className="hover:text-foreground">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ) : null}
      <span className="text-[10px] text-muted">Standard berhenti di outline untuk pilih arah desain · Enter mengirim</span>
    </>
  )
}
