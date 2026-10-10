import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Eye, FileText, Paintbrush, Pencil, RefreshCw } from 'lucide-react'
import type { DocumentState, ExtractRecord } from '@daedalus/core'
import { api, dokumenSourceFileUrl, type DokumenPreviewStatus } from '../../api/client'
import { Button } from '../ui/button'
import { useDaedalusStore } from '../../state/taskStore'
import { useDokumen, decisionClass, decisionLabel, fieldStatusClass } from './useDokumen'
import { cn } from '../../lib/utils'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * The Dokumen center canvas. Ekstrak: split view — source page (PDF
 * rendered with pdf.js, the field's bbox overlaid; parsed text blocks
 * otherwise) beside the decision-colored editable records grid; a cell
 * click focuses its provenance, an edit saves a human correction that
 * core re-validates. Susun: the composed sections with inline citation
 * markers. A staged re-layout shows its change list + Terapkan here.
 */
export function DokumenStage() {
  const { document, loading, root, refresh } = useDokumen()

  if (!document) {
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="dokumen-stage-empty">
        <div className="max-w-md text-center">
          <FileText className="mx-auto mb-2 size-8 text-muted" aria-hidden />
          <p className="text-sm font-medium">Belum ada dokumen</p>
          <p className="mt-1 text-[12px] text-muted">
            {loading ? 'Memuat…' : 'Lampirkan sumber dari panel Workspace, pilih Ekstrak/Susun di composer, lalu tulis tujuannya. Skema/kerangka ditinjau dulu di panel kiri — kanvas ini hidup setelah data masuk.'}
          </p>
        </div>
      </div>
    )
  }

  const stagedOps = document.styleOps.filter((op) => !op.applied)
  // The style-ops view owns the canvas while changes are staged, and
  // stays for the result state (all applied) until real extract work
  // (records) or a reset replaces it — that is where the result
  // preview lives.
  const styleResultState =
    document.kind !== 'compose' && document.records.length === 0 && document.styleOps.length > 0 && Boolean(document.styleTarget)
  if (stagedOps.length > 0 || styleResultState) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <StyleOpsView document={document} root={root} refresh={refresh} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dokumen-stage">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="truncate text-[12px] font-semibold">{document.title}</span>
        <span className="rounded border border-line px-1 py-0.5 text-[9px] font-semibold uppercase text-muted">
          {document.kind === 'extract' ? 'Ekstrak' : 'Susun'}
        </span>
        <span className="ml-auto text-[10px] text-muted">document.json adalah sumber kebenaran — ekspor selalu dirender ulang darinya</span>
      </div>
      {document.kind === 'extract' ? (
        <ExtractView document={document} root={root} refresh={refresh} />
      ) : (
        <ComposeView document={document} root={root} refresh={refresh} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- Ekstrak */

type BlocksData = { pages: number; pageSizes: Array<{ width: number; height: number }>; blocks: Array<{ page: number; text: string; bbox?: [number, number, number, number] }> }

function ExtractView({ document, root, refresh }: { document: DocumentState; root: string; refresh: () => void }) {
  const focus = useDaedalusStore((state) => state.dokumenFocus)
  const setFocus = useDaedalusStore((state) => state.setDokumenFocus)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<BlocksData | null>(null)
  const [page, setPage] = useState(1)

  const activeSourceId = focus?.sourceId ?? sourceId ?? document.sources[0]?.id ?? null
  const source = document.sources.find((s) => s.id === activeSourceId) ?? null

  useEffect(() => {
    setBlocks(null)
    if (!root || !activeSourceId) return
    let cancelled = false
    api
      .dokumenBlocks(root, activeSourceId)
      .then((result) => {
        if (!cancelled) setBlocks(result)
      })
      .catch(() => {
        if (!cancelled) setBlocks(null)
      })
    return () => {
      cancelled = true
    }
  }, [root, activeSourceId, document.updatedAt])

  useEffect(() => {
    if (focus) setPage(focus.page)
  }, [focus])

  const focusField = focus ? document.records.find((r) => r.id === focus.recordId)?.fields[focus.field] : undefined
  const bbox = focusField?.provenance?.bbox
  const isPdf = source?.filename.toLowerCase().endsWith('.pdf')

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2" data-testid="dokumen-extract-view">
      {/* Source side */}
      <div className="flex min-h-0 flex-col border-b border-line lg:border-r lg:border-b-0">
        <div className="flex items-center gap-1.5 border-b border-line px-2 py-1">
          <Eye className="size-3.5 text-muted" aria-hidden />
          <select
            aria-label="sumber yang ditampilkan"
            className="h-6 max-w-56 rounded border border-line bg-surface px-1 text-[11px]"
            value={activeSourceId ?? ''}
            onChange={(e) => {
              setSourceId(e.target.value)
              setPage(1)
            }}
          >
            {document.sources.map((s) => (
              <option key={s.id} value={s.id}>{s.filename}</option>
            ))}
          </select>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted">
            <button type="button" className="rounded border border-line px-1" onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
            Hlm {page}{blocks ? ` / ${blocks.pages}` : ''}
            <button type="button" className="rounded border border-line px-1" onClick={() => setPage((p) => Math.min(blocks?.pages ?? p, p + 1))}>›</button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="dokumen-source-view">
          {source && isPdf ? (
            <PdfPage root={root} sourceId={source.id} page={page} bbox={bbox} />
          ) : null}
          {blocks ? (
            <div className="flex flex-col gap-1">
              {blocks.blocks
                .filter((b) => b.page === page)
                .map((block, i) => {
                  const highlighted = focusField?.provenance?.quote
                    ? block.text.toLowerCase().includes(focusField.provenance.quote.toLowerCase().slice(0, 40))
                    : false
                  return (
                    <p
                      key={i}
                      data-testid={highlighted ? 'dokumen-block-highlight' : undefined}
                      className={cn('rounded px-1.5 py-1 font-mono text-[11px] whitespace-pre-wrap', highlighted ? 'bg-amber-400/25 outline outline-amber-500/60' : 'bg-surface')}
                    >
                      {block.text}
                    </p>
                  )
                })}
              {blocks.blocks.filter((b) => b.page === page).length === 0 ? <p className="text-[11px] text-muted">Halaman ini tidak punya blok teks terbaca.</p> : null}
            </div>
          ) : (
            <p className="text-[11px] text-muted">Blok sumber belum tersedia.</p>
          )}
        </div>
        {focusField ? (
          <div className="border-t border-line px-2 py-1.5 text-[11px]" data-testid="dokumen-provenance">
            <span className="font-semibold">{focus?.field}</span>
            {' — '}halaman {focusField.provenance?.page ?? focus?.page ?? 1}
            {focusField.provenance?.quote ? <span className="block truncate text-muted" title={focusField.provenance.quote}>“{focusField.provenance.quote}”</span> : null}
            {focusField.note ? <span className="block text-amber-600 dark:text-amber-400">{focusField.note}</span> : null}
            {focusField.status === 'corrected' ? <span className="block text-sky-600 dark:text-sky-400">Dikoreksi pengguna (asli: {String(focusField.originalValue ?? '—')})</span> : null}
            <span className="block text-muted">keyakinan bacaan {Math.round(focusField.confidence * 100)}%</span>
          </div>
        ) : null}
      </div>

      {/* Grid side */}
      <div className="flex min-h-0 flex-col">
        <div className="overflow-auto" data-testid="dokumen-grid">
          {document.records.length === 0 ? (
            <p className="p-3 text-[11px] text-muted">Belum ada record. Setujui skema di Panel Skema — ekstraksi mengisi tabel ini.</p>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-line bg-surface text-left">
                  <th className="px-2 py-1 font-semibold">Sumber</th>
                  <th className="px-2 py-1 font-semibold">Keputusan</th>
                  {(document.schema?.fields ?? []).map((f) => (
                    <th key={f.name} className="px-2 py-1 font-mono font-semibold">{f.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {document.records.map((record) => (
                  <RecordRow key={record.id} document={document} record={record} root={root} refresh={refresh} focus={focus} setFocus={setFocus} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="border-t border-line px-2 py-1 text-[10px] text-muted">
          Klik sel untuk melihat sumbernya (provenance); sunting lalu Enter untuk mengoreksi — koreksi divalidasi ulang oleh kode, bukan model.
        </p>
      </div>
    </div>
  )
}

function RecordRow({
  document,
  record,
  root,
  refresh,
  focus,
  setFocus,
}: {
  document: DocumentState
  record: ExtractRecord
  root: string
  refresh: () => void
  focus: ReturnType<typeof useDaedalusStore.getState>['dokumenFocus']
  setFocus: (f: ReturnType<typeof useDaedalusStore.getState>['dokumenFocus']) => void
}) {
  const source = document.sources.find((s) => s.id === record.sourceId)
  return (
    <tr className="border-b border-line align-top" data-testid={`dokumen-record-${record.id}`}>
      <td className="px-2 py-1 whitespace-nowrap">
        <span className="block max-w-32 truncate font-medium" title={source?.filename}>{source?.filename ?? record.sourceId}</span>
        <span className="text-[10px] text-muted">{record.page ? `hlm ${record.page}` : 'per dokumen'}</span>
      </td>
      <td className="px-2 py-1">
        <span className={cn('inline-block rounded border px-1 py-0.5 text-[9px] font-semibold uppercase', decisionClass(record.decision))}>{decisionLabel(record.decision)}</span>
      </td>
      {(document.schema?.fields ?? []).map((field) => {
        const fv = record.fields[field.name]
        const isFocus = focus?.recordId === record.id && focus?.field === field.name
        return (
          <td
            key={field.name}
            data-testid={`dokumen-cell-${record.id}-${field.name}`}
            className={cn('px-1 py-1', fv ? fieldStatusClass(fv.status) : '', isFocus ? 'outline outline-primary' : '')}
            onClick={() =>
              setFocus({
                recordId: record.id,
                field: field.name,
                sourceId: record.sourceId,
                page: fv?.provenance?.page ?? record.page ?? 1,
              })
            }
          >
            <CellEditor
              value={fv?.value ?? null}
              status={fv?.status ?? 'escalated'}
              onSave={async (next) => {
                await api.dokumenField(root, record.id, field.name, next)
                refresh()
              }}
            />
            {fv?.status === 'corrected' ? <span className="block text-[9px] text-sky-600 dark:text-sky-400">dikoreksi</span> : null}
          </td>
        )
      })}
    </tr>
  )
}

function CellEditor({ value, status, onSave }: { value: string | number | boolean | null; status: string; onSave: (next: string) => Promise<void> }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setText(value === null ? '' : String(value))
  }, [value])

  const commit = async (): Promise<void> => {
    const original = value === null ? '' : String(value)
    if (text === original || saving) return
    setSaving(true)
    try {
      await onSave(text)
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="flex items-center gap-1">
      <input
        aria-label="nilai field"
        className={cn('h-6 w-full min-w-20 rounded border bg-transparent px-1 font-mono text-[11px]', status === 'escalated' ? 'border-rose-500/50' : 'border-transparent hover:border-line focus:border-line')}
        value={text}
        placeholder={value === null ? '(kosong)' : ''}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {saving ? <span className="text-[9px] text-muted">…</span> : null}
    </span>
  )
}

/** One rendered PDF page (pdf.js) with the focused field's bbox overlaid. */
function PdfPage({ root, sourceId, page, bbox }: { root: string; sourceId: string; page: number; bbox?: [number, number, number, number] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderToken = useRef(0)
  const [scale, setScale] = useState(1)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // Render-generation token: switching sources starts a new render
    // while the previous page may still be painting asynchronously —
    // last-finisher would otherwise win and show the WRONG document
    // under the new selection (seen in the field, 2026-10-10).
    const token = ++renderToken.current
    setFailed(false)
    // Clear synchronously: a blank page while the new source loads is
    // honest; the previous document's page under a new selection is not.
    const stale = canvasRef.current
    if (stale) stale.getContext('2d')?.clearRect(0, 0, stale.width, stale.height)
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string
        const response = await fetch(dokumenSourceFileUrl(root, sourceId))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.arrayBuffer()
        const pdf = await pdfjs.getDocument({ data }).promise
        const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages))
        const canvas = canvasRef.current
        if (!canvas || renderToken.current !== token) return
        const containerWidth = canvas.parentElement?.clientWidth ?? 560
        const unscaled = pdfPage.getViewport({ scale: 1 })
        const fit = Math.max(0.5, Math.min(1.6, (containerWidth - 8) / unscaled.width))
        const viewport = pdfPage.getViewport({ scale: fit })
        canvas.width = viewport.width
        canvas.height = viewport.height
        setScale(fit)
        const context = canvas.getContext('2d')
        if (!context) return
        context.clearRect(0, 0, canvas.width, canvas.height)
        const renderTask = pdfPage.render({ canvasContext: context, viewport })
        await renderTask.promise
        if (renderToken.current !== token) context.clearRect(0, 0, canvas.width, canvas.height)
      } catch {
        if (renderToken.current === token) setFailed(true)
      }
    })()
    return () => {
      renderToken.current += 1
    }
  }, [root, sourceId, page])

  if (failed) return <p className="mb-2 text-[11px] text-muted">Pratinjau PDF tidak tersedia di sesi ini — blok teks di bawah tetap menunjukkan sumbernya.</p>

  return (
    <div className="relative mb-2 w-fit max-w-full" data-testid="dokumen-pdf-page">
      <canvas ref={canvasRef} className="max-w-full rounded border border-line bg-white" />
      {bbox ? (
        <div
          data-testid="dokumen-bbox"
          className="pointer-events-none absolute rounded-sm bg-amber-400/30 outline-2 outline-amber-500"
          style={{ left: bbox[0] * scale, top: bbox[1] * scale, width: Math.max(8, bbox[2] * scale), height: Math.max(8, bbox[3] * scale) }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- Susun */

function ComposeView({ document, root, refresh }: { document: DocumentState; root: string; refresh: () => void }) {
  // Tulis (section text, editable) vs Pratinjau (the render engine's
  // own raster of the composed .docx — faithful, not editable). The
  // preview renders on demand, never per edit.
  const [view, setView] = useState<'write' | 'preview'>('write')
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dokumen-compose-view">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <div className="flex items-center rounded-md border border-line p-0.5" role="group" aria-label="mode tampilan dokumen">
          <Button
            variant={view === 'write' ? 'default' : 'ghost'}
            size="sm"
            className="border-transparent"
            onClick={() => setView('write')}
            aria-pressed={view === 'write'}
            data-testid="dokumen-view-write"
          >
            Tulis
          </Button>
          <Button
            variant={view === 'preview' ? 'default' : 'ghost'}
            size="sm"
            className="border-transparent"
            onClick={() => setView('preview')}
            aria-pressed={view === 'preview'}
            data-testid="dokumen-view-preview"
          >
            Pratinjau
          </Button>
        </div>
        <span className="truncate text-[10px] text-muted">
          Pratinjau dirender engine asli dari .docx yang akan diekspor — Microsoft Word di Windows, kalau tidak LibreOffice
        </span>
      </div>
      {view === 'preview' ? (
        <DokumenPreviewPane root={root} kind="compose" signature={document.updatedAt} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {document.sections.length === 0 ? <p className="text-[11px] text-muted">Belum ada bab. Kerangka muncul dulu di panel Outline.</p> : null}
            {document.sections.map((section, index) => (
              <SectionCard key={section.id} document={document} index={index} sectionId={section.id} root={root} refresh={refresh} />
            ))}
            {Object.keys(document.citations).length > 0 ? (
              <div className="rounded border border-line bg-surface p-2" data-testid="dokumen-citations">
                <p className="mb-1 text-[11px] font-semibold">Sitasi</p>
                <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
                  {Object.values(document.citations).map((c) => (
                    <li key={c.id} className="truncate" title={c.url ?? c.title}>
                      <span className="font-mono">[{c.id}]</span> {c.title}
                      {c.url ? <span className="opacity-70"> — {c.url}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- Pratinjau */

/**
 * Pratinjau pane (Slide's Pratinjau Asli pattern): the exported .docx
 * rasterised by the machine's real engine — Word via COM on Windows,
 * else LibreOffice — cached per document-state hash. Renders only on
 * demand (button), polls while rendering, reports stale honestly when
 * the document moved on. Read-only by nature; editing stays in Tulis.
 */
function DokumenPreviewPane({ root, kind, signature }: { root: string; kind: 'compose' | 'style'; signature: string }) {
  const [preview, setPreview] = useState<DokumenPreviewStatus | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)

  const refreshPreview = useCallback(async (): Promise<void> => {
    if (!root) return
    try {
      setPreview(await api.dokumenPreview(root, kind))
      setFetchError(null)
    } catch (error: unknown) {
      setFetchError(error instanceof Error ? error.message : String(error))
    }
  }, [root, kind])

  // Opening Pratinjau (or a document change while it is open)
  // re-reads the render status; the render itself only starts from
  // the button, so plain editing never triggers the renderer.
  useEffect(() => {
    void refreshPreview()
  }, [refreshPreview, signature])

  // While the engine renders, poll the status until it settles.
  useEffect(() => {
    if (preview?.status !== 'rendering') return
    const timer = setInterval(() => void refreshPreview(), 1200)
    return () => clearInterval(timer)
  }, [preview?.status, refreshPreview])

  // A fresh render (new key) starts at page 1.
  useEffect(() => {
    setPageIndex(0)
  }, [preview?.key])

  // The engine the server selected for this machine, named in the
  // preview copy (generic pair before detection / when unavailable).
  const engineLabel =
    preview?.engine === 'word' ? 'Microsoft Word' : preview?.engine === 'libreoffice' ? 'LibreOffice' : 'Microsoft Word atau LibreOffice'

  const renderPreview = async (): Promise<void> => {
    if (!root) return
    setBusy(true)
    try {
      setPreview(await api.dokumenPreviewRender(root, kind))
      setFetchError(null)
    } catch (error: unknown) {
      setFetchError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const pageUrls = preview?.pageUrls ?? []
  const safeIndex = Math.min(pageIndex, Math.max(0, pageUrls.length - 1))

  return (
    <div data-testid="dokumen-preview" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      {fetchError ? <p className="text-[11px] text-error">Pratinjau gagal dimuat: {fetchError}</p> : null}
      {!preview ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">Memeriksa pratinjau…</div>
      ) : preview.status === 'unavailable' ? (
        <div
          data-testid="dokumen-preview-unavailable"
          className="flex flex-1 flex-col items-center justify-center gap-1.5 px-3 py-6 text-center text-muted"
        >
          <p className="text-xs text-foreground">Pratinjau butuh Microsoft Word (Windows) atau LibreOffice terpasang di mesin ini.</p>
          <p className="max-w-[56ch] text-[11px] opacity-80">
            Halaman persis-asli dirender oleh Microsoft Word lewat COM (Windows) atau LibreOffice (soffice) dan pdftoppm. Tanpa salah
            satunya fitur ini berhenti di sini — menulis, tata ulang, dan ekspor .docx tetap bekerja seperti biasa.
          </p>
        </div>
      ) : preview.status === 'rendering' ? (
        <div data-testid="dokumen-preview-rendering" className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
          <RefreshCw className="animate-spin" aria-hidden />
          <p className="text-xs">Merender halaman dengan {engineLabel}…</p>
        </div>
      ) : preview.status === 'ready' && pageUrls.length > 0 ? (
        <>
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto" data-testid="dokumen-preview-stage">
            <img
              data-testid="dokumen-preview-image"
              src={pageUrls[safeIndex]}
              alt={`Pratinjau halaman ${safeIndex + 1} dari ${pageUrls.length}`}
              className="max-w-full rounded-md border border-line bg-white object-contain"
            />
          </div>
          <div className="flex shrink-0 items-center justify-center gap-2">
            <Button variant="outline" size="icon" onClick={() => setPageIndex(Math.max(0, safeIndex - 1))} disabled={safeIndex <= 0} aria-label="halaman sebelumnya" data-testid="dokumen-preview-prev">
              <ChevronLeft />
            </Button>
            <span className="text-[11px] text-muted" data-testid="dokumen-preview-pager">
              Halaman {safeIndex + 1} dari {pageUrls.length}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPageIndex(Math.min(pageUrls.length - 1, safeIndex + 1))}
              disabled={safeIndex >= pageUrls.length - 1}
              aria-label="halaman berikutnya"
              data-testid="dokumen-preview-next"
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1" data-testid="dokumen-preview-filmstrip" aria-label="filmstrip pratinjau">
            {pageUrls.map((pageUrl, index) => {
              const active = index === safeIndex
              return (
                <button
                  key={pageUrl}
                  type="button"
                  data-testid={`dokumen-preview-thumb-${index}`}
                  aria-label={`halaman pratinjau ${index + 1}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setPageIndex(index)}
                  className={`w-16 shrink-0 overflow-hidden rounded-md border text-left ${active ? 'border-primary' : 'border-line hover:border-primary'}`}
                  style={active ? { boxShadow: '0 0 0 1px var(--daedalus-primary)' } : undefined}
                >
                  <img src={pageUrl} alt="" className="block aspect-[3/4] w-full object-cover" />
                  <span className="block truncate px-1.5 py-1 text-[10px] text-muted">{index + 1} · render asli</span>
                </button>
              )
            })}
          </div>
        </>
      ) : (
        <div
          data-testid="dokumen-preview-status"
          className="flex flex-1 flex-col items-center justify-center gap-1.5 px-3 py-6 text-center text-muted"
        >
          <p className="max-w-[56ch] text-xs text-foreground">
            {preview.status === 'stale'
              ? 'Dokumen berubah sejak pratinjau terakhir dirender — perbarui untuk melihat keadaan terbaru persis-asli.'
              : preview.status === 'error'
                ? `Render pratinjau gagal${preview.error ? `: ${preview.error}` : '.'}`
                : kind === 'style'
                  ? 'Belum ada pratinjau untuk hasil tata ulang ini.'
                  : 'Belum ada pratinjau untuk keadaan dokumen ini.'}
          </p>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[10px] leading-snug text-muted" data-testid="dokumen-preview-caption">
          Pratinjau: halaman dirender {engineLabel} dari berkas .docx{' '}
          {kind === 'style' ? 'hasil tata ulang' : 'yang akan diekspor dari dokumen saat ini'} — persis yang terlihat di Word/LibreOffice,
          bukan teks kanvas. Mengedit tetap di mode Tulis.
        </p>
        {preview?.status !== 'unavailable' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void renderPreview()}
            disabled={busy || !preview || preview.status === 'rendering'}
            data-testid="dokumen-preview-render"
          >
            {busy || preview?.status === 'rendering' ? 'Merender…' : preview?.status === 'ready' ? 'Perbarui pratinjau' : 'Buat pratinjau'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SectionCard({ document, index, sectionId, root, refresh }: { document: DocumentState; index: number; sectionId: string; root: string; refresh: () => void }) {
  const section = document.sections.find((s) => s.id === sectionId)!
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(section.prose)
  useEffect(() => {
    setText(section.prose)
  }, [section.prose])

  const save = async (): Promise<void> => {
    await api.dokumenSection(root, section.id, text)
    setEditing(false)
    refresh()
  }

  return (
    <article className="rounded border border-line bg-surface p-3" data-testid={`dokumen-section-${section.id}`}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">
          {index + 1}. {section.title}
        </h3>
        <span
          className={cn(
            'rounded border px-1 py-0.5 text-[9px] font-semibold uppercase',
            section.status === 'drafted' ? 'border-emerald-500/40 text-emerald-500' : section.status === 'critic-flagged' ? 'border-rose-500/40 text-rose-500' : 'border-line text-muted',
          )}
        >
          {section.status === 'drafted' ? 'tertulis' : section.status === 'critic-flagged' ? 'ditandai kritikus' : 'kerangka'}
        </span>
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted hover:text-foreground" onClick={() => setEditing((v) => !v)}>
          <Pencil className="size-3" aria-hidden /> Sunting
        </button>
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea className="w-full rounded border border-line bg-surface-base p-2 text-[12px]" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" className="self-start" onClick={() => void save()}>
            <Check className="size-3.5" aria-hidden /> Simpan prosa
          </Button>
        </div>
      ) : section.prose ? (
        <>
          {section.status === 'critic-flagged' ? (
            <p className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-600 dark:text-rose-400" data-testid={`dokumen-section-${section.id}-critic-note`}>
              DITANDAI KRITIKUS — periksa: {section.criticIssues && section.criticIssues.length > 0 ? section.criticIssues.join('; ') : 'kritikus menolak draf ini tiga kali; baca ulang sebelum ekspor.'}
            </p>
          ) : null}
          {section.prose.split(/\n\s*\n/).map((para, i) => (
            <p key={i} className="mb-2 text-[12px] leading-relaxed whitespace-pre-wrap">
              {para.split(/(\[SRC-\d+\])/g).map((part, j) =>
                /^\[SRC-\d+\]$/.test(part) ? (
                  <span key={j} className="rounded bg-sky-500/15 px-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-400">{part}</span>
                ) : (
                  <span key={j}>{part}</span>
                ),
              )}
            </p>
          ))}
        </>
      ) : section.status === 'critic-flagged' ? (
        <p className="text-[11px] text-rose-600 dark:text-rose-400" data-testid={`dokumen-section-${section.id}-critic-empty`}>
          Draf ditandai kritikus tetapi teksnya tidak tersimpan — tekan Susun lagi untuk menulis ulang.
        </p>
      ) : (
        <p className="text-[11px] text-muted">Belum ditulis — bab ini menunggu tombol Susun di panel Outline.</p>
      )}
    </article>
  )
}

/* ---------------------------------------------------------- Style ops */

function StyleOpsView({ document, root, refresh }: { document: DocumentState; root: string; refresh: () => void }) {
  const [applying, setApplying] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Result state (every op applied) gains the same Tulis | Pratinjau
  // toggle as Susun: Pratinjau renders the result .docx itself.
  const [view, setView] = useState<'write' | 'preview'>('write')
  const ops = document.styleOps
  const allApplied = ops.length > 0 && ops.every((op) => op.applied)

  const apply = async (): Promise<void> => {
    if (!root || applying) return
    setApplying(true)
    try {
      const result = await api.dokumenRelease(root)
      setNote(result.released ? 'Diterapkan oleh tugas yang berjalan.' : result.applied === 'style' ? `DOCX baru dibuat: ${result.path ?? ''} — berkas asli tidak ditimpa.` : 'Tidak ada gerbang yang menunggu.')
      refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl" data-testid="dokumen-style-view">
      <div className="mb-2 flex items-center gap-2">
        <Paintbrush className="size-4 text-muted" aria-hidden />
        <h3 className="text-[13px] font-semibold">Tata ulang DOCX</h3>
        {document.styleTarget ? <span className="truncate text-[11px] text-muted">{document.styleTarget}</span> : null}
        {allApplied ? (
          <div className="ml-auto flex items-center rounded-md border border-line p-0.5" role="group" aria-label="mode tampilan tata ulang">
            <Button
              variant={view === 'write' ? 'default' : 'ghost'}
              size="sm"
              className="border-transparent"
              onClick={() => setView('write')}
              aria-pressed={view === 'write'}
              data-testid="dokumen-view-write"
            >
              Tulis
            </Button>
            <Button
              variant={view === 'preview' ? 'default' : 'ghost'}
              size="sm"
              className="border-transparent"
              onClick={() => setView('preview')}
              aria-pressed={view === 'preview'}
              data-testid="dokumen-view-preview"
            >
              Pratinjau
            </Button>
          </div>
        ) : null}
      </div>
      {allApplied && view === 'preview' ? (
        <DokumenPreviewPane root={root} kind="style" signature={document.updatedAt} />
      ) : (
        <>
      <p className="mb-2 text-[11px] text-muted">Daftar perubahan deterministik (tanpa model). Berkas asli tidak pernah ditimpa — hasil adalah DOCX baru.</p>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-line bg-surface text-left">
            <th className="px-2 py-1 font-semibold">Target</th>
            <th className="px-2 py-1 font-semibold">Sebelum</th>
            <th className="px-2 py-1 font-semibold">Sesudah</th>
            <th className="px-2 py-1 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody data-testid="dokumen-style-ops">
          {ops.map((op) => (
            <tr key={op.id} className="border-b border-line">
              <td className="px-2 py-1 font-mono">{op.target}</td>
              <td className="px-2 py-1">{op.before}</td>
              <td className="px-2 py-1 font-medium">{op.after}</td>
              <td className="px-2 py-1">{op.applied ? <span className="text-emerald-500">diterapkan</span> : <span className="text-amber-500">menunggu</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ops.some((op) => !op.applied) ? (
        <Button size="sm" className="mt-3" onClick={() => void apply()} disabled={applying} data-testid="dokumen-style-apply">
          <Check className="size-3.5" aria-hidden /> {applying ? 'Menerapkan…' : 'Terapkan'}
        </Button>
      ) : null}
      {note ? <p className="mt-2 text-[11px] text-muted">{note}</p> : null}
        </>
      )}
    </div>
  )
}
