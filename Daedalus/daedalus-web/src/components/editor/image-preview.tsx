import { useState } from 'react'
import { Badge } from '../ui/badge'

/**
 * Read-only preview for image files (png/jpg/gif/webp/svg/avif/ico). Binary
 * content is shown as a picture — it is never decoded into the text editor,
 * where it rendered as gibberish and could be mangled by Save.
 */
export function ImagePreview({
  path,
  src,
  size,
  mediaType,
}: {
  path: string
  src: string
  size: number
  mediaType?: string | null
}) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const name = path.split('/').pop() ?? path

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-preview">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="truncate text-[11px] text-foreground">{path}</span>
        <Badge tone="success">image</Badge>
        {mediaType ? <Badge tone="neutral">{mediaType}</Badge> : null}
        <span className="ml-auto text-[10px] text-muted">
          {size} bytes
          {dimensions ? (
            <>
              {' · '}
              <span data-testid="image-preview-dimensions">
                {dimensions.width} × {dimensions.height}
              </span>
            </>
          ) : null}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface p-4">
        {failed ? (
          <p role="alert" className="text-[11px] text-error">
            could not render {name} as an image
          </p>
        ) : (
          <img
            data-testid="image-preview-img"
            src={src}
            alt={name}
            className="max-h-full max-w-full object-contain"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setDimensions({ width: naturalWidth, height: naturalHeight })
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  )
}
