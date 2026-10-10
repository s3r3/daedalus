import { FileText, X } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { cn } from '../../lib/utils'

/**
 * Dokumen composer controls: the Ekstrak|Susun sub-mode is an explicit
 * switch here (never an ask_user question), picked sources ride along
 * as chips, and a DOCX picked for re-layout in the workspace panel
 * shows as the Tata Ulang target. Ask/Manual/Auto/Plan do not exist in
 * this domain — this row replaces the mode picker, like Slide's.
 */
export function DokumenComposerControls() {
  const dokumenOptions = useDaedalusStore((state) => state.dokumenOptions)
  const setDokumenOptions = useDaedalusStore((state) => state.setDokumenOptions)

  const removeSource = (path: string): void => {
    setDokumenOptions({ sources: dokumenOptions.sources.filter((s) => s !== path) })
  }

  return (
    <>
      <span
        className="inline-flex items-center rounded border border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
        data-testid="dokumen-mode-badge"
      >
        Dokumen
      </span>
      <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="sub-mode dokumen">
        {(['ekstrak', 'susun'] as const).map((subMode) => (
          <button
            key={subMode}
            type="button"
            data-testid={`dokumen-submode-${subMode}`}
            aria-pressed={dokumenOptions.subMode === subMode}
            onClick={() => setDokumenOptions({ subMode })}
            className={cn(
              'px-2 py-0.5 text-[11px] font-semibold capitalize transition-colors',
              dokumenOptions.subMode === subMode ? 'bg-primary text-on-primary' : 'text-muted hover:text-foreground',
            )}
          >
            {subMode}
          </button>
        ))}
      </div>
      {dokumenOptions.docxPath ? (
        <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px]" data-testid="dokumen-docx-target">
          <FileText className="size-3" aria-hidden />
          Tata ulang: <span className="font-medium">{dokumenOptions.docxPath}</span>
          <button type="button" aria-label="Batalkan tata ulang" onClick={() => setDokumenOptions({ docxPath: null })} className="text-muted hover:text-foreground">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ) : null}
      {dokumenOptions.sources.map((path) => (
        <span key={path} className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px]" data-testid="dokumen-source-chip">
          <FileText className="size-3" aria-hidden />
          {path.split('/').pop()}
          <button type="button" aria-label={`Lepas ${path}`} onClick={() => removeSource(path)} className="text-muted hover:text-foreground">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <span className="text-[10px] text-muted">
        {dokumenOptions.subMode === 'ekstrak'
          ? 'Pilih berkas dari panel Workspace, lalu tulis tujuannya — skema diusulkan dulu, ekstraksi mulai dari tombol Ekstrak di Panel Skema.'
          : dokumenOptions.docxPath
            ? 'Tulis instruksi tata ulangnya (margin, font, spasi) — perubahan diusulkan dulu, diterapkan dari tombol Terapkan.'
            : 'Tulis topik/tujuan dokumen — kerangka diusulkan dulu, penulisan mulai dari tombol Susun di Panel Outline.'}
      </span>
    </>
  )
}
