import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { api } from '../../api/client'
import type { ResearchSourceContent } from '../../api/client'
import { cn } from '../../lib/utils'

/**
 * ResearchSourcePreview: preview inline satu sumber di panel tengah —
 * "kek buka di browser": halaman asli di-embed langsung (PDF tampil dengan
 * PDF viewer bawaan browser). Dibuka dengan mengklik [sN] di laporan atau
 * judul sumber di panel kanan. Bila situs memblokir embed (X-Frame-Options /
 * CSP), fallback jujur ke mode baca dari konten yang di-cache saat run.
 */
export function ResearchSourcePreview() {
  const report = useDaedalusStore((state) => state.researchReport)
  const sourceId = useDaedalusStore((state) => state.researchPreviewSourceId)
  const setPreviewSourceId = useDaedalusStore((state) => state.setResearchPreviewSourceId)

  const source = report?.sources.find((s) => s.id === sourceId)
  const [content, setContent] = useState<ResearchSourceContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'embed' | 'reader'>('embed')

  useEffect(() => {
    if (!report || !source) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    api.researchSourceContent(report.reportId, source.id)
      .then((res) => {
        if (!cancelled) setContent(res.content)
      })
      .catch(() => {
        if (!cancelled) setError('Sumber tidak bisa dimuat — buka di tab baru.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [report, source])

  useEffect(() => {
    setView('embed')
  }, [sourceId])

  if (!source) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted" data-testid="research-source-preview-empty">
        Sumber tidak ditemukan.
      </div>
    )
  }

  const paragraphs = (content?.text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  // Embed langsung "kek buka di browser" bila situs mengizinkan; PDF selalu
  // di-embed (viewer bawaan browser) selama frameable.
  const canEmbed = content?.frameable === true
  const hasText = paragraphs.length > 0
  const showEmbed = canEmbed && view === 'embed'
  const showReader = hasText && (!canEmbed || view === 'reader')

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
        {canEmbed && hasText ? (
          <div className="inline-flex overflow-hidden rounded border border-line text-[10px]">
            <button
              type="button"
              data-testid="research-preview-view-embed"
              onClick={() => setView('embed')}
              className={cn('px-1.5 py-0.5', view === 'embed' ? 'bg-primary/15 text-primary' : 'text-muted hover:text-foreground')}
            >
              Browser
            </button>
            <button
              type="button"
              data-testid="research-preview-view-reader"
              onClick={() => setView('reader')}
              className={cn('px-1.5 py-0.5', view === 'reader' ? 'bg-primary/15 text-primary' : 'text-muted hover:text-foreground')}
            >
              Mode baca
            </button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted" data-testid="research-preview-loading">
          Memuat sumber…
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center" data-testid="research-preview-error">
          <p className="text-xs text-error">{error}</p>
          <a href={source.url} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline">
            {source.url}
          </a>
        </div>
      ) : showEmbed ? (
        <iframe
          src={source.url}
          title={source.title}
          data-testid="research-preview-embed"
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox="allow-same-origin allow-scripts allow-popups"
        />
      ) : showReader ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="research-preview-reader">
          <p className="mb-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <FileText className="size-3" aria-hidden />
            Mode baca{!canEmbed ? ' — situs memblokir embed langsung' : ''}
            {content?.cached ? ' · dari cache run' : ''}
          </p>
          {paragraphs.slice(0, 60).map((p, i) => (
            <p key={i} className="mb-2.5 text-[12.5px] leading-relaxed text-foreground/90">
              {p.slice(0, 1200)}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted" data-testid="research-preview-empty-content">
          Konten teks sumber kosong.
        </div>
      )}
    </div>
  )
}
