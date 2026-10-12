import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { api } from '../../api/client'
import { cn } from '../../lib/utils'

/**
 * ResearchSourcePreview: preview inline satu sumber di panel tengah,
 * "kek pembaca pdf kek biasa" — semua tipe sumber (PDF, DOCX, halaman web,
 * dll) disajikan server sebagai PDF dan di-render PDF viewer bawaan browser.
 * Tanpa thumbnail sidebar — untuk dibaca. Bila konversi gagal, fallback
 * jujur ke mode baca dari konten yang di-cache saat run.
 */
export function ResearchSourcePreview() {
  const report = useDaedalusStore((state) => state.researchReport)
  const sourceId = useDaedalusStore((state) => state.researchPreviewSourceId)
  const setPreviewSourceId = useDaedalusStore((state) => state.setResearchPreviewSourceId)

  const source = report?.sources.find((s) => s.id === sourceId)
  const [docState, setDocState] = useState<'loading' | 'ready' | 'fallback'>('loading')
  const [readerText, setReaderText] = useState<string | null>(null)

  const docUrl = report && source
    ? `/research/report/${encodeURIComponent(report.reportId)}/source/${encodeURIComponent(source.id)}/document`
    : null

  useEffect(() => {
    if (!report || !source || !docUrl) return
    let cancelled = false
    setDocState('loading')
    setReaderText(null)
    // HEAD request: cek dokumen tersedia tanpa download penuh dulu
    fetch(docUrl, { method: 'HEAD' })
      .then((res) => {
        if (cancelled) return
        if (res.ok && (res.headers.get('content-type') ?? '').includes('application/pdf')) {
          setDocState('ready')
        } else {
          // 415/502/dll → fallback ke mode baca
          return api.researchSourceContent(report.reportId, source.id).then(
            (r) => {
              if (!cancelled) {
                setReaderText(r.content.text || null)
                setDocState('fallback')
              }
            },
            () => {
              if (!cancelled) setDocState('fallback')
            },
          )
        }
      })
      .catch(() => {
        if (!cancelled) setDocState('fallback')
      })
    return () => {
      cancelled = true
    }
  }, [report, source, docUrl])

  if (!source || !report) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted" data-testid="research-source-preview-empty">
        Sumber tidak ditemukan.
      </div>
    )
  }

  const paragraphs = (readerText ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="research-source-preview">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => setPreviewSourceId(null)}
          data-testid="research-preview-back"
          className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-muted hover:text-foreground"
          title="Kembali ke laporan"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Kembali ke laporan
        </button>
        <span className="font-mono text-[11px] text-muted">[{source.id}]</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={source.title}>
          {source.title}
        </span>
        <span
          className={cn(
            'rounded border px-1 text-[10px]',
            source.credibility.tier === 'scopus' ? 'border-purple-500/60 text-purple-300' : 'border-line text-muted',
          )}
          title={source.credibility.detail ?? ''}
        >
          {source.credibility.tier}
          {source.credibility.verified ? '' : ' (terdeteksi)'}
        </span>
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          data-testid="research-preview-external"
          className="inline-flex items-center gap-1 text-[11px] text-primary hover:opacity-80"
          title="Buka di tab baru"
        >
          <ExternalLink className="size-3" aria-hidden />
          Tab baru
        </a>
      </div>

      {docState === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted" data-testid="research-preview-loading">
          Menyiapkan dokumen…
        </div>
      ) : docState === 'ready' && docUrl ? (
        <iframe
          src={docUrl}
          title={source.title}
          data-testid="research-preview-pdf"
          className="min-h-0 flex-1 border-0 bg-[#1a1a1a]"
        />
      ) : paragraphs.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="research-preview-reader">
          <p className="mb-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <FileText className="size-3" aria-hidden />
            Mode baca — dokumen tidak bisa disiapkan sebagai PDF
          </p>
          {paragraphs.slice(0, 60).map((p, i) => (
            <p key={i} className="mb-2.5 text-[12.5px] leading-relaxed text-foreground/90">
              {p.slice(0, 1200)}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center" data-testid="research-preview-error">
          <p className="text-xs text-muted">Dokumen sumber tidak bisa ditampilkan.</p>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            data-testid="research-preview-external-fallback"
            className="text-[11px] text-primary underline"
          >
            Buka di tab baru
          </a>
        </div>
      )}
    </div>
  )
}
