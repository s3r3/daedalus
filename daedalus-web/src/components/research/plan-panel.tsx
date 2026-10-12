import { useDaedalusStore } from '../../state/taskStore'
import { useResearch } from './useResearch'
import { cn } from '../../lib/utils'

const STAGE_LABEL: Record<string, string> = {
  execute: 'Mencari',
  evidence: 'Mengumpulkan bukti',
  verify: 'Verifikasi klaim',
  synthesize: 'Menyusun laporan',
  gate: 'Verify gate',
  compile: 'Kompilasi',
}

/**
 * Panel kiri — Rencana Riset. Rencana yang di-stage di-review di sini
 * (sub-pertanyaan + strategi sumber + budget); tombol "Jalankan riset"
 * adalah satu-satunya confirmation gate. Saat run berjalan, panel ini
 * menampilkan progres live per stage + meter budget.
 */
export function ResearchPlanPanel() {
  const plan = useDaedalusStore((state) => state.researchPlan)
  const running = useDaedalusStore((state) => state.researchRunning)
  const progress = useDaedalusStore((state) => state.researchProgress)
  const report = useDaedalusStore((state) => state.researchReport)
  const runError = useDaedalusStore((state) => state.researchRunError)
  const { runResearch } = useResearch()

  const lastEvent = progress.length > 0 ? progress[progress.length - 1] : null

  return (
    <section
      className="rounded-md border border-line bg-surface p-2"
      data-testid="research-plan-panel"
      aria-label="Rencana riset"
    >
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Rencana Riset</h3>
      {!plan && !running && !report ? (
        <p className="text-[11px] text-muted" data-testid="research-plan-empty">
          Belum ada rencana. Tulis pertanyaan riset di atas lalu tekan "Buat rencana riset" — rencananya
          di-review di sini sebelum dijalankan.
        </p>
      ) : null}
      {plan ? (
        <div data-testid="research-plan-staged">
          <p className="mb-1 text-[11px] font-medium">{plan.question}</p>
          <ol className="mb-1 list-decimal pl-4 text-[11px]">
            {plan.subQuestions.map((sq) => (
              <li key={sq.id} className="mb-0.5" data-testid="research-plan-subquestion">
                {sq.text}
                {sq.rationale ? <span className="text-muted"> — {sq.rationale}</span> : null}
              </li>
            ))}
          </ol>
          <p className="mb-1 text-[10px] text-muted">Strategi sumber: {plan.sourceStrategy}</p>
          <p className="mb-2 text-[10px] text-muted" data-testid="research-plan-budget">
            Budget: maks {plan.budget.maxQueries} query · {plan.budget.maxSources} sumber
          </p>
          <button
            type="button"
            data-testid="research-run"
            onClick={() => void runResearch()}
            disabled={running}
            className={cn(
              'rounded border border-primary bg-primary px-3 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50',
            )}
          >
            {running ? 'Riset berjalan…' : 'Jalankan riset'}
          </button>
        </div>
      ) : null}
      {running || progress.length > 0 ? (
        <div className="mt-2" data-testid="research-progress">
          <p className="text-[10px] uppercase tracking-wide text-muted">Progres</p>
          {lastEvent ? (
            <p className="text-[11px]" data-testid="research-progress-latest">
              <span className="font-medium">{STAGE_LABEL[lastEvent.stage] ?? lastEvent.stage}</span>
              {' — '}{lastEvent.detail}
            </p>
          ) : (
            <p className="text-[11px] text-muted">Menyiapkan…</p>
          )}
          {progress.length > 1 ? (
            <p className="text-[10px] text-muted">{progress.length} event</p>
          ) : null}
        </div>
      ) : null}
      {runError ? (
        <p className="mt-2 text-[11px] text-red-300" data-testid="research-run-error">{runError}</p>
      ) : null}
      {report && !running ? (
        <p className="mt-2 text-[10px] text-muted" data-testid="research-report-meta">
          Laporan selesai: {report.claims.length} klaim terverifikasi · {report.sources.length} sumber ·
          {' '}{report.verification.claimsDropped} klaim di-drop
        </p>
      ) : null}
    </section>
  )
}
