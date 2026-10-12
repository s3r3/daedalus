import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Trash2, Upload } from 'lucide-react'
import { Panel } from '../common/panel'
import { api, type PptTemplateInfo, type PptTemplatePageInfo } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDeck } from './useDeck'
import { cn } from '../../lib/utils'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mirrors core MAX_PPTX_TEMPLATE_BYTES — the panel refuses oversize files before spending an upload on them. */
const MAX_PPT_TEMPLATE_BYTES = 100 * 1024 * 1024

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',')
}

const PAGE_KIND_LABEL: Record<PptTemplatePageInfo['kind'], string> = {
  cover: 'sampul',
  toc: 'daftar isi',
  section: 'pemisah',
  content: 'isi',
  closing: 'penutup',
}

/** "6 halaman: sampul · daftar isi · pemisah · isi ×2 · penutup" — what designs one click will pour words into. */
function pageSummary(template: PptTemplateInfo): string | null {
  if (!template.pages || template.pages.length === 0) return null
  const counts = new Map<PptTemplatePageInfo['kind'], number>()
  for (const page of template.pages) counts.set(page.kind, (counts.get(page.kind) ?? 0) + 1)
  const parts = (Object.keys(PAGE_KIND_LABEL) as Array<PptTemplatePageInfo['kind']>)
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind)!
      return count > 1 ? `${PAGE_KIND_LABEL[kind]} ×${count}` : PAGE_KIND_LABEL[kind]
    })
  return `${template.pages.length} halaman: ${parts.join(' · ')}`
}

/**
 * "Template impor" panel (Slide domain, under the Warna & Font panel):
 * a downloaded .pptx is uploaded once and its design is extracted by
 * core into a reusable template stored in this workspace — the theme
 * skin (palette, fonts, master background) AND the file's parsed slide
 * designs (pages). Clicking one selects it: generation then pours the
 * outline into those page designs and only the words change — font,
 * color, and layout all come from the template. Templates imported
 * before page parsing existed carry no pages and keep the v1 skin
 * behavior (palette/fonts over the 50 Daedalus layouts). Templates
 * imported before the kept-source (v3) export existed have pages but
 * no source file (`hasSource: false`): exports approximate their
 * design and the export result says so — the card badges them
 * "versi lama" rather than letting the gap stay silent, and uploading
 * the same file again upgrades the record in place. The bundled
 * five stay the default: importing never changes a deck until a
 * template is clicked.
 */
export function SlidePptTemplatesPanel() {
  const { deck, root } = useDeck()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const setSlideOptions = useDaedalusStore((state) => state.setSlideOptions)
  const pendingCustomId = useDaedalusStore((state) => state.slideOptions.customTemplateId)
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
    if (file.size > MAX_PPT_TEMPLATE_BYTES) {
      setNote(null)
      setError(`Berkas ${formatMb(file.size)} MB — melebihi batas ${Math.round(MAX_PPT_TEMPLATE_BYTES / (1024 * 1024))} MB`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setUploading(true)
    setError(null)
    setNote(null)
    try {
      const { template } = await api.pptTemplateUpload(root, file)
      await load()
      const pages = template.pages?.length ?? 0
      setNote(
        pages > 0
          ? `Template "${template.name}" tersimpan (${pages} desain halaman terbaca) — klik untuk memakainya.`
          : `Template "${template.name}" tersimpan — klik untuk menerapkannya ke deck.`,
      )
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
    // One design source at a time: this pick retires any bundled pending
    // pick, and rides the next task when no deck is open yet.
    setSlideOptions({ customTemplateId: template.id, templateId: null })
    if (!deck || !root) {
      setNote(
        template.pages && template.pages.length > 0
          ? `Template "${template.name}" dipilih untuk deck berikutnya — tulis prompt: font, warna, dan layout halaman dari template; AI hanya mengganti kata-katanya.`
          : `Template "${template.name}" dipilih untuk deck berikutnya — palet dan font-nya dipakai; impor ulang berkasnya agar desain halamannya ikut terbaca.`,
      )
      return
    }
    setBusyId(template.id)
    try {
      await api.deckTheme(root, { custom_template_id: template.id })
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
      if (pendingCustomId === template.id) setSlideOptions({ customTemplateId: null })
      await load()
      setNote(`Template "${template.name}" dihapus. Deck yang sudah memakai desainnya tidak berubah.`)
    } catch (deleteError: unknown) {
      setError(messageOf(deleteError))
    } finally {
      setBusyId(null)
    }
  }

  const activeId = deck?.theme.customTemplateId ?? pendingCustomId

  return (
    <Panel
      title="Template impor"
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
          Belum ada template impor. Unggah berkas .pptx — desain halamannya (sampul, isi, penutup) menjadi template: generate berikutnya menuangkan kata-kata ke desain itu.
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
                  {pageSummary(template) ? (
                    <span className="block text-[10px] text-muted" data-testid={`slide-ppt-template-pages-${template.id}`}>
                      {pageSummary(template)}
                    </span>
                  ) : (
                    <span className="block text-[10px] text-muted">Impor ulang untuk memakai desain halamannya</span>
                  )}
                  {template.pages && template.pages.length > 0 && template.hasSource === false ? (
                    <span className="block text-[10px] font-medium text-warning" data-testid={`slide-ppt-template-legacy-${template.id}`}>
                      versi lama — impor ulang untuk desain penuh
                    </span>
                  ) : null}
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
        Pakai template PPT: font, warna, dan layout halaman ikut template — AI hanya mengganti kata-katanya. Slot gambar tidak diisi AI: klik placeholder gambar di canvas (mode Edit) untuk menggantinya. File .pptx hasil Export mempertahankan seluruh elemen desain template (bentuk vektor, grafik, tabel) persis seperti aslinya; tampilan canvas hanya perkiraan. Template bertanda “versi lama” diekspor dengan gambar ulang perkiraan — impor ulang berkas .pptx yang sama agar elemen desainnya utuh. Template bawaan dan Warna &amp; Font di atas tetap pilihan tanpa impor.
      </p>
    </Panel>
  )
}
