import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import type { ResearchClaimView, ResearchSourceView } from '../../api/client'
import { cn } from '../../lib/utils'

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'Tinggi',
  moderate: 'Sedang',
  low: 'Rendah',
}

function ClaimBlock({ claim, sources }: { claim: ResearchClaimView; sources: ResearchSourceView[] }) {
  const [open, setOpen] = useState(false)
  const traceIds = useDaedalusStore((state) => state.researchTraceSourceIds)
  const setTrace = useDaedalusStore((state) => state.setResearchTraceSourceIds)
  const traced = claim.sourceIds.some((id) => traceIds.includes(id))

  const toggleTrace = (): void => {
    setTrace(traced ? [] : claim.sourceIds)
  }

  return (
    <div
      data-testid="research-claim"
      data-claim-id={claim.id}
      className={cn(
        'rounded border px-2 py-1.5 text-[12px]',
        traced ? 'border-primary bg-primary/10' : 'border-line bg-surface-base',
      )}
    >
      <button
        type="button"
        data-testid="research-claim-trace"
        onClick={toggleTrace}
        className="w-full text-left"
        title="Klik untuk menyalakan sumber pendukung di panel kanan"
      >
        <span>{claim.text}</span>
        <span
          className={cn(
            'ml-2 inline-flex rounded border px-1 text-[10px]',
            claim.confidence === 'high' ? 'border-green-500/50 text-green-400'
            : claim.confidence === 'moderate' ? 'border-yellow-500/50 text-yellow-400'
            : 'border-red-500/50 text-red-400',
          )}
          data-testid="research-claim-confidence"
        >
          {CONFIDENCE_LABEL[claim.confidence] ?? claim.confidence}
        </span>
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {claim.sourceIds.map((sid) => {
          const src = sources.find((s) => s.id === sid)
          return (
            <a
              key={sid}
              href={src?.url}
              target="_blank"
              rel="noreferrer"
              data-testid="research-claim-source-link"
              className="text-[10px] text-primary underline underline-offset-2 hover:opacity-80"
              title={src?.title ?? sid}
            >
              [{sid}]
            </a>
          )
        })}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
          kutipan
        </button>
      </div>
      {open ? (
        <ul className="mt-1 space-y-1 border-t border-line pt-1" data-testid="research-claim-excerpts">
          {claim.excerpts.map((ex, i) => (
            <li key={i} className="border-l-2 border-primary/40 pl-2 text-[11px] italic text-muted">
              "{ex}"
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Tengah — Laporan Riset. Dokumen tumbuh section per section dari
 * klaim terverifikasi; tiap klaim bisa diklik untuk jejak klaim
 * (sumber pendukung menyala di panel kanan). Kutipan verbatim bisa
 * di-expand; badge confidence per klaim.
 */
export function ResearchReportView() {
  const report = useDaedalusStore((state) => state.researchReport)
  const running = useDaedalusStore((state) => state.researchRunning)

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface-base p-3"
      data-testid="research-report-view"
      aria-label="Laporan riset"
    >
      {!report && !running ? (
        <div className="flex flex-1 items-center justify-center" data-testid="research-report-empty">
          <p className="max-w-md text-center text-[12px] text-muted">
            Laporan riset akan tumbuh di sini, section per section — setiap klaim menempel ke sumber aslinya
            yang bisa diklik. Mulai dengan "Buat rencana riset", review di panel kiri, lalu "Jalankan riset".
          </p>
        </div>
      ) : null}
      {running && !report ? (
        <div className="flex flex-1 items-center justify-center" data-testid="research-report-loading">
          <p className="text-[12px] text-muted">Riset berjalan — laporan disusun dari klaim terverifikasi…</p>
        </div>
      ) : null}
      {report ? (
        <article data-testid="research-report">
          <h2 className="mb-1 text-[15px] font-semibold" data-testid="research-report-question">{report.question}</h2>
          <p className="mb-3 text-[10px] text-muted" data-testid="research-report-badges">
            <span className="mr-2 rounded border border-green-500/50 px-1 text-green-400">Verify LULUS</span>
            {report.claims.length} klaim · {report.sources.length} sumber
            {report.verification.claimsDropped > 0 ? ` · ${report.verification.claimsDropped} klaim di-drop` : null}
          </p>
          {report.sections.map((section) => (
            <section key={section.id} className="mb-4" data-testid="research-report-section">
              <h3 className="mb-2 text-[13px] font-semibold">{section.title}</h3>
              <div className="flex flex-col gap-2">
                {section.claimIds.map((cid) => {
                  const claim = report.claims.find((c) => c.id === cid)
                  if (!claim) return null
                  return <ClaimBlock key={claim.id} claim={claim} sources={report.sources} />
                })}
              </div>
            </section>
          ))}
          {report.conflicts.length > 0 ? (
            <section className="mb-4" data-testid="research-report-conflicts">
              <h3 className="mb-2 text-[13px] font-semibold">Sumber yang beda pendapat</h3>
              {report.conflicts.map((conflict, i) => (
                <div key={i} className="mb-2 rounded border border-yellow-500/40 bg-yellow-500/5 p-2 text-[12px]">
                  <p className="font-medium">{conflict.topic}</p>
                  <ul className="mt-1 list-disc pl-4">
                    {conflict.positions.map((pos, j) => (
                      <li key={j}>
                        <span className="text-muted">[{pos.sourceId}]</span> {pos.stance}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : null}
          <section className="mb-2" data-testid="research-report-limitations">
            <h3 className="mb-1 text-[13px] font-semibold">Keterbatasan</h3>
            <ul className="list-disc pl-4 text-[11px] text-muted">
              {report.limitations.map((lim, i) => (
                <li key={i}>{lim}</li>
              ))}
            </ul>
          </section>
        </article>
      ) : null}
    </section>
  )
}
