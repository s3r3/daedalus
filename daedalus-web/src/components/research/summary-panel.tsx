import { useDaedalusStore } from '../../state/taskStore'

/**
 * Kanan — Ringkasan. Ringkasan eksekutif dari dokumen yang sedang
 * dibuka di panel tengah; ikut tumbuh setiap laporan selesai (MVP:
 * dirender dari report.summary — satu ringkasan per laporan final).
 */
export function ResearchSummaryPanel() {
  const report = useDaedalusStore((state) => state.researchReport)
  if (!report) return null

  return (
    <section
      className="rounded-md border border-line bg-surface p-2"
      data-testid="research-summary-panel"
      aria-label="Ringkasan"
    >
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Ringkasan</h3>
      <p className="text-[12px] leading-relaxed" data-testid="research-summary-text">{report.summary}</p>
    </section>
  )
}
