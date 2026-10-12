import { FileSpreadsheet, X } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { useAnalysis } from '../sheets/useAnalysis'
import type { AnalysisDataset } from '../../api/client'
import { cn } from '../../lib/utils'

function datasetLabel(dataset: AnalysisDataset): string {
  if (dataset.kind === 'workbook') return 'workbook saat ini'
  return dataset.name ?? (dataset.kind === 'csv' ? 'file CSV' : 'file XLSX')
}

/**
 * Spreadsheet composer controls: the Susun|Analis mode is an explicit
 * switch here (never an ask_user question) — Slide's Standard|Smart
 * picker is the model. Susun keeps the existing flow (blueprint
 * staged in the Blueprint panel, built with Buat). In Analis mode the
 * dataset is picked without a second upload button: a CSV/XLSX file
 * attached through the chat's own upload control gets a "Jadikan
 * dataset" action (read client-side, sent inline to
 * /sheets/analyze/plan, never uploaded as a file first), or the
 * current workbook — and "Buat rencana" stages the analysis plan in
 * the Blueprint panel for review before "Jalankan analisis" runs it.
 * Ask/Manual/Auto/Plan do not exist in this domain — this row
 * replaces the mode picker.
 */
export function SheetComposerControls() {
  const sheetOptions = useDaedalusStore((state) => state.sheetOptions)
  const setSheetOptions = useDaedalusStore((state) => state.setSheetOptions)
  const goal = useDaedalusStore((state) => state.composer.goal)
  const root = useDaedalusStore((state) => state.workspace.root)
  const dataset = useDaedalusStore((state) => state.analysisDataset)
  const setAnalysisDataset = useDaedalusStore((state) => state.setAnalysisDataset)
  const clearAnalysis = useDaedalusStore((state) => state.clearAnalysis)
  const { planAnalysis, planning, planError } = useAnalysis()

  const analis = sheetOptions.mode === 'analis'

  const switchMode = (mode: 'susun' | 'analis'): void => {
    setSheetOptions({ mode })
  }

  const useCurrentWorkbook = (): void => {
    if (!root) return
    setAnalysisDataset({ kind: 'workbook', key: root })
  }

  const createPlan = (): void => {
    void planAnalysis(goal, dataset)
  }

  return (
    <>
      <span
        className="inline-flex items-center rounded border border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
        data-testid="sheet-mode-badge"
      >
        Spreadsheet
      </span>
      <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="mode spreadsheet">
        {(['susun', 'analis'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`sheet-mode-${mode}`}
            aria-pressed={sheetOptions.mode === mode}
            onClick={() => switchMode(mode)}
            className={cn(
              'px-2 py-1 text-[11px] capitalize',
              sheetOptions.mode === mode ? 'bg-primary text-white' : 'bg-surface text-muted hover:text-foreground',
            )}
            title={mode === 'susun' ? 'Susun workbook biasa: blueprint di-stage dulu, dibangun dengan Buat' : 'Jawab pertanyaan bisnis dari data: rencana di-stage dulu, dijalankan setelah review'}
          >
            {mode}
          </button>
        ))}
      </div>
      {analis ? (
        <>
          <button
            type="button"
            data-testid="sheet-dataset-workbook"
            onClick={useCurrentWorkbook}
            disabled={!root}
            title={root ? `Pakai workbook yang terbuka di workspace ini` : 'Belum ada workspace'}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-foreground hover:border-primary disabled:opacity-50"
          >
            <FileSpreadsheet className="size-3" aria-hidden />
            Pakai workbook saat ini
          </button>
          {dataset ? (
            <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px]" data-testid="sheet-dataset-chip">
              <FileSpreadsheet className="size-3 text-muted" aria-hidden />
              Dataset: <span className="font-medium">{datasetLabel(dataset)}</span>
              <button
                type="button"
                aria-label="Lepas dataset"
                data-testid="sheet-dataset-remove"
                onClick={() => {
                  setAnalysisDataset(null)
                  clearAnalysis()
                }}
                className="text-muted hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            data-testid="sheet-plan-create"
            onClick={createPlan}
            disabled={!dataset || goal.trim().length === 0 || planning}
            title="Susun rencana analisis dari pertanyaan + dataset — di-review di Panel Blueprint sebelum dijalankan"
            className="rounded border border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {planning ? 'Menyusun rencana…' : 'Buat rencana analisis'}
          </button>
          {planError ? (
            <span className="text-[10px] text-red-300" data-testid="sheet-plan-error">Gagal menyusun rencana: {planError}</span>
          ) : null}
          <span className="text-[10px] text-muted">
            Tulis pertanyaan bisnis di bawah — upload file CSV/XLSX lewat tombol upload di chat lalu tekan “Jadikan dataset”
            pada file-nya, atau pakai workbook saat ini — lalu Buat rencana. Rencana di-review di Panel Blueprint sebelum
            dijalankan. Enter juga membuat rencana.
          </span>
        </>
      ) : (
        <span className="text-[10px] text-muted" data-testid="sheet-composer-note">
          Spreadsheet: blueprint di-stage dulu di Panel Blueprint — tekan Buat untuk membangun. Mode Ask/Manual/Auto/Plan hanya milik Coding.
        </span>
      )}
    </>
  )
}
