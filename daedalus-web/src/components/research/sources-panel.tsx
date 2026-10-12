import { Download } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import type { ResearchSourceView } from '../../api/client'
import { cn } from '../../lib/utils'

const TIER_LABEL: Record<string, string> = {
  scopus: 'Scopus',
  sinta1: 'Sinta 1', sinta2: 'Sinta 2', sinta3: 'Sinta 3',
  sinta4: 'Sinta 4', sinta5: 'Sinta 5', sinta6: 'Sinta 6',
  doaj: 'DOAJ', garuda: 'Garuda', scholar: 'Scholar', web: 'Web', unknown: '?',
}

function tierClass(tier: string): string {
  if (tier === 'scopus') return 'border-purple-500/60 text-purple-300'
  if (tier.startsWith('sinta')) {
    const n = Number(tier.slice(5))
    return n <= 2 ? 'border-blue-500/60 text-blue-300' : 'border-sky-500/50 text-sky-300'
  }
  if (tier === 'doaj') return 'border-teal-500/50 text-teal-300'
  if (tier === 'garuda') return 'border-orange-500/50 text-orange-300'
  return 'border-line text-muted'
}

function toBibtex(sources: ResearchSourceView[]): string {
  return sources.map((s, i) => {
    const key = `sumber${i + 1}${s.year ?? ''}`.replace(/[^a-zA-Z0-9]/g, '')
    const lines = [`@misc{${key},`]
    if (s.authors?.length) lines.push(`  author = {${s.authors.join(' and ')}},`)
    lines.push(`  title = {${s.title}},`)
    if (s.year) lines.push(`  year = {${s.year}},`)
    if (s.doi) lines.push(`  doi = {${s.doi}},`)
    lines.push(`  url = {${s.url}},`)
    lines.push('}')
    return lines.join('\n')
  }).join('\n\n') + '\n'
}

function toRis(sources: ResearchSourceView[]): string {
  return sources.map((s) => {
    const lines = ['TY  - ELEC']
    for (const a of s.authors ?? []) lines.push(`AU  - ${a}`)
    lines.push(`TI  - ${s.title}`)
    if (s.year) lines.push(`PY  - ${s.year}///`)
    if (s.doi) lines.push(`DO  - ${s.doi}`)
    lines.push(`UR  - ${s.url}`)
    lines.push('ER  - ')
    return lines.join('\n')
  }).join('\n') + '\n'
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Kanan — Sumber. Daftar sumber evidence pool + badge kredibilitas
 * (Scopus/Sinta 1–6/DOAJ/Garuda/Web) dengan label jujur
 * "terverifikasi" vs "terdeteksi". Jejak klaim: sumber pendukung
 * klaim yang diklik menyala. Export BibTeX/RIS untuk Zotero/Mendeley.
 */
export function ResearchSourcesPanel() {
  const report = useDaedalusStore((state) => state.researchReport)
  const traceIds = useDaedalusStore((state) => state.researchTraceSourceIds)

  if (!report) return null
  const base = (report.reportId || 'riset').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'riset'

  return (
    <section
      className="rounded-md border border-line bg-surface p-2"
      data-testid="research-sources-panel"
      aria-label="Sumber"
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Sumber ({report.sources.length})
        </h3>
        <div className="flex gap-1">
          <button
            type="button"
            data-testid="research-export-bibtex"
            onClick={() => download(`${base}.bib`, toBibtex(report.sources), 'application/x-bibtex')}
            className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] hover:border-primary"
            title="Export BibTeX — import ke Zotero/Mendeley"
          >
            <Download className="size-3" aria-hidden /> BibTeX
          </button>
          <button
            type="button"
            data-testid="research-export-ris"
            onClick={() => download(`${base}.ris`, toRis(report.sources), 'application/x-research-info-systems')}
            className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] hover:border-primary"
            title="Export RIS — import ke Zotero/Mendeley"
          >
            <Download className="size-3" aria-hidden /> RIS
          </button>
        </div>
      </div>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {report.sources.map((s) => {
          const lit = traceIds.includes(s.id)
          return (
            <li
              key={s.id}
              data-testid="research-source"
              data-source-id={s.id}
              className={cn(
                'rounded border px-1.5 py-1 text-[11px]',
                lit ? 'border-primary bg-primary/10' : 'border-line',
              )}
            >
              <div className="flex items-center gap-1">
                <span className="font-mono text-muted">[{s.id}]</span>
                <span
                  data-testid="research-source-tier"
                  className={cn('rounded border px-1 text-[10px]', tierClass(s.credibility.tier))}
                  title={s.credibility.detail ?? ''}
                >
                  {TIER_LABEL[s.credibility.tier] ?? s.credibility.tier}
                  {s.credibility.verified ? '' : ' (terdeteksi)'}
                </span>
              </div>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 block truncate text-primary underline-offset-2 hover:underline"
                title={s.url}
              >
                {s.title}
              </a>
              {s.credibility.detail ? (
                <p className="text-[10px] text-muted">{s.credibility.detail}</p>
              ) : null}
            </li>
          )
        })}
      </ul>
      <details className="mt-1" data-testid="research-bibliography">
        <summary className="cursor-pointer text-[11px] text-primary">Daftar pustaka (sekali klik)</summary>
        <div className="mt-1 flex flex-col gap-2">
          <div>
            <p className="text-[10px] uppercase text-muted">APA</p>
            <ul className="list-disc pl-4 text-[10px]">
              {report.bibliography.apa.map((e, i) => (
                <li key={i} className="mb-0.5 break-words">{e}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted">IEEE</p>
            <ul className="list-disc pl-4 text-[10px]">
              {report.bibliography.ieee.map((e, i) => (
                <li key={i} className="mb-0.5 break-words">{e}</li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </section>
  )
}
