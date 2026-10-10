import { ClipboardCheck, Download } from 'lucide-react'
import { Panel } from '../common/panel'
import { api } from '../../api/client'
import { useWorkbook } from './useWorkbook'
import { cn } from '../../lib/utils'

/**
 * Panel Laporan: the Verify gate's verdict per cell (errors with their
 * addresses, audit warnings), which verification path actually ran,
 * and the exported files with the export path actually taken
 * (exceljs / exceljs+sidecar / fallback notes) — the report never
 * claims more than ran.
 */
export function SheetReportPanel() {
  const { workbook, root } = useWorkbook()
  const verify = workbook?.verify
  const exportsList = workbook?.exports ?? []

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
                Verify belum jalan. Ia wajib sebelum klaim selesai: picu lewat Buat, ekspor, atau minta “audit workbook ini” di chat.
              </p>
            )}
          </div>

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
