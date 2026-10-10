import { useEffect, useState } from 'react'
import { FilePlus2, Play, Plus, Save, Trash2 } from 'lucide-react'
import type { DocumentState, FieldDef } from '@daedalus/core'
import { Panel } from '../common/panel'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useDokumen } from './useDokumen'
import { cn } from '../../lib/utils'

const FIELD_TYPES = ['string', 'number', 'money', 'date', 'email', 'boolean'] as const

/**
 * The Dokumen left panel: ONE panel whose top swaps with the composer
 * sub-mode — Panel Skema (Ekstrak) vs Outline (Susun) — over Panel
 * Sumber. Review is staged here, never in a chat question card: the
 * schema/outline waits in this panel, and extraction/writing starts
 * only from the Ekstrak/Susun button (POST /dokumen/release).
 */
export function DokumenPanel() {
  const { document, loading, error, root, refresh } = useDokumen()
  const subMode = useDaedalusStore((state) => state.dokumenOptions.subMode)

  return (
    <>
      {subMode === 'ekstrak' ? (
        <SchemaPanel document={document} loading={loading} error={error} root={root} refresh={refresh} />
      ) : (
        <OutlinePanel document={document} loading={loading} error={error} root={root} refresh={refresh} />
      )}
      <SourcesPanel document={document} root={root} refresh={refresh} />
    </>
  )
}

function useRelease(root: string, refresh: () => void) {
  const [releasing, setReleasing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const release = async (): Promise<void> => {
    if (!root || releasing) return
    setReleasing(true)
    setNote(null)
    try {
      const result = await api.dokumenRelease(root)
      setNote(
        result.released
          ? 'Dilepas — tugas berjalan; hasilnya muncul di kanvas.'
          : result.applied === 'schema-approved'
            ? 'Skema disetujui. Kirim prompt untuk mulai ekstraksi.'
            : result.applied === 'style'
              ? `Tata ulang diterapkan: ${result.path ?? ''}`
              : 'Dilepas.',
      )
      refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setReleasing(false)
    }
  }
  return { releasing, note, release }
}

function SchemaPanel({ document, loading, error, root, refresh }: { document: DocumentState | null; loading: boolean; error: string | null; root: string; refresh: () => void }) {
  const [fields, setFields] = useState<FieldDef[]>([])
  const [target, setTarget] = useState<string>('per_doc')
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const { releasing, note, release } = useRelease(root, refresh)

  useEffect(() => {
    setFields(document?.schema?.fields ?? [])
    setTarget(document?.schema?.extractionTarget ?? 'per_doc')
  }, [document?.schema])

  const staged = Boolean(document?.schema && !document.schema.approved)

  const save = async (saveTemplate: boolean): Promise<void> => {
    if (!root || saving) return
    setSaving(true)
    setSaveNote(null)
    try {
      await api.dokumenSchema(root, { fields, extractionTarget: target }, saveTemplate)
      setSaveNote(saveTemplate ? 'Skema disimpan + jadi templat untuk jenis dokumen ini.' : 'Skema disimpan.')
      refresh()
    } catch (err) {
      setSaveNote(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const patchField = (index: number, patch: Partial<FieldDef>): void => {
    setFields((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  return (
    <Panel title="Panel Skema" data-testid="dokumen-schema-panel">
      {!document?.schema ? (
        <p className="px-1 py-1 text-[11px] text-muted" data-testid="dokumen-schema-empty">
          {loading ? 'Memuat…' : 'Belum ada skema. Lampirkan sumber (PDF/DOCX/EML) lalu kirim tujuan ekstraksi — usulan skema muncul di sini untuk disetujui sebelum data dibaca.'}
          {error ? <span className="block opacity-80">{error}</span> : null}
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-1 py-1">
          {staged ? (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px]" data-testid="dokumen-schema-staged">
              Usulan skema menunggu persetujuan — periksa, sunting, lalu tekan <strong>Ekstrak</strong>.
            </p>
          ) : (
            <p className="text-[11px] text-muted">Skema disetujui. Suntingan tersimpan dipakai ekstraksi berikutnya.</p>
          )}
          <div className="flex flex-col gap-1" data-testid="dokumen-schema-fields">
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  aria-label={`nama field ${index + 1}`}
                  className="h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 font-mono text-[11px]"
                  value={field.name}
                  onChange={(e) => patchField(index, { name: e.target.value })}
                />
                <select
                  aria-label={`tipe field ${field.name}`}
                  className="h-6 rounded border border-line bg-surface px-1 text-[11px]"
                  value={field.type}
                  onChange={(e) => patchField(index, { type: e.target.value as FieldDef['type'] })}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <label className="flex items-center gap-0.5 text-[10px] text-muted" title="wajib">
                  <input type="checkbox" checked={Boolean(field.required)} onChange={(e) => patchField(index, { required: e.target.checked })} />
                  wajib
                </label>
                <button type="button" aria-label={`hapus field ${field.name}`} className="text-muted hover:text-foreground" onClick={() => setFields((c) => c.filter((_, i) => i !== index))}>
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setFields((c) => [...c, { name: `field_${c.length + 1}`, type: 'string' }])}>
              <Plus className="size-3.5" aria-hidden /> Field
            </Button>
            <select aria-label="target ekstraksi" className="h-6 rounded border border-line bg-surface px-1 text-[11px]" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="per_doc">per dokumen</option>
              <option value="per_page">per halaman</option>
              <option value="per_row">per baris</option>
            </select>
            <Button size="sm" variant="ghost" onClick={() => void save(false)} disabled={saving} data-testid="dokumen-schema-save">
              <Save className="size-3.5" aria-hidden /> Simpan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void save(true)} disabled={saving} title="Simpan sebagai templat untuk jenis dokumen ini">
              Templat
            </Button>
          </div>
          {staged ? (
            <Button size="sm" onClick={() => void release()} disabled={releasing} data-testid="dokumen-extract-release" className="w-full">
              <Play className="size-3.5" aria-hidden /> {releasing ? 'Melepas…' : 'Ekstrak'}
            </Button>
          ) : null}
          {saveNote ? <p className="text-[10px] text-muted">{saveNote}</p> : null}
          {note ? <p className="text-[10px] text-muted">{note}</p> : null}
        </div>
      )}
    </Panel>
  )
}

function OutlinePanel({ document, loading, error, root, refresh }: { document: DocumentState | null; loading: boolean; error: string | null; root: string; refresh: () => void }) {
  const { releasing, note, release } = useRelease(root, refresh)
  const [drafts, setDrafts] = useState<Array<{ id: string; title: string; points: string }>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDrafts((document?.sections ?? []).map((s) => ({ id: s.id, title: s.title, points: s.thesisPoints.join('\n') })))
  }, [document?.sections])

  const staged = Boolean(document && document.sections.length > 0 && document.sections.every((s) => s.status === 'staged'))

  const save = async (): Promise<void> => {
    if (!root || saving) return
    setSaving(true)
    try {
      await api.dokumenOutline(root, drafts.map((d) => ({ id: d.id, title: d.title, thesisPoints: d.points.split('\n').map((x) => x.trim()).filter(Boolean) })))
      refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel title="Outline" data-testid="dokumen-outline-panel">
      {!document || document.sections.length === 0 ? (
        <p className="px-1 py-1 text-[11px] text-muted" data-testid="dokumen-outline-empty">
          {loading ? 'Memuat…' : 'Belum ada kerangka. Tulis topik/tujuan dokumen di composer — kerangka diusulkan di sini untuk disetujui sebelum penulisan.'}
          {error ? <span className="block opacity-80">{error}</span> : null}
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-1 py-1">
          {staged ? (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px]" data-testid="dokumen-outline-staged">
              Kerangka menunggu persetujuan — sunting judul/poin, lalu tekan <strong>Susun</strong>.
            </p>
          ) : null}
          <ol className="flex flex-col gap-2" data-testid="dokumen-outline-list">
            {drafts.map((section, index) => {
              const status = document.sections.find((s) => s.id === section.id)?.status
              return (
                <li key={section.id} className="rounded border border-line bg-surface p-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold text-muted">{index + 1}.</span>
                    <input
                      aria-label={`judul bab ${index + 1}`}
                      className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-base px-1.5 text-[11px] font-medium"
                      value={section.title}
                      onChange={(e) => setDrafts((c) => c.map((d) => (d.id === section.id ? { ...d, title: e.target.value } : d)))}
                    />
                    {status ? (
                      <span className={cn('rounded border px-1 py-0.5 text-[9px] font-semibold uppercase', status === 'drafted' ? 'border-emerald-500/40 text-emerald-500' : status === 'critic-flagged' ? 'border-rose-500/40 text-rose-500' : 'border-line text-muted')}>
                        {status === 'drafted' ? 'tertulis' : status === 'critic-flagged' ? 'ditandai kritikus' : 'kerangka'}
                      </span>
                    ) : null}
                  </div>
                  <textarea
                    aria-label={`poin bab ${index + 1}`}
                    className="mt-1 w-full rounded border border-line bg-surface-base px-1.5 py-1 text-[11px]"
                    rows={2}
                    value={section.points}
                    onChange={(e) => setDrafts((c) => c.map((d) => (d.id === section.id ? { ...d, points: e.target.value } : d)))}
                    placeholder="Satu poin per baris"
                  />
                </li>
              )
            })}
          </ol>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void save()} disabled={saving}>
              <Save className="size-3.5" aria-hidden /> Simpan
            </Button>
            {staged ? (
              <Button size="sm" onClick={() => void release()} disabled={releasing} data-testid="dokumen-compose-release" className="flex-1">
                <Play className="size-3.5" aria-hidden /> {releasing ? 'Melepas…' : 'Susun'}
              </Button>
            ) : null}
          </div>
          {note ? <p className="text-[10px] text-muted">{note}</p> : null}
        </div>
      )}
    </Panel>
  )
}

function SourcesPanel({ document, root, refresh }: { document: DocumentState | null; root: string; refresh: () => void }) {
  const setDokumenOptions = useDaedalusStore((state) => state.setDokumenOptions)
  const dokumenOptions = useDaedalusStore((state) => state.dokumenOptions)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const attach = async (): Promise<void> => {
    const rel = path.trim()
    if (!rel || !root || busy) return
    setBusy(true)
    setNote(null)
    try {
      await api.dokumenSources(root, [rel])
      setPath('')
      setNote('Sumber terlampir + ter-parse.')
      refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Panel Sumber" data-testid="dokumen-sources-panel">
      <div className="flex flex-col gap-1.5 px-1 py-1">
        {document && document.sources.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="dokumen-sources-list">
            {document.sources.map((source) => (
              <li key={source.id} className="flex items-center gap-1.5 rounded border border-line bg-surface px-1.5 py-1 text-[11px]">
                <FilePlus2 className="size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium" title={source.filename}>{source.filename}</span>
                <span className="text-[10px] text-muted">{source.pages > 0 ? `${source.pages} hlm` : '—'}</span>
                <span
                  className={cn(
                    'rounded border px-1 py-0.5 text-[9px] font-semibold uppercase',
                    source.status === 'parsed' ? 'border-emerald-500/40 text-emerald-500' : source.status === 'failed' ? 'border-rose-500/40 text-rose-500' : 'border-line text-muted',
                  )}
                >
                  {source.status === 'parsed' ? 'terbaca' : source.status === 'failed' ? 'gagal' : source.status}
                </span>
                {source.docType ? <span className="text-[10px] text-muted">{source.docType}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted">Belum ada sumber. Lampirkan berkas dari panel Workspace di bawah, atau ketik jalurnya:</p>
        )}
        <div className="flex gap-1">
          <input
            aria-label="jalur berkas sumber"
            className="h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 font-mono text-[11px]"
            placeholder="berkas/invoice.pdf"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void attach()
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => void attach()} disabled={busy || !path.trim()}>
            Lampirkan
          </Button>
        </div>
        {dokumenOptions.sources.length > 0 ? (
          <p className="text-[10px] text-muted">Terpilih untuk tugas berikut: {dokumenOptions.sources.map((s) => s.split('/').pop()).join(', ')}</p>
        ) : null}
        {note ? <p className="text-[10px] text-muted">{note}</p> : null}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setDokumenOptions({ sources: [] })}
          disabled={dokumenOptions.sources.length === 0}
        >
          Kosongkan pilihan
        </Button>
      </div>
    </Panel>
  )
}
