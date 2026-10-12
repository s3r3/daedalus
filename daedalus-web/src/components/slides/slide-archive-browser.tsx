import { useEffect, useState } from 'react'
import { ArchiveRestore, X } from 'lucide-react'
import { api, type DeckArchiveInfo } from '../../api/client'
import { Button } from '../ui/button'
import { useDaedalusStore } from '../../state/taskStore'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Deck archive browser (Slide domain): the new-chat reset archives the
 * deck aside under `.daedalus/deck-archive/` — this dialog makes that
 * archive visible again. Each entry shows its title, slide count, and
 * archive date. Restoring is ask-first (two-step) because it swaps the
 * current deck aside; the server never deletes anything — the current
 * deck is archived aside first and the entry is COPIED back, so the
 * archive stays restorable. After a restore the workspace revision bumps
 * so the canvas re-reads the deck.
 */
export function SlideArchiveBrowser({ onClose }: { onClose: () => void }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [archives, setArchives] = useState<DeckArchiveInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!root) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .deckArchives(root)
      .then(({ archives: list }) => {
        if (!cancelled) {
          setArchives(list)
          setLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(messageOf(loadError))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [root])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const restore = async (name: string): Promise<void> => {
    if (!root) return
    setBusy(name)
    setNote(null)
    try {
      const result = await api.deckArchiveRestore(root, name)
      setNote(`"${result.deck.title}" dipulihkan (${result.deck.slides.length} slide). Deck sebelumnya diarsipkan, tidak dihapus.`)
      setArmed(null)
      bumpWorkspaceRevision()
      const { archives: list } = await api.deckArchives(root)
      setArchives(list)
    } catch (restoreError: unknown) {
      setNote(messageOf(restoreError))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-surface-base/70 p-3 sm:items-center sm:p-6"
      data-testid="slide-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="arsip deck"
    >
      <div className="absolute inset-0" aria-hidden="true" onClick={onClose} data-testid="slide-archive-backdrop" />
      <div className="relative max-h-[90vh] w-[min(560px,94vw)] overflow-y-auto rounded-md border border-line bg-surface-base">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <strong className="text-[11px] uppercase tracking-wide text-muted">Arsip deck</strong>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="tutup arsip deck" className="ml-auto">
            <X />
          </Button>
        </header>
        <div className="flex flex-col gap-1.5 p-3">
          {loading ? <p className="px-1 py-1 text-[11px] text-muted">Memuat arsip…</p> : null}
          {error ? <p role="alert" className="px-1 py-1 text-[11px] text-error">{error}</p> : null}
          {!loading && !error && archives.length === 0 ? (
            <p className="px-1 py-4 text-center text-[11px] text-muted">
              Belum ada arsip. Chat baru di Slide mengarsipkan deck ke sini (tidak pernah dihapus).
            </p>
          ) : null}
          {archives.map((archive) => (
            <div
              key={archive.name}
              data-testid={`slide-archive-${archive.name}`}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-foreground">{archive.title}</span>
                <span className="block text-[10px] text-muted">
                  {archive.slides} slide · diarsipkan {formatDate(archive.archivedAt)}
                </span>
              </span>
              {armed === archive.name ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-[10px] text-warning">pulihkan &amp; arsipkan deck ini?</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void restore(archive.name)}
                    data-testid={`slide-archive-restore-confirm-${archive.name}`}
                  >
                    Pulihkan
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setArmed(null)} aria-label="batalkan restore">
                    Batal
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setArmed(archive.name)}
                  data-testid={`slide-archive-restore-${archive.name}`}
                  aria-label={`pulihkan arsip ${archive.title}`}
                  className="shrink-0"
                >
                  <ArchiveRestore /> Pulihkan
                </Button>
              )}
            </div>
          ))}
          {note ? <p data-testid="slide-archive-note" className="px-1 text-[11px] text-muted">{note}</p> : null}
        </div>
      </div>
    </div>
  )
}
