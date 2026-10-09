import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { Slide } from '@daedalus/core'
import { getLayout } from '@daedalus/core/slides/layouts'
import { Panel } from '../common/panel'
import { api, type BuiltinTemplateInfo } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { SlideRenderer } from './slide-renderer'
import { cn } from '../../lib/utils'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One real slide, rendered by the real renderer, as a card preview — never a fake thumbnail. */
function MiniSlide({ template, kind, label }: { template: BuiltinTemplateInfo; kind: 'cover' | 'content'; label: string }) {
  const layoutId = template.design[kind][0] ?? (kind === 'cover' ? 'title' : 'bullets')
  const layout = getLayout(layoutId)
  if (!layout) return null
  const sample: Record<string, unknown> = { title: kind === 'cover' ? 'Judul Presentasi' : 'Judul Konten' }
  if ('subtitle' in layout.defaults) sample.subtitle = 'Subjudul contoh'
  if ('points' in layout.defaults) sample.points = ['Poin contoh pertama', 'Poin contoh kedua']
  if ('lead' in layout.defaults) sample.lead = 'Contoh kalimat pembuka untuk slide ini.'
  if ('text' in layout.defaults) sample.text = 'Contoh kutipan untuk pratinjau desain.'
  const slide: Slide = {
    id: `contoh-${template.id}-${kind}`,
    layout: layoutId,
    content: { ...layout.defaults, ...sample },
  }
  const theme = { ...template.theme, templateId: template.skinId, designId: template.id }
  return (
    <span className="block w-16 shrink-0" aria-hidden>
      <span className="relative block aspect-video w-full overflow-hidden rounded border border-line [container-type:inline-size]">
        <span className="pointer-events-none absolute inset-0">
          <SlideRenderer slide={slide} theme={theme} slideIndex={kind === 'cover' ? 0 : 1} />
        </span>
      </span>
      <span className="mt-0.5 block text-center text-[9px] text-muted">{label}</span>
    </span>
  )
}

/**
 * "Template bawaan" panel (Slide domain, under the outline): Daedalus's
 * own design templates — distinct design languages (per-kind layout
 * choices, layered decorative furniture, typography) built on the
 * Warna & Font skins below. Picking one applies its design to the open
 * deck at once, or rides the next task as the design the outline is
 * poured into. An imported PPT template (Template impor) is the other
 * design source; the two never combine on one deck. A Warna & Font
 * pick afterwards re-skins the deck without removing its design.
 */
export function SlideBuiltinTemplatesPanel() {
  const { deck, root } = useDeck()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const pendingDesignId = useDaedalusStore((state) => state.slideOptions.designId)
  const setSlideOptions = useDaedalusStore((state) => state.setSlideOptions)
  const [templates, setTemplates] = useState<BuiltinTemplateInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .builtinTemplates()
      .then(({ templates: list }) => {
        if (!cancelled) setTemplates(list)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(messageOf(loadError))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activeId = deck ? (deck.theme.designId ?? null) : (pendingDesignId ?? 'standar')

  const pick = async (template: BuiltinTemplateInfo): Promise<void> => {
    // One design source at a time: a built-in pick retires a pending
    // imported-PPT pick. A Warna & Font skin pick is a layer, kept.
    setSlideOptions({ designId: template.id, customTemplateId: null })
    if (!deck || !root) return
    setBusyId(template.id)
    setError(null)
    try {
      await api.deckTheme(root, { design_id: template.id })
      bumpWorkspaceRevision()
    } catch (applyError: unknown) {
      setError(messageOf(applyError))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Panel title="Template bawaan" data-testid="slide-builtin-templates">
      {error ? <p className="px-1 py-1 text-[11px] text-muted">{error}</p> : null}
      {templates.length === 0 && !error ? <p className="px-1 py-1 text-[11px] text-muted">Memuat template bawaan…</p> : null}
      <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-0.5">
        {templates.map((template) => {
          const active = template.id === activeId
          return (
            <button
              key={template.id}
              type="button"
              data-testid={`slide-builtin-template-${template.id}`}
              aria-pressed={active}
              disabled={busyId !== null}
              onClick={() => void pick(template)}
              className={cn(
                'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors',
                active ? 'border-primary bg-surface-raised' : 'border-line hover:border-primary',
              )}
            >
              <span className="flex shrink-0 gap-1.5 pt-0.5">
                <MiniSlide template={template} kind="cover" label="sampul" />
                <MiniSlide template={template} kind="content" label="isi" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                  {template.name}
                  {active ? <Check className="size-3 text-primary" aria-hidden /> : null}
                </span>
                <span className="block text-[10px] leading-snug text-muted">{template.description}</span>
                <span className="block text-[10px] text-muted opacity-80">
                  {template.theme.headingFont ?? 'Arial'} / {template.theme.bodyFont ?? 'Arial'}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="px-1 pt-1.5 text-[10px] text-muted">
        {deck
          ? 'Klik template untuk mengganti desain deck ini (layout pilihan tetap, kulit & ornamen ikut desain baru).'
          : 'Template terpilih menjadi desain deck berikutnya: outline dituangkan ke layout, dekorasi, dan tipografinya.'}{' '}
        Warna &amp; Font di bawah menimpa kulitnya saja; Template impor adalah sumber desain lain (tidak digabung).
      </p>
    </Panel>
  )
}
