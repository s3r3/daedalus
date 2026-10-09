import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Panel } from '../common/panel'
import { api, type SlideTemplateInfo } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { cn } from '../../lib/utils'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Warna & Font panel (Slide domain, under the outline): the bundled design
 * directions from Farid's reference-repo design — each one is only palette +
 * typography tokens the outline is poured into (hence "Warna & Font", not
 * "Template": the layouts are picked per slide, these only recolor it).
 * Picking one applies it to the open deck at once (core revalidates and
 * persists), or stays pending and rides the next task's create_deck when no
 * deck exists yet.
 */
export function SlideTemplatesPanel() {
  const { deck, root } = useDeck()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const pendingTemplateId = useDaedalusStore((state) => state.slideOptions.templateId)
  const setSlideOptions = useDaedalusStore((state) => state.setSlideOptions)
  const [templates, setTemplates] = useState<SlideTemplateInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .slideTemplates()
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

  const activeId = deck?.theme.templateId ?? pendingTemplateId

  const pick = async (template: SlideTemplateInfo): Promise<void> => {
    setSlideOptions({ templateId: template.id })
    if (!deck || !root) return
    setBusyId(template.id)
    setError(null)
    try {
      await api.deckTheme(root, { template_id: template.id })
      bumpWorkspaceRevision()
    } catch (applyError: unknown) {
      setError(messageOf(applyError))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Panel title="Warna & Font" data-testid="slide-templates">
      {error ? <p className="px-1 py-1 text-[11px] text-muted">{error}</p> : null}
      {templates.length === 0 && !error ? <p className="px-1 py-1 text-[11px] text-muted">Memuat warna & font…</p> : null}
      <div className="flex flex-col gap-1.5">
        {templates.map((template) => {
          const active = template.id === activeId
          return (
            <button
              key={template.id}
              type="button"
              data-testid={`slide-template-${template.id}`}
              aria-pressed={active}
              disabled={busyId !== null}
              onClick={() => void pick(template)}
              className={cn(
                'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors',
                active ? 'border-primary bg-surface-raised' : 'border-line hover:border-primary',
              )}
            >
              <span className="mt-0.5 flex shrink-0 gap-1" aria-hidden>
                {[template.theme.background, template.theme.accent, template.theme.text].map((color, i) => (
                  <span key={i} className="size-3 rounded-full border border-line" style={{ backgroundColor: color ?? 'transparent' }} />
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                  {template.name}
                  {active ? <Check className="size-3 text-primary" aria-hidden /> : null}
                </span>
                <span className="block truncate text-[10px] text-muted">{template.description}</span>
                <span className="block text-[10px] text-muted opacity-80">
                  {template.theme.headingFont ?? 'Arial'} / {template.theme.bodyFont ?? 'Arial'}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="px-1 pt-1.5 text-[10px] text-muted">
        {deck ? 'Klik warna & font untuk menerapkannya ke deck ini.' : 'Warna & font terpilih dipakai saat deck berikutnya dibuat.'}
      </p>
    </Panel>
  )
}
