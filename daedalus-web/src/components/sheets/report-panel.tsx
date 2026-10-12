import { useCallback, useEffect, useState } from 'react'
import { ClipboardCheck, Download, History } from 'lucide-react'
import type { WorkbookCheckpoint } from '@daedalus/core'
import { Panel } from '../common/panel'
import { api, type AnalysisRunResult } from '../../api/client'
import { useDaedalusStore, type AnalysisRunError } from '../../state/taskStore'
import { useWorkbook } from './useWorkbook'
import { useAnalysis } from './useAnalysis'
import { cn } from '../../lib/utils'

/**
 * Riwayat workbook: previous states of workbook.json, snapshotted on
 * every save under .daedalus/workbook-history. Restore is ask-first
 * and never destructive — the current state is snapshotted before it
 * is replaced, so it stays in history.
 */
function WorkbookHistory() {
  const { root } = useWorkbook()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [open, setOpen] = useState(false)
  const [checkpoints, setCheckpoints] = useState<WorkbookCheckpoint[]>([])
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!root) return
    try {
      const result = await api.workbookCheckpoints(root)
      setCheckpoints(result.checkpoints)
    } catch {
      setCheckpoints([])
    }
  }, [root])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const restore = async (name: string): Promise<void> => {
    if (!root || restoring) return
    if (confirmName !== name) {
      // Ask-first: the first click arms, the second one restores.
      setConfirmName(name)
      return
    }
    setConfirmName(null)
    setRestoring(true)
    setHistoryError(null)
    try {
      await api.workbookRestore(root, name)
      bumpWorkspaceRevision()
      await load()
    } catch (restoreError: unknown) {
      setHistoryError(restoreError instanceof Error ? restoreError.message : String(restoreError))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div data-testid="sheet-report-history">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        data-testid="sheet-history-toggle"
        className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground"
      >
        <History className="size-3.5 text-muted" aria-hidden />
        Riwayat workbook
        <span className="text-[10px] font-normal text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="mt-1">
          {checkpoints.length === 0 ? (
            <p className="text-[10px] text-muted">Belum ada checkpoint — setiap penyimpanan workbook otomatis meninggalkan versi sebelumnya di sini.</p>
          ) : (
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-testid="sheet-history-list">
              {checkpoints.map((checkpoint) => (
                <li
                  key={checkpoint.name}
                  className="flex items-center justify-between gap-2 rounded border border-line bg-surface px-2 py-1 text-[10px]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{checkpoint.title ?? 'workbook'}</span>
                    <span className="block text-muted">
                      {new Date(checkpoint.at).toLocaleString()} · {checkpoint.sheets} sheet
                      {checkpoint.stage ? ` · ${checkpoint.stage}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void restore(checkpoint.name)}
                    disabled={restoring}
                    data-testid={`sheet-history-restore-${checkpoint.name}`}
                    className={cn(
                      'shrink-0 rounded border px-1.5 py-0.5',
                      confirmName === checkpoint.name
                        ? 'border-amber-400/60 bg-amber-400/10 text-amber-200'
                        : 'border-line text-muted hover:border-primary hover:text-foreground',
                    )}
                  >
                    {confirmName === checkpoint.name ? 'Klik lagi: pulihkan?' : 'Pulihkan'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {historyError ? <p className="mt-1 text-[10px] text-red-300">Gagal memulihkan: {historyError}</p> : null}
          <p className="mt-1 text-[9px] text-muted">Pemulihan tidak menghapus apa pun: state saat ini ikut tersimpan sebagai checkpoint.</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Panel Laporan: the Verify gate's verdict per cell (errors with their
 * addresses, audit warnings), which verification path actually ran,
 * and the exported files with the export path actually taken
 * (exceljs / exceljs+sidecar / fallback notes) — the report never
 * claims more than ran.
 */
/**
 * Mode Analis: the insight report — findings (each with its cell refs
 * as small badges), recommendations, and the verify gate's summary row
 * in the same badge style as Susun's Verify verdict. A 422
 * verify_failed lists the issues and shows NO report; a 410
 * plan_expired asks for a fresh plan.
 */
function AnalysisInsightView({
  result,
  runError,
  running,
}: {
  result: AnalysisRunResult | null
  runError: AnalysisRunError | null
  running: boolean
}) {
  if (runError?.code === 'verify_failed') {
    return (
      <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="sheet-report-analisis-verify-failed">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
          <ClipboardCheck className="size-3.5 text-muted" aria-hidden />
          Verify gate
          <span className="rounded border border-red-500/40 px-1 py-0.5 text-[9px] uppercase tracking-wide text-red-300">
            gagal
          </span>
        </p>
        <p className="text-[10px] text-muted">
          Gerbang Verify menolak angka-angka analisis — laporan tidak ditulis agar tidak ada angka tak terverifikasi
          yang dinarasikan. Perbaiki datanya, lalu jalankan ulang dari Panel Blueprint.
        </p>
        {runError.issues && runError.issues.length > 0 ? (
          <ul className="flex flex-col gap-0.5" data-testid="sheet-report-analisis-issues">
            {runError.issues.map((issue, index) => (
              <li key={index} className="rounded border border-red-500/30 bg-red-500/5 px-1.5 py-1 font-mono text-[10px] text-red-200">
                {issue.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-red-200">{runError.message}</p>
        )}
      </div>
    )
  }

  if (runError?.code === 'plan_expired') {
    return (
      <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="sheet-report-analisis-expired">
        <p className="text-[11px] font-semibold text-foreground">Rencana kedaluwarsa</p>
        <p className="text-[11px] text-muted">
          Rencana analisis ini sudah tidak ada di server — buat ulang dari composer (pilih dataset, tulis pertanyaan,
          Buat rencana).
        </p>
      </div>
    )
  }

  if (runError) {
    return (
      <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="sheet-report-analisis-error">
        <p className="text-[11px] font-semibold text-foreground">Analisis gagal</p>
        <p className="text-[10px] text-red-300">{runError.message}</p>
      </div>
    )
  }

  if (!result) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted" data-testid="sheet-report-analisis-empty">
        {running
          ? 'Menjalankan analisis — compute → verify → laporan…'
          : 'Belum ada hasil analisis. Buat rencana di Panel Blueprint, review, lalu tekan Jalankan analisis.'}
      </p>
    )
  }

  const { report, verify } = result
  return (
    <div className="flex flex-col gap-2 px-1 py-1" data-testid="sheet-report-analisis">
      <p className="text-[11px] font-semibold text-foreground" data-testid="sheet-report-analisis-question">
        {report.question}
      </p>
      <div data-testid="sheet-report-analisis-verify">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
          <ClipboardCheck className="size-3.5 text-muted" aria-hidden />
          Verify gate
          <span
            className={cn(
              'rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide',
              verify.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300',
            )}
          >
            {verify.ok ? 'lulus' : `${verify.errors.length} error`}
          </span>
        </p>
        <p className="mt-1 text-[10px] text-muted">{verify.summary}</p>
      </div>
      {report.findings.length > 0 ? (
        <div data-testid="sheet-report-analisis-findings">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Temuan</p>
          <ul className="mt-0.5 flex flex-col gap-1.5">
            {report.findings.map((finding, index) => (
              <li key={index} className="rounded border border-line bg-surface px-2 py-1.5">
                <p className="text-[11px] text-foreground">{finding.text}</p>
                {finding.refs.length > 0 ? (
                  <p className="mt-1 flex flex-wrap gap-1" data-testid="sheet-report-analisis-refs">
                    {finding.refs.map((ref, refIndex) => (
                      <span key={refIndex} className="rounded border border-line bg-surface-base px-1 py-0.5 font-mono text-[9px] text-muted">
                        {ref}
                      </span>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.recommendations.length > 0 ? (
        <div data-testid="sheet-report-analisis-recommendations">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Rekomendasi</p>
          <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4">
            {report.recommendations.map((recommendation, index) => (
              <li key={index} className="text-[11px] text-foreground">{recommendation}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.verifiedAt ? (
        <p className="text-[9px] text-muted">Terverifikasi: {new Date(report.verifiedAt).toLocaleString()}</p>
      ) : null}
    </div>
  )
}

export function SheetReportPanel() {
  const mode = useDaedalusStore((state) => state.sheetOptions.mode)
  const { workbook, root } = useWorkbook()
  const { result, runError, running } = useAnalysis()
  const verify = workbook?.verify
  const exportsList = workbook?.exports ?? []

  if (mode === 'analis') {
    return (
      <Panel title="Laporan" data-testid="sheet-report">
        <AnalysisInsightView result={result} runError={runError} running={running} />
      </Panel>
    )
  }

  return (
    <Panel title="Laporan" data-testid="sheet-report">
      {!workbook ? (
        <p className="px-1 py-1 text-[11px] text-muted">Belum ada laporan — workbook belum dibuat.</p>
      ) : (
        <div className="flex flex-col gap-2 px-1 py-1">
          <div data-testid="sheet-report-verify">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
              <ClipboardCheck className="size-3.5 text-muted" aria-hidden />
              Verify gate
              {verify ? (
                <span
                  className={cn(
                    'rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide',
                    verify.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300',
                  )}
                >
                  {verify.ok ? 'lulus' : `${verify.errors.length} error`}
                </span>
              ) : null}
            </p>
            {verify ? (
              <>
                <p className="mt-1 text-[10px] text-muted">
                  Path: <span className="text-foreground">{verify.path}</span>
                  {verify.path === 'partial' ? ' — sebagian formula di luar subset evaluator; tidak diklaim terverifikasi penuh' : ''}
                  {verify.path === 'core' ? ' — LibreOffice tidak terdeteksi, hanya evaluator core' : ''}
                  {' · '}
                  {new Date(verify.at).toLocaleString()}
                </p>
                <p className="text-[10px] text-muted">{verify.summary}</p>
                {verify.errors.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5" data-testid="sheet-report-errors">
                    {verify.errors.slice(0, 30).map((issue, i) => (
                      <li key={i} className="rounded border border-red-500/30 bg-red-500/5 px-1.5 py-1 font-mono text-[10px] text-red-200">
                        {issue.sheet}!{issue.cell} — {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {verify.warnings.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5" data-testid="sheet-report-warnings">
                    {verify.warnings.slice(0, 30).map((issue, i) => (
                      <li key={i} className="rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-1 font-mono text-[10px] text-amber-200">
                        {issue.sheet}!{issue.cell} — {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="mt-1 text-[10px] text-muted">
                Verify belum jalan. Ia wajib sebelum klaim selesai: picu lewat tombol Verify di toolbar kanvas, Buat, ekspor, atau minta “audit workbook ini” di chat.
              </p>
            )}
          </div>

          <WorkbookHistory />

          <div data-testid="sheet-report-exports">
            <p className="text-[11px] font-semibold text-foreground">File ekspor</p>
            {exportsList.length === 0 ? (
              <p className="mt-1 text-[10px] text-muted">Belum ada ekspor. Tombol Ekspor XLSX/CSV ada di toolbar Kanvas Grid.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {exportsList.map((record, i) => {
                  const rel = `workbook/${record.path.split('/').pop()}`
                  return (
                    <li key={i} className="rounded border border-line bg-surface px-2 py-1.5 text-[10px]">
                      <p className="flex items-center gap-2">
                        <a
                          href={api.workbookDownloadUrl(root, rel)}
                          className="font-medium text-primary underline decoration-dotted"
                          data-testid="sheet-report-download"
                        >
                          <Download className="mr-1 inline size-3" aria-hidden />
                          {record.path.split('/').pop()}
                        </a>
                        <span className="text-muted">
                          {record.format.toUpperCase()} · {Math.max(1, Math.round(record.bytes / 1024))} KB · via {record.via}
                        </span>
                      </p>
                      {record.dashboard ? (
                        <p className="mt-0.5 text-muted" data-testid="sheet-report-dashboard">
                          Dashboard “{record.dashboard.sheet}” terkomposisi dalam ekspor: {record.dashboard.tiles} kartu KPI · {record.dashboard.charts} chart · {record.dashboard.slicers} slicer
                        </p>
                      ) : null}
                      {record.note ? <p className="mt-0.5 text-muted">{record.note}</p> : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
