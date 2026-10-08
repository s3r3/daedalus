import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

/**
 * An image a tool produced and the model looked at (view_image,
 * screenshot), rendered inline where the tool result lives. The event
 * log carries only the path (the loop strips base64 before emit), so
 * the bytes come from the workspace file endpoint — which serves
 * images as data URLs and reaches `.daedalus/screenshots/` fine even
 * though tree listings prune that folder.
 */
export function ToolResultImage({ path, thumb = false }: { path: string; thumb?: boolean }) {
  const root = useDaedalusStore((state) => state.workspace.root)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!root) return
    let cancelled = false
    setSrc(null)
    setFailed(false)
    api
      .file(root, path)
      .then((file) => {
        if (cancelled) return
        if (file.kind === 'image' && file.src) setSrc(file.src)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [root, path])

  if (failed) {
    return <p className="mt-1 text-[10px] text-muted">image at {path} could not be loaded</p>
  }
  if (!src) {
    return <p className="mt-1 text-[10px] text-muted">loading image…</p>
  }
  if (thumb) {
    return <img data-testid="tool-result-image" src={src} alt={path} className="size-10 shrink-0 rounded border border-line object-cover" />
  }
  return (
    <figure className="mt-1.5">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="block" aria-label={expanded ? `collapse image ${path}` : `expand image ${path}`}>
        <img
          data-testid="tool-result-image"
          src={src}
          alt={path}
          className={expanded ? 'max-w-full rounded border border-line' : 'max-h-60 w-auto max-w-full rounded border border-line object-contain'}
        />
      </button>
      <figcaption className="mt-0.5 truncate text-[10px] text-muted">{path} — click to {expanded ? 'shrink' : 'expand'}</figcaption>
    </figure>
  )
}
