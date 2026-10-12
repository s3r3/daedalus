import { useRef, useState } from 'react'
import { FileSpreadsheet, Upload, X } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { useAnalysis } from '../sheets/useAnalysis'
import type { AnalysisDataset } from '../../api/client'
import { cn } from '../../lib/utils'

const ACCEPT = '.csv,.xlsx'

/** Read a picked file as an inline analysis dataset: CSV as text, XLSX as base64. */
function readDatasetFile(file: File): Promise<AnalysisDataset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Gagal membaca ${file.name}`))
    if (file.name.toLowerCase().endsWith('.csv')) {
      reader.onload = () => resolve({ kind: 'csv', text: typeof reader.result === 'string' ? reader.result : '', name: file.name })
      reader.readAsText(file)
    } else {
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        const base64 = dataUrl.includes(',') ? (dataUrl.split(',')[1] ?? '') : dataUrl
        resolve({ kind: 'xlsx', base64, name: file.name })
      }
      reader.readAsDataURL(file)
    }
  })
}

function datasetLabel(dataset: AnalysisDataset): string {
  if (dataset.kind === 'workbook') return 'workbook saat ini'
  return dataset.name ?? (dataset.kind === 'csv' ? 'file CSV' : 'file XLSX')
}

/**
 * Spreadsheet composer controls: the Susun|Analis mode is an explicit
 * switch here (never an ask_user question) — Slide's Standard|Smart
 * picker is the model. Susun keeps the existing flow (blueprint
 * staged in the Blueprint panel, built with Buat). In Analis mode the
 * dataset picker stages the data for the analysis: an uploaded
 * CSV/XLSX (sent inline to /sheets/analyze/plan, never uploaded as a
 * file first) or the current workbook — and "Buat rencana" stages the
 * analysis plan in the Blueprint panel for review before "Jalankan
 * analisis" runs it. Ask/Manual/Auto/Plan do not exist in this domain
 * — this row replaces the mode picker.
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
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const analis = sheetOptions.mode === 'analis'

  const switchMode = (mode: 'susun' | 'analis'): void => {
    setSheetOptions({ mode })
  }

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setReading(true)
    setReadError(null)
    try {
      setAnalysisDataset(await readDatasetFile(file))
    } catch (readErr: unknown) {
      setReadError(readErr instanceof Error ? readErr.message : String(readErr))
    } finally {
      setReading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            data-testid="sheet-dataset-input"
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
          <button
            type="button"
            data-testid="sheet-dataset-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={reading}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-foreground hover:border-primary"
          >
            <Upload className="size-3" aria-hidden />
            {reading ? 'Membaca…' : 'Upload CSV/XLSX'}
          </button>
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
          {readError ? (
            <span className="text-[10px] text-red-300" data-testid="sheet-dataset-error">{readError}</span>
          ) : null}
          {planError ? (
            <span className="text-[10px] text-red-300" data-testid="sheet-plan-error">Gagal menyusun rencana: {planError}</span>
          ) : null}
          <span className="text-[10px] text-muted">
            Tulis pertanyaan bisnis di bawah, pilih dataset, lalu Buat rencana — rencana di-review di Panel Blueprint sebelum dijalankan. Enter juga membuat rencana.
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
