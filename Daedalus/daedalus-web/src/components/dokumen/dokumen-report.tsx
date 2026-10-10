import { useState } from 'react'
import { Download, FileDown } from 'lucide-react'
import { Panel } from '../common/panel'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDokumen, decisionClass, decisionLabel } from './useDokumen'
import { cn } from '../../lib/utils'

/**
 * Panel Laporan (right column): the deterministic verdict per record,
 * what the export gate holds back and why, and the export buttons.
 * Nothing here is model prose — every number is counted from
 * document.json, and held-back records are named, never silently mixed
 * into an export (design honesty rule 10c).
 */
export function DokumenReportPanel() {
  const { document, root, refresh } = useDokumen()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const doc = document
  const records = doc?.records ?? []
  const autoClear = records.filter((r) => r.decision === 'auto-clear').length
  const flagged = records.filter((r) => r.decision === 'flag')
  const escalated = records.filter((r) => r.decision === 'escalate')
  const verified = records.filter(
    (r) => r.decision === 'auto-clear' || Object.values(r.fields).every((f) => f.status === 'auto' || f.status === 'corrected'),
  ).length
  const heldBack = records.length - verified

  const run = async (label: string, fn: () => Promise<{ result: { recordCount: number; heldBack: number; path: string } }>): Promise<void> => {
    if (busy) return
    setBusy(label)
    setNote(null)
    try {
      const { result } = await fn()
      setNote(`${label}: ${result.recordCount} keluar${result.heldBack > 0 ? `, ${result.heldBack} tertahan` : ''} → ${result.path}`)
      refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel title="Panel Laporan" data-testid="dokumen-report-panel">
      {!doc ? (
        <p className="px-1 py-1 text-[11px] text-muted">Belum ada dokumen — laporan keputusan ekstraksi muncul di sini.</p>
      ) : doc.kind === 'extract' ? (
        <div className="flex flex-col gap-2 px-1 py-1">
          <div className="grid grid-cols-3 gap-1 text-center" data-testid="dokumen-decision-counts">
            <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-1">
              <p className="text-sm font-bold">{autoClear}</p>
              <p className="text-[9px] uppercase">lolos otomatis</p>
            </div>
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-1">
              <p className="text-sm font-bold">{flagged.length}</p>
              <p className="text-[9px] uppercase">ditandai</p>
            </div>
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-1 py-1">
              <p className="text-sm font-bold">{escalated.length}</p>
              <p className="text-[9px] uppercase">dinaikkan</p>
            </div>
          </div>
          <p className="text-[11px] text-muted">
            {verified} dari {records.length} record terverifikasi
            {heldBack > 0 ? ` — ${heldBack} tertahan dari ekspor sampai diperiksa/dikoreksi di kanvas.` : ' — semua siap ekspor.'}
          </p>
          {[...flagged, ...escalated].length > 0 ? (
            <ul className="flex flex-col gap-1" data-testid="dokumen-held-list">
              {[...flagged, ...escalated].map((record) => {
                const reasons = [
                  ...record.checks.filter((c) => !c.passed).map((c) => c.detail),
                  ...Object.entries(record.fields)
                    .filter(([, f]) => f.status === 'flagged' || f.status === 'escalated')
                    .map(([name, f]) => `${name}: ${f.note ?? f.status}`),
                ]
                return (
                  <li key={record.id} className="rounded border border-line bg-surface px-1.5 py-1 text-[11px]">
                    <span className={cn('mr-1 inline-block rounded border px-1 py-0.5 text-[9px] font-semibold uppercase', decisionClass(record.decision))}>
                      {decisionLabel(record.decision)}
                    </span>
                    <span className="font-medium">{doc.sources.find((s) => s.id === record.sourceId)?.filename ?? record.sourceId}</span>
                    {reasons.slice(0, 2).map((reason, i) => (
                      <span key={i} className="block text-muted">{reason}</span>
                    ))}
                  </li>
                )
              })}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {(['json', 'csv', 'xlsx'] as const).map((format) => (
              <Button key={format} size="sm" variant="ghost" disabled={busy !== null || records.length === 0} onClick={() => void run(`Ekspor ${format.toUpperCase()}`, () => api.dokumenExportData(root, format))} data-testid={`dokumen-export-${format}`}>
                <Download className="size-3.5" aria-hidden /> {format.toUpperCase()}
              </Button>
            ))}
          </div>
          <ExportHistory document={doc} />
          {note ? <p className="text-[10px] text-muted">{note}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-1 py-1">
          <p className="text-[11px] text-muted">
            {doc.sections.filter((s) => s.status === 'drafted').length} bab tertulis
            {doc.sections.some((s) => s.status === 'critic-flagged') ? `, ${doc.sections.filter((s) => s.status === 'critic-flagged').length} ditandai kritikus (periksa sebelum ekspor)` : ''}
            {Object.keys(doc.citations).length > 0 ? `, ${Object.keys(doc.citations).length} sitasi tercatat` : ''}.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy !== null || doc.sections.length === 0} onClick={() => void run('Ekspor DOCX', () => api.dokumenExportDocument(root, 'docx'))} data-testid="dokumen-export-docx">
              <FileDown className="size-3.5" aria-hidden /> DOCX
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null || doc.sections.length === 0} onClick={() => void run('Ekspor PDF', () => api.dokumenExportDocument(root, 'pdf'))} data-testid="dokumen-export-pdf">
              <FileDown className="size-3.5" aria-hidden /> PDF
            </Button>
          </div>
          <ExportHistory document={doc} />
          {note ? <p className="text-[10px] text-muted">{note}</p> : null}
        </div>
      )}
    </Panel>
  )
}

function ExportHistory({ document }: { document: NonNullable<ReturnType<typeof useDokumen>['document']> }) {
  if (document.exports.length === 0) return null
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Riwayat ekspor</p>
      <ul className="flex flex-col gap-0.5" data-testid="dokumen-export-history">
        {[...document.exports].reverse().slice(0, 6).map((exp, i) => (
          <li key={i} className="truncate text-[10px] text-muted" title={exp.path}>
            <span className="font-mono uppercase">{exp.format}</span> — {exp.recordCount} record{exp.heldBack > 0 ? `, ${exp.heldBack} tertahan` : ''} · <span className="font-mono">{exp.path.split('/').pop()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
