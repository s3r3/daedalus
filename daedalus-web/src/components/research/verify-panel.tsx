import { useDaedalusStore } from '../../state/taskStore'

/**
 * Kanan — Verifikasi. Hasil verify gate deterministik: klaim lolos /
 * di-drop, plus konflik sumber yang beda pendapat dimunculkan eksplisit
 * (bukan dikubur di laporan).
 */
export function ResearchVerifyPanel() {
  const report = useDaedalusStore((state) => state.researchReport)
  if (!report) return null
  const v = report.verification

  return (
    <section
      className="rounded-md border border-line bg-surface p-2"
      data-testid="research-verify-panel"
      aria-label="Verifikasi"
    >
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Verifikasi</h3>
      <p className="mb-1 text-[11px]" data-testid="research-verify-summary">
        <span className={v.gatePassed ? 'text-green-400' : 'text-red-400'}>
          {v.gatePassed ? 'LULUS' : 'GAGAL'}
        </span>
        {' — '}{v.claimsVerified} klaim terverifikasi
        {v.claimsDropped > 0 ? `, ${v.claimsDropped} di-drop (low, tanpa sumber valid)` : null}
      </p>
      <p className="mb-1 text-[10px] text-muted" data-testid="research-verify-budget">
        Budget: {report.budget.queriesUsed} query · {report.budget.sourcesFetched} sumber ter-fetch
      </p>
      {report.conflicts.length > 0 ? (
        <div data-testid="research-verify-conflicts">
          <p className="mb-1 text-[10px] font-medium uppercase text-muted">Konflik sumber</p>
          {report.conflicts.map((c, i) => (
            <div key={i} className="mb-1 rounded border border-yellow-500/40 bg-yellow-500/5 p-1.5 text-[11px]">
              <p className="font-medium">{c.topic}</p>
              <ul className="mt-0.5 list-disc pl-4">
                {c.positions.map((p, j) => (
                  <li key={j}><span className="text-muted">[{p.sourceId}]</span> {p.stance}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-muted">Tidak ada konflik antar sumber.</p>
      )}
    </section>
  )
}
