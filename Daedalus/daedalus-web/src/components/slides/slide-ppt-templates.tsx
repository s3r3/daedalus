import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Trash2, Upload } from 'lucide-react'
import { Panel } from '../common/panel'
import { api, type PptTemplateInfo } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { cn } from '../../lib/utils'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * "Template dari PPT" panel (Slide domain, under the Warna & Font panel):
 * a downloaded .pptx is uploaded once and its design — palette, fonts,
 * slide-master background — is extracted by core into a reusable template
 * stored in this workspace. Clicking one restyles the open deck through
 * the same validate-and-commit theme endpoint as the bundled templates;
 * the last applied pick (bundled or imported) wins. The bundled five stay
 * the default: importing never changes a deck until a template is clicked.
 */
export function SlidePptTemplatesPanel() {
  const { deck, root } = useDeck()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const setSlideOptions = useDaedalusStore((state) => state.setSlideOptions)
  const [templates, setTemplates] = useState<PptTemplateInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!root) {
      setTemplates([])
      return
    }
    try {
      const { templates: list } = await api.pptTemplates(root)
      setTemplates(list)
    } catch (loadError: unknown) {
      setError(messageOf(loadError))
    }
  }, [root])

  useEffect(() => {
    void load()
  }, [load])

  const onUpload = async (file: File | undefined): Promise<void> => {
    if (!file || !root) return
    setUploading(true)
    setError(null)
    setNote(null)
    try {
      const { template } = await api.pptTemplateUpload(root, file)
      await load()
      setNote(`Template "${template.name}" tersimpan — klik untuk menerapkannya ke deck.`)
    } catch (uploadError: unknown) {
      setError(messageOf(uploadError))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const apply = async (template: PptTemplateInfo): Promise<void> => {
    setError(null)
    setNote(null)
    if (!deck || !root) {
      setNote('Belum ada deck — buat deck dulu, lalu klik template untuk menerapkannya.')
      return
    }
    setBusyId(template.id)
    try {
      await api.deckTheme(root, { custom_template_id: template.id })
      // The deck now follows the imported design; a stale bundled pending
      // pick must not claim the active state in the panel above.
      setSlideOptions({ templateId: null })
      bumpWorkspaceRevision()
    } catch (applyError: unknown) {
      setError(messageOf(applyError))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (template: PptTemplateInfo): Promise<void> => {
    if (!root) return
    setBusyId(template.id)
    setError(null)
    setNote(null)
    try {
      await api.pptTemplateDelete(root, template.id)
      await load()
      setNote(`Template "${template.name}" dihapus. Deck yang sudah memakai desainnya tidak berubah.`)
    } catch (deleteError: unknown) {
      setError(messageOf(deleteError))
    } finally {
      setBusyId(null)
    }
  }

  const activeId = deck?.theme.customTemplateId

  return (
    <Panel
      title="Template dari PPT"
      data-testid="slide-ppt-templates"
      action={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            className="hidden"
            data-testid="slide-ppt-template-file"
            onChange={(event) => void onUpload(event.target.files?.[0])}
          />
          <button
            type="button"
            data-testid="slide-ppt-template-upload"
            disabled={!root || uploading}
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
          >
            <Upload className="size-3" aria-hidden />
            {uploading ? 'Mengunggah…' : 'Unggah .pptx'}
          </button>
        </>
      }
    >
      {error ? <p className="px-1 py-1 text-[11px] text-muted">{error}</p> : null}
      {note ? (
        <p className="px-1 py-1 text-[11px] text-muted" data-testid="slide-ppt-template-note">
          {note}
        </p>
      ) : null}
      {templates.length === 0 && !error ? (
        <p className="px-1 py-1 text-[11px] text-muted">
          Belum ada template impor. Unggah berkas .pptx — palet warna, font, dan latar master-nya menjadi template yang bisa dipakai ulang di workspace ini.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {templates.map((template) => {
          const active = template.id === activeId
          return (
            <div
              key={template.id}
              className={cn(
                'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors',
                active ? 'border-primary bg-surface-raised' : 'border-line hover:border-primary',
              )}
            >
              <button
                type="button"
                data-testid={`slide-ppt-template-${template.id}`}
                aria-pressed={active}
                disabled={busyId !== null}
                onClick={() => void apply(template)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
              >
                {template.backgroundImageFile && root ? (
                  <img
                    src={api.pptTemplateBackgroundUrl(root, template.id)}
                    alt=""
                    aria-hidden
                    className="mt-0.5 size-6 shrink-0 rounded border border-line object-cover"
                  />
                ) : (
                  <span className="mt-0.5 flex shrink-0 gap-1" aria-hidden>
                    {[template.theme.background, template.theme.accent, template.theme.text].map((color, i) => (
                      <span key={i} className="size-3 rounded-full border border-line" style={{ backgroundColor: color ?? 'transparent' }} />
                    ))}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                    <span className="truncate">{template.name}</span>
                    {active ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : null}
                  </span>
                  <span className="block truncate text-[10px] text-muted">
                    {template.theme.headingFont ?? 'Arial'} / {template.theme.bodyFont ?? 'Arial'}
                    {template.slideSize ? ` · ${template.slideSize.label}` : ''}
                    {template.backgroundImageFile ? ' · latar gambar' : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                data-testid={`slide-ppt-template-delete-${template.id}`}
                aria-label={`Hapus template ${template.name}`}
                disabled={busyId !== null}
                onClick={() => void remove(template)}
                className="mt-0.5 shrink-0 rounded p-0.5 text-muted transition-colors hover:text-foreground disabled:opacity-50"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          )
        })}
      </div>
      <p className="px-1 pt-1.5 text-[10px] text-muted">
        Desain diambil dari PPTX (warna tema, font, latar master); layout slide tetap 50 layout Daedalus. Warna &amp; Font bawaan tetap pilihan bawaan.
      </p>
    </Panel>
  )
}
