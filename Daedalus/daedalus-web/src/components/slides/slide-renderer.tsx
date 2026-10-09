import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as lucideIcons from 'lucide-react'
import { Image as ImageIcon, Quote as QuoteIcon, Sparkles } from 'lucide-react'
import type { BlockPosition, DeckSpec, Slide } from '@daedalus/core'
import { getLayout } from '@daedalus/core/slides/layouts'
import { getPalette } from '@daedalus/core/palette'

/**
 * Renders one slide of a DeckSpec as a 16:9 canvas. The renderer fills its
 * parent; parents opt into container queries (`[container-type:inline-size]`)
 * so `cqw` font sizes scale the same slide from stage to filmstrip
 * thumbnail without a second code path. Colors come from the shared core
 * palette (`--daedalus-*` vars, or the light palette when the deck asks for
 * a light canvas) — never from literals in this file.
 */

type Ctx = {
  accent: string
  muted: string
  panelBg: string
  line: string
  /** Extracted accent ramp of an imported PPT template (accent1..accent6). */
  series?: string[]
}

const SERIES_VARS = [
  'var(--daedalus-success)',
  'var(--daedalus-info)',
  'var(--daedalus-secondary)',
  'var(--daedalus-warning)',
  'var(--daedalus-primary)',
]

function seriesColor(index: number, accent: string, series?: string[]): string {
  // An imported template's own accent ramp wins so canvas charts carry the
  // same palette the PPTX exporter writes; built-in decks keep the app
  // palette rotation exactly as before.
  if (series && series.length > 1) return series[index % series.length]
  return index === 0 ? accent : SERIES_VARS[(index - 1) % SERIES_VARS.length]
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(str(value)) || 0
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => str(entry)).filter((entry) => entry.length > 0) : []
}

function objList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : []
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('')
}

function SlideTitle({ children }: { children: ReactNode }) {
  return (
    <div className="font-bold tracking-tight" style={{ fontSize: '3.3cqw', lineHeight: 1.15 }}>
      {children}
    </div>
  )
}

function AccentBar({ accent, width = '7cqw' }: { accent: string; width?: string }) {
  return <div aria-hidden style={{ width, height: '0.7cqw', borderRadius: 999, backgroundColor: accent }} />
}

function Points({ items, ctx, size = '1.5cqw' }: { items: string[]; ctx: Ctx; size?: string }) {
  return (
    <ul className="flex flex-col" style={{ gap: '0.85cqw' }}>
      {items.map((point, index) => (
        <li key={index} className="flex items-start" style={{ gap: '0.75cqw' }}>
          <span aria-hidden style={{ color: ctx.accent, fontSize: size, lineHeight: 1.35 }}>
            ▸
          </span>
          <span style={{ fontSize: size, lineHeight: 1.4 }}>{point}</span>
        </li>
      ))}
    </ul>
  )
}

function CheckList({ items, ctx, size = '1.35cqw', marker = '✓', markerColor }: {
  items: string[]
  ctx: Ctx
  size?: string
  marker?: string
  markerColor?: string
}) {
  return (
    <ul className="flex flex-col" style={{ gap: '0.7cqw' }}>
      {items.map((point, index) => (
        <li key={index} className="flex items-start" style={{ gap: '0.7cqw' }}>
          <span aria-hidden className="font-bold" style={{ color: markerColor ?? ctx.accent, fontSize: size, lineHeight: 1.35 }}>
            {marker}
          </span>
          <span style={{ fontSize: size, lineHeight: 1.4 }}>{point}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * One image area of a slide (`blockKey` = the draggable block it fills).
 * Remote/data URLs render directly; a local deck-asset name renders the
 * real bytes when the stage's resolver maps it to a URL; anything else
 * is an honest labelled placeholder. In Edit mode the slot is a button:
 * a click (not a drag — movement past a few px belongs to the block
 * drag session) asks the stage to open the image picker for this block.
 */
function ImageSlot({ blockKey, image, alt, caption, ctx, style }: {
  blockKey: string
  image: string
  alt: string
  caption?: string
  ctx: Ctx
  style?: CSSProperties
}) {
  const blocks = useContext(BlockCtx)
  const isRemote = /^(https?:|data:)/i.test(image)
  const resolved = !isRemote && blocks.imageSrc ? blocks.imageSrc(image) : undefined
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [image, resolved])
  const showImg = isRemote || (resolved !== undefined && !failed)
  const clickable = blocks.editable && blocks.onImagePick !== undefined && !isRemote
  const downAt = useRef<{ x: number; y: number } | null>(null)

  const content = showImg ? (
    <img
      src={isRemote ? image : resolved}
      alt={alt}
      className="absolute inset-0 h-full w-full object-cover"
      onError={isRemote ? undefined : () => setFailed(true)}
    />
  ) : (
    <>
      <ImageIcon aria-hidden style={{ width: '3.4cqw', height: '3.4cqw', color: ctx.accent }} />
      <div className="break-all font-semibold" style={{ fontSize: '1.1cqw' }}>
        {image || 'image'}
      </div>
      {alt ? <div style={{ fontSize: '1cqw', color: ctx.muted }}>{alt}</div> : null}
      {caption ? (
        <div className="font-medium" style={{ fontSize: '1.05cqw', color: ctx.accent }}>
          {caption}
        </div>
      ) : null}
      {clickable ? (
        <div className="font-semibold" style={{ fontSize: '1cqw', color: ctx.accent }}>
          Klik untuk upload gambar
        </div>
      ) : null}
    </>
  )

  const boxStyle: CSSProperties = { borderColor: ctx.line, backgroundColor: ctx.panelBg, gap: '0.7cqw', padding: '1cqw', ...style }
  const boxClass = 'relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-md border text-center'
  if (!clickable) {
    return (
      <div className={boxClass} style={boxStyle}>
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid={`slide-image-upload-${blockKey}`}
      aria-label={`Upload gambar${image ? `: ${image}` : ''}`}
      className={`${boxClass} cursor-pointer`}
      style={boxStyle}
      onPointerDown={(event) => {
        downAt.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => {
        const down = downAt.current
        downAt.current = null
        if (down && Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y) > 4) return
        blocks.onImagePick?.(blockKey)
      }}
    >
      {content}
    </button>
  )
}

function ColumnPanel({ heading, points, ctx }: { heading: string; points: string[]; ctx: Ctx }) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-col rounded-md border"
      style={{ gap: '1cqw', padding: '1.6cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
    >
      <div className="font-semibold" style={{ fontSize: '1.8cqw', color: ctx.accent }}>
        {heading}
      </div>
      <Points items={points} ctx={ctx} size="1.35cqw" />
    </div>
  )
}

/* ------------------------------------------------------------ blocks */

/**
 * One named, placeable piece of a slide (`layoutBlockKeys` in core names
 * them). In layout flow a Block is invisible (`display: contents`, the
 * layout arranges its children as today). Once the slide carries a
 * position for the key — stored by dragging, or already in deck.json —
 * the block renders absolutely at those slide fractions in an overlay
 * layer shared by the stage and the filmstrip. In edit mode blocks are
 * grabbable: pointer-down measures the block, moves update a live
 * override, and pointer-up persists through `onPositionsChange` — the
 * layout stays in charge until the user actually drags something.
 */
type BlockCtxValue = {
  positions: Record<string, BlockPosition>
  editable: boolean
  overlayEl: HTMLElement | null
  onDragStart: (key: string, event: ReactPointerEvent) => void
  /** Resolves a local deck-asset name to a displayable URL (stage-provided). */
  imageSrc?: (name: string) => string | undefined
  /** Edit mode: a placeholder (or placed image) was clicked, not dragged. */
  onImagePick?: (blockKey: string) => void
}

const BlockCtx = createContext<BlockCtxValue>({ positions: {}, editable: false, overlayEl: null, onDragStart: () => {} })

function Block({ blockKey, children }: { blockKey: string; children: ReactNode }) {
  const ctx = useContext(BlockCtx)
  const pos = ctx.positions[blockKey]
  if (pos) {
    const inner = (
      <div
        data-block-key={blockKey}
        data-testid={`slide-block-${blockKey}`}
        className={ctx.editable ? 'pointer-events-auto absolute cursor-grab touch-none select-none' : 'pointer-events-auto absolute'}
        style={{
          left: `${pos.x * 100}%`,
          top: `${pos.y * 100}%`,
          ...(pos.w !== undefined ? { width: `${pos.w * 100}%` } : {}),
          ...(pos.h !== undefined ? { height: `${pos.h * 100}%` } : {}),
          ...(ctx.editable ? { outline: '1px dashed var(--daedalus-accent)', outlineOffset: 2 } : {}),
        }}
        onPointerDown={ctx.editable ? (event) => ctx.onDragStart(blockKey, event) : undefined}
      >
        <div className="h-full w-full [&>*]:h-full [&>*]:w-full">{children}</div>
      </div>
    )
    return ctx.overlayEl ? createPortal(inner, ctx.overlayEl) : null
  }
  return (
    <div
      data-block-key={blockKey}
      className="contents"
      style={ctx.editable ? { cursor: 'grab' } : undefined}
      onPointerDown={ctx.editable ? (event) => ctx.onDragStart(blockKey, event) : undefined}
    >
      {children}
    </div>
  )
}

type LucideComponent = typeof Sparkles

function iconFor(name: string): LucideComponent {
  const record = lucideIcons as unknown as Record<string, unknown>
  const pascal = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  for (const candidate of [name, pascal, name.charAt(0).toUpperCase() + name.slice(1)]) {
    const value = record[candidate]
    if (value && (typeof value === 'function' || typeof value === 'object') && '$$typeof' in (value as Record<string, unknown>)) {
      return value as LucideComponent
    }
  }
  return Sparkles
}

function renderBody(slide: Slide, ctx: Ctx): ReactNode {
  const c = slide.content

  switch (slide.layout) {
    case 'title': {
      return (
        <div className="flex flex-1 flex-col justify-center" style={{ gap: '1.6cqw' }}>
          <AccentBar accent={ctx.accent} width="9cqw" />
          <Block blockKey="title">
            <div className="font-bold tracking-tight" style={{ fontSize: '6.6cqw', lineHeight: 1.05 }}>
              {str(c.title) || 'Untitled presentation'}
            </div>
          </Block>
          {str(c.subtitle) ? (
            <Block blockKey="subtitle">
              <div style={{ fontSize: '2.3cqw', color: ctx.muted, lineHeight: 1.35 }}>{str(c.subtitle)}</div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'section': {
      return (
        <div className="relative flex flex-1 flex-col justify-center" style={{ gap: '1.4cqw' }}>
          <Block blockKey="number">
            <div
              aria-hidden
              className="absolute font-bold"
              style={{ right: 0, top: '-2cqw', fontSize: '15cqw', lineHeight: 1, color: ctx.accent, opacity: 0.14 }}
            >
              {str(c.number)}
            </div>
          </Block>
          <div style={{ fontSize: '1.6cqw', letterSpacing: '0.25em', textTransform: 'uppercase', color: ctx.accent }}>
            {str(c.number) ? `Bagian ${str(c.number)}` : 'Bagian'}
          </div>
          <Block blockKey="title">
            <div className="font-bold tracking-tight" style={{ fontSize: '5cqw', lineHeight: 1.1 }}>
              {str(c.title)}
            </div>
          </Block>
          <AccentBar accent={ctx.accent} />
        </div>
      )
    }
    case 'closing': {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.8cqw' }}>
          <AccentBar accent={ctx.accent} width="9cqw" />
          <Block blockKey="title">
            <div className="font-bold tracking-tight" style={{ fontSize: '5.6cqw', lineHeight: 1.1 }}>
              {str(c.title)}
            </div>
          </Block>
          {str(c.cta) ? (
            <Block blockKey="cta">
              <span
                className="rounded-full border font-semibold"
                style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.7cqw', padding: '0.7cqw 2cqw' }}
              >
                {str(c.cta)}
              </span>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'quote': {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.6cqw', padding: '0 4cqw' }}>
          <Block blockKey="text">
            <div className="flex flex-col items-center" style={{ gap: '1.6cqw' }}>
              <QuoteIcon aria-hidden style={{ width: '4cqw', height: '4cqw', color: ctx.accent }} />
              <div style={{ fontSize: '3.4cqw', lineHeight: 1.3, fontStyle: 'italic' }}>{str(c.text)}</div>
            </div>
          </Block>
          {str(c.author) ? (
            <Block blockKey="author">
              <div style={{ fontSize: '1.6cqw', color: ctx.muted }}>— {str(c.author)}</div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'bullets': {
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.8cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <AccentBar accent={ctx.accent} width="5cqw" />
          <Block blockKey="points">
            <Points items={strList(c.points)} ctx={ctx} />
          </Block>
        </div>
      )
    }
    case 'two-column': {
      const left = obj(c.left)
      const right = obj(c.right)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.6cqw' }}>
            <Block blockKey="left">
              <ColumnPanel heading={str(left.heading)} points={strList(left.points)} ctx={ctx} />
            </Block>
            <Block blockKey="right">
              <ColumnPanel heading={str(right.heading)} points={strList(right.points)} ctx={ctx} />
            </Block>
          </div>
        </div>
      )
    }
    case 'comparison': {
      const left = obj(c.left)
      const right = obj(c.right)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.6cqw' }}>
            <Block blockKey="left">
              <ColumnPanel heading={str(left.title)} points={strList(left.points)} ctx={ctx} />
            </Block>
            <Block blockKey="right">
              <ColumnPanel heading={str(right.title)} points={strList(right.points)} ctx={ctx} />
            </Block>
          </div>
          {str(c.verdict) ? (
            <Block blockKey="verdict">
              <div
                className="rounded-md border text-center font-semibold"
                style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.5cqw', padding: '0.9cqw' }}
              >
                {str(c.verdict)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'image-side': {
      const imageBox = <ImageSlot blockKey="image" image={str(c.image)} alt={str(c.alt)} ctx={ctx} style={{ width: '36%', flexShrink: 0 }} />
      const textCol = (
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <Block blockKey="points">
            <Points items={strList(c.points)} ctx={ctx} size="1.4cqw" />
          </Block>
        </div>
      )
      return (
        <div className="flex min-h-0 flex-1" style={{ gap: '2cqw' }}>
          {c.side === 'left' ? (
            <>
              <Block blockKey="image">{imageBox}</Block>
              {textCol}
            </>
          ) : (
            <>
              {textCol}
              <Block blockKey="image">{imageBox}</Block>
            </>
          )}
        </div>
      )
    }
    case 'diagram-flow': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.8cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex flex-1 items-stretch" style={{ gap: '0.6cqw' }}>
            {steps.map((step, index) => (
              <Block key={index} blockKey={`step-${index}`}>
                <div className="flex min-w-0 flex-1 items-stretch" style={{ gap: '0.6cqw' }}>
                  <div
                    className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden rounded-md border"
                    style={{ gap: '0.6cqw', padding: '1.2cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                  >
                    <div className="font-semibold" style={{ fontSize: '1.55cqw', color: ctx.accent }}>
                      {index + 1}. {str(step.title)}
                    </div>
                    {str(step.desc) ? <div className="line-clamp-4" style={{ fontSize: '1.15cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(step.desc)}</div> : null}
                  </div>
                  {index < steps.length - 1 ? (
                    <span aria-hidden className="flex items-center font-bold" style={{ fontSize: '2.4cqw', color: ctx.accent }}>
                      ›
                    </span>
                  ) : null}
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'diagram-cycle': {
      const nodes = strList(c.nodes).slice(0, 4)
      const positions: CSSProperties[] = [
        { left: '50%', top: 0, transform: 'translateX(-50%)' },
        { right: 0, top: '50%', transform: 'translateY(-50%)' },
        { left: '50%', bottom: 0, transform: 'translateX(-50%)' },
        { left: 0, top: '50%', transform: 'translateY(-50%)' },
      ]
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="relative flex-1" style={{ margin: '0 6cqw' }}>
            <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 400 220">
              <circle cx="200" cy="110" r="82" fill="none" strokeDasharray="7 9" strokeWidth="2.5" style={{ stroke: ctx.accent }} />
              <polygon points="200,18 192,34 208,34" style={{ fill: ctx.accent }} />
              <polygon points="292,110 276,102 276,118" style={{ fill: ctx.accent }} />
              <polygon points="200,202 208,186 192,186" style={{ fill: ctx.accent }} />
              <polygon points="108,110 124,118 124,102" style={{ fill: ctx.accent }} />
            </svg>
            {nodes.map((node, index) => (
              <span key={index} className="absolute" style={{ ...positions[index], maxWidth: '34%' }}>
                <Block blockKey={`node-${index}`}>
                  <span
                    className="block rounded-full border text-center font-semibold"
                    style={{
                      borderColor: ctx.accent,
                      backgroundColor: ctx.panelBg,
                      fontSize: '1.35cqw',
                      padding: '0.8cqw 1.4cqw',
                    }}
                  >
                    {node}
                  </span>
                </Block>
              </span>
            ))}
          </div>
        </div>
      )
    }
    case 'diagram-hierarchy': {
      const groups = objList(c.groups)
      return (
        <div className="flex flex-1 flex-col items-center" style={{ gap: 0 }}>
          <div className="self-start">
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          </div>
          <Block blockKey="root">
            <div
              className="rounded-md border text-center font-bold"
              style={{ borderColor: ctx.accent, backgroundColor: ctx.panelBg, fontSize: '1.7cqw', padding: '0.9cqw 2.2cqw', marginTop: '1.4cqw' }}
            >
              {str(c.root)}
            </div>
          </Block>
          <div style={{ width: 2, height: '1.6cqw', backgroundColor: ctx.line }} />
          <div className="relative flex w-full" style={{ gap: '1.4cqw' }}>
            {groups.length > 1 ? (
              <div
                aria-hidden
                className="absolute"
                style={{
                  top: 0,
                  height: 2,
                  // Span exactly the first..last group centers: with even
                  // flex columns, group i centers at (i + 0.5) / n of the
                  // row (the old (n-1)*24% bar drifted off-center for
                  // every group count except 4).
                  left: `${50 / groups.length}%`,
                  width: `${(100 * (groups.length - 1)) / groups.length}%`,
                  backgroundColor: ctx.line,
                }}
              />
            ) : null}
            {groups.map((group, index) => (
              <Block key={index} blockKey={`group-${index}`}>
                <div className="flex min-w-0 flex-1 flex-col items-center">
                  <div style={{ width: 2, height: '1.2cqw', backgroundColor: ctx.line }} />
                  <div
                    className="flex w-full flex-col overflow-hidden rounded-md border"
                    style={{ gap: '0.7cqw', padding: '1.1cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                  >
                    <div className="font-semibold" style={{ fontSize: '1.45cqw', color: ctx.accent }}>
                      {str(group.label)}
                    </div>
                    <Points items={strList(group.items)} ctx={ctx} size="1.15cqw" />
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'timeline': {
      const events = objList(c.events)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '2cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="relative flex flex-1 items-start" style={{ paddingTop: '0.4cqw' }}>
            <div aria-hidden className="absolute" style={{ left: 0, right: 0, top: '1.05cqw', height: 2, backgroundColor: ctx.accent, opacity: 0.45 }} />
            {events.map((event, index) => (
              <Block key={index} blockKey={`event-${index}`}>
                <div className="relative flex min-w-0 flex-1 flex-col" style={{ gap: '0.55cqw', paddingRight: '1cqw' }}>
                  <span className="rounded-full" style={{ width: '1.5cqw', height: '1.5cqw', backgroundColor: ctx.accent }} />
                  <div className="font-bold" style={{ fontSize: '1.35cqw', color: ctx.accent }}>
                    {str(event.when)}
                  </div>
                  <div className="font-semibold" style={{ fontSize: '1.45cqw', lineHeight: 1.3 }}>
                    {str(event.title)}
                  </div>
                  {str(event.desc) ? <div className="line-clamp-4" style={{ fontSize: '1.12cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(event.desc)}</div> : null}
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'chart-bar': {
      const data = objList(c.data).map((d) => ({ label: str(d.label), value: num(d.value) }))
      const max = Math.max(1, ...data.map((d) => d.value))
      const W = 640
      const H = 330
      const padL = 44
      const padB = 36
      const padT = 30
      const plotW = W - padL - 12
      const plotH = H - padB - padT
      const slot = data.length > 0 ? plotW / data.length : plotW
      return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ gap: '1.2cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <Block blockKey="chart">
          <svg viewBox={`0 0 ${W} ${H}`} className="min-h-0 w-full flex-1" role="img" aria-label={str(c.title)}>
            <line x1={padL} y1={padT + plotH} x2={W - 12} y2={padT + plotH} strokeWidth="1.5" style={{ stroke: ctx.line }} />
            {data.map((d, index) => {
              const barH = (d.value / max) * plotH
              const barW = slot * 0.56
              const x = padL + slot * index + (slot - barW) / 2
              const y = padT + plotH - barH
              return (
                <g key={index}>
                  <rect x={x} y={y} width={barW} height={barH} rx="5" style={{ fill: seriesColor(index, ctx.accent, ctx.series) }} />
                  <text x={x + barW / 2} y={y - 8} textAnchor="middle" fontSize="14" fontWeight="700" style={{ fill: 'currentColor' }}>
                    {d.value}
                    {str(c.unit)}
                  </text>
                  <text x={x + barW / 2} y={padT + plotH + 24} textAnchor="middle" fontSize="13" style={{ fill: ctx.muted }}>
                    {d.label}
                  </text>
                </g>
              )
            })}
          </svg>
          </Block>
        </div>
      )
    }
    case 'chart-line': {
      const series = objList(c.series).map((s) => ({
        name: str(s.name),
        points: Array.isArray(s.points) ? s.points.map((p) => num(p)) : [],
      }))
      const all = series.flatMap((s) => s.points)
      const min = all.length ? Math.min(...all) : 0
      const max = all.length ? Math.max(...all) : 1
      const span = max - min || 1
      const W = 640
      const H = 300
      const pad = 38
      const plotW = W - pad * 2
      const plotH = H - pad * 2
      const xAt = (i: number, n: number): number => pad + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
      const yAt = (v: number): number => pad + plotH - ((v - min) / span) * plotH
      return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ gap: '1cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <Block blockKey="chart">
          <svg viewBox={`0 0 ${W} ${H}`} className="min-h-0 w-full flex-1" role="img" aria-label={str(c.title)}>
            <line x1={pad} y1={pad + plotH} x2={W - pad} y2={pad + plotH} strokeWidth="1.5" style={{ stroke: ctx.line }} />
            <line x1={pad} y1={pad} x2={pad} y2={pad + plotH} strokeWidth="1.5" style={{ stroke: ctx.line }} />
            {series.map((s, si) => (
              <g key={si}>
                <polyline
                  fill="none"
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={s.points.map((p, i) => `${xAt(i, s.points.length)},${yAt(p)}`).join(' ')}
                  style={{ stroke: seriesColor(si, ctx.accent, ctx.series) }}
                />
                {s.points.map((p, i) => (
                  <circle key={i} cx={xAt(i, s.points.length)} cy={yAt(p)} r="4.5" style={{ fill: seriesColor(si, ctx.accent, ctx.series) }} />
                ))}
              </g>
            ))}
          </svg>
          </Block>
          <Block blockKey="legend">
            <div className="flex flex-wrap" style={{ gap: '1.6cqw' }}>
              {series.map((s, si) => (
                <span key={si} className="inline-flex items-center" style={{ gap: '0.5cqw', fontSize: '1.2cqw' }}>
                  <span aria-hidden style={{ width: '1.4cqw', height: '0.45cqw', borderRadius: 999, backgroundColor: seriesColor(si, ctx.accent, ctx.series) }} />
                  {s.name}
                  {str(c.unit) ? <span style={{ color: ctx.muted }}>({str(c.unit)})</span> : null}
                </span>
              ))}
            </div>
          </Block>
        </div>
      )
    }
    case 'chart-donut': {
      const slices = objList(c.slices).map((s) => ({ label: str(s.label), value: num(s.value) }))
      const total = slices.reduce((sum, s) => sum + s.value, 0) || 1
      const R = 80
      const C = 2 * Math.PI * R
      let acc = 0
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.2cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex flex-1 items-center" style={{ gap: '3cqw' }}>
            <Block blockKey="chart">
            <svg viewBox="0 0 220 220" style={{ width: '26cqw', height: '26cqw' }} role="img" aria-label={str(c.title)}>
              <g transform="rotate(-90 110 110)">
                {slices.map((slice, index) => {
                  const fraction = slice.value / total
                  const dash = fraction * C
                  const element = (
                    <circle
                      key={index}
                      cx="110"
                      cy="110"
                      r={R}
                      fill="none"
                      strokeWidth="30"
                      strokeDasharray={`${Math.max(0, dash - 2)} ${C - dash + 2}`}
                      strokeDashoffset={-acc}
                      style={{ stroke: seriesColor(index, ctx.accent, ctx.series) }}
                    />
                  )
                  acc += dash
                  return element
                })}
              </g>
              <text x="110" y="118" textAnchor="middle" fontSize="21" fontWeight="700" style={{ fill: 'currentColor' }}>
                {total}
                {str(c.unit)}
              </text>
            </svg>
            </Block>
            <Block blockKey="legend">
              <ul className="flex flex-col" style={{ gap: '0.9cqw' }}>
                {slices.map((slice, index) => (
                  <li key={index} className="flex items-center" style={{ gap: '0.7cqw', fontSize: '1.35cqw' }}>
                    <span aria-hidden className="rounded-sm" style={{ width: '1.3cqw', height: '1.3cqw', backgroundColor: seriesColor(index, ctx.accent, ctx.series) }} />
                    <span>{slice.label}</span>
                    <strong>
                      {slice.value}
                      {str(c.unit)}
                    </strong>
                    <span style={{ color: ctx.muted }}>{Math.round((slice.value / total) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </Block>
          </div>
        </div>
      )
    }
    case 'table': {
      const columns = strList(c.columns)
      const rows = Array.isArray(c.rows) ? c.rows.map((row) => (Array.isArray(row) ? row.map((cell) => str(cell)) : [])) : []
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <Block blockKey="table">
          <div className="overflow-hidden rounded-md border" style={{ borderColor: ctx.line }}>
            <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: '1.3cqw' }}>
              <thead>
                <tr>
                  {columns.map((col, index) => (
                    <th key={index} className="text-left font-bold" style={{ backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', padding: '0.85cqw 1.1cqw' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding: '0.75cqw 1.1cqw', borderTop: `1px solid ${ctx.line}`, backgroundColor: ri % 2 ? ctx.panelBg : 'transparent' }}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </Block>
        </div>
      )
    }
    case 'stats': {
      const stats = objList(c.stats)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '2cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="grid flex-1 items-center" style={{ gridTemplateColumns: `repeat(${Math.max(1, stats.length)}, minmax(0, 1fr))`, gap: '1.6cqw' }}>
            {stats.map((stat, index) => (
              <Block key={index} blockKey={`stat-${index}`}>
                <div className="flex flex-col items-center text-center" style={{ gap: '0.6cqw' }}>
                  <div className="font-bold" style={{ fontSize: '5.2cqw', color: ctx.accent, lineHeight: 1 }}>
                    {str(stat.value)}
                  </div>
                  <div className="line-clamp-2 uppercase" style={{ fontSize: '1.25cqw', letterSpacing: '0.14em', color: ctx.muted }}>
                    {str(stat.label)}
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'icon-grid': {
      const items = objList(c.items)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.7cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="grid flex-1" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridAutoRows: '1fr', gap: '1.4cqw' }}>
            {items.map((item, index) => {
              const Icon = iconFor(str(item.icon))
              return (
                <Block key={index} blockKey={`item-${index}`}>
                  <div
                    className="flex flex-col overflow-hidden rounded-md border"
                    style={{ gap: '0.7cqw', padding: '1.4cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                  >
                    <Icon aria-hidden style={{ width: '3cqw', height: '3cqw', color: ctx.accent }} />
                    <div className="font-semibold" style={{ fontSize: '1.55cqw' }}>
                      {str(item.title)}
                    </div>
                    {str(item.desc) ? <div className="line-clamp-3" style={{ fontSize: '1.15cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(item.desc)}</div> : null}
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'numbered-steps': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex flex-1 flex-col justify-center">
            {steps.map((step, index) => (
              <Block key={index} blockKey={`step-${index}`}>
                <div
                  className="flex items-start"
                  style={{ gap: '1.5cqw', padding: '1.05cqw 0.2cqw', ...(index > 0 ? { borderTop: `1px solid ${ctx.line}` } : {}) }}
                >
                  <span className="font-bold" style={{ fontSize: '3.1cqw', lineHeight: 1, color: ctx.accent, minWidth: '5.6cqw' }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '0.35cqw', paddingTop: '0.25cqw' }}>
                    <div className="font-semibold" style={{ fontSize: '1.75cqw', lineHeight: 1.25 }}>
                      {str(step.title)}
                    </div>
                    {str(step.desc) ? (
                      <div className="line-clamp-2" style={{ fontSize: '1.25cqw', color: ctx.muted, lineHeight: 1.4 }}>
                        {str(step.desc)}
                      </div>
                    ) : null}
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'code-focus': {
      const points = strList(c.points)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.8cqw' }}>
            <Block blockKey="code">
              <div
                className="flex min-w-0 flex-col overflow-hidden rounded-md border"
                style={{ flex: points.length > 0 ? '1.55 1 0%' : '1 1 0%', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
              >
                <div
                  className="flex items-center justify-between"
                  style={{ padding: '0.75cqw 1.3cqw', borderBottom: `1px solid ${ctx.line}` }}
                >
                  <span className="inline-flex" style={{ gap: '0.45cqw' }}>
                    {[0, 1, 2].map((dot) => (
                      <span key={dot} aria-hidden className="rounded-full" style={{ width: '0.85cqw', height: '0.85cqw', backgroundColor: ctx.line }} />
                    ))}
                  </span>
                  <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '1.05cqw', color: ctx.muted }}>
                    {str(c.language) || 'code'}
                  </span>
                </div>
                <pre
                  className="min-h-0 flex-1 overflow-hidden"
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '1.3cqw',
                    lineHeight: 1.6,
                    padding: '1.2cqw 1.4cqw',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {str(c.code)}
                </pre>
              </div>
            </Block>
            {points.length > 0 ? (
              <div className="flex min-w-0 flex-col justify-center" style={{ flex: '1 1 0%', gap: '1.2cqw' }}>
                <Block blockKey="points">
                  <Points items={points} ctx={ctx} size="1.35cqw" />
                </Block>
              </div>
            ) : null}
          </div>
        </div>
      )
    }
    case 'chevron-process': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex flex-1 flex-col justify-center" style={{ gap: '1.4cqw' }}>
            <div className="flex" style={{ gap: '0.45cqw' }}>
              {steps.map((step, index) => {
                const clip =
                  index === 0
                    ? 'polygon(0 0, calc(100% - 1.7cqw) 0, 100% 50%, calc(100% - 1.7cqw) 100%, 0 100%)'
                    : 'polygon(0 0, calc(100% - 1.7cqw) 0, 100% 50%, calc(100% - 1.7cqw) 100%, 0 100%, 1.7cqw 50%)'
                return (
                  <Block key={index} blockKey={`step-${index}`}>
                    <div
                      className="flex min-w-0 flex-1 flex-col items-center justify-center text-center"
                      style={{
                        clipPath: clip,
                        backgroundColor: seriesColor(index, ctx.accent, ctx.series),
                        color: 'var(--daedalus-onPrimary)',
                        gap: '0.3cqw',
                        padding: '1.15cqw 1.9cqw 1.15cqw 2.2cqw',
                        minHeight: '6.8cqw',
                      }}
                    >
                      <span className="font-bold" style={{ fontSize: '1cqw', letterSpacing: '0.18em', opacity: 0.75 }}>
                        LANGKAH {index + 1}
                      </span>
                      <span className="font-bold" style={{ fontSize: '1.5cqw', lineHeight: 1.2 }}>
                        {str(step.title)}
                      </span>
                    </div>
                  </Block>
                )
              })}
            </div>
            {steps.some((step) => str(step.desc)) ? (
              <div className="flex" style={{ gap: '0.45cqw' }}>
                {steps.map((step, index) => (
                  <div key={index} className="min-w-0 flex-1 text-center" style={{ padding: '0 0.7cqw' }}>
                    <span className="line-clamp-4" style={{ fontSize: '1.12cqw', color: ctx.muted, lineHeight: 1.4 }}>
                      {str(step.desc)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )
    }
    case 'diagram-pyramid': {
      const tiers = objList(c.tiers)
      const n = Math.max(1, tiers.length)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex flex-1 flex-col items-center justify-center" style={{ gap: '0.55cqw' }}>
            {tiers.map((tier, index) => {
              const widthPct = 38 + (index * 56) / Math.max(1, n - 1)
              return (
                <Block key={index} blockKey={`tier-${index}`}>
                  <div
                    className="flex flex-col items-center justify-center text-center"
                    style={{
                      width: `${widthPct}%`,
                      clipPath: 'polygon(9% 0, 91% 0, 100% 100%, 0 100%)',
                      backgroundColor: seriesColor(index, ctx.accent, ctx.series),
                      color: 'var(--daedalus-onPrimary)',
                      gap: '0.25cqw',
                      padding: '1cqw 3cqw',
                      minHeight: '6.2cqw',
                    }}
                  >
                    <span className="font-bold" style={{ fontSize: '1.55cqw', lineHeight: 1.2 }}>
                      {str(tier.label)}
                    </span>
                    {str(tier.desc) ? (
                      <span className="line-clamp-2" style={{ fontSize: '1.1cqw', lineHeight: 1.35, opacity: 0.85 }}>
                        {str(tier.desc)}
                      </span>
                    ) : null}
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'roadmap': {
      const phases = objList(c.phases)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.4cqw' }}>
            {phases.map((phase, index) => (
              <Block key={index} blockKey={`phase-${index}`}>
                <div
                  className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border"
                  style={{ gap: '0.8cqw', padding: '1.3cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <div className="flex items-center" style={{ gap: '0.7cqw' }}>
                    <span
                      aria-hidden
                      className="flex shrink-0 items-center justify-center rounded-full font-bold"
                      style={{ width: '2.2cqw', height: '2.2cqw', backgroundColor: seriesColor(index, ctx.accent, ctx.series), color: 'var(--daedalus-onPrimary)', fontSize: '1.15cqw' }}
                    >
                      {index + 1}
                    </span>
                    <span className="font-semibold" style={{ fontSize: '1.5cqw', color: ctx.accent, lineHeight: 1.25 }}>
                      {str(phase.label)}
                    </span>
                  </div>
                  <Points items={strList(phase.items)} ctx={ctx} size="1.18cqw" />
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'versus': {
      const left = obj(c.left)
      const right = obj(c.right)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="relative flex min-h-0 flex-1" style={{ gap: '6.4cqw' }}>
            <Block blockKey="left">
              <ColumnPanel heading={str(left.title)} points={strList(left.points)} ctx={ctx} />
            </Block>
            <Block blockKey="right">
              <ColumnPanel heading={str(right.title)} points={strList(right.points)} ctx={ctx} />
            </Block>
            <Block blockKey="badge">
              <span
                aria-hidden
                className="absolute flex items-center justify-center rounded-full font-bold"
                style={{
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: '5.6cqw',
                  height: '5.6cqw',
                  backgroundColor: ctx.accent,
                  color: 'var(--daedalus-onPrimary)',
                  fontSize: '1.9cqw',
                  zIndex: 5,
                  boxShadow: '0 0 0 0.55cqw var(--daedalus-bgBase)',
                }}
              >
                VS
              </span>
            </Block>
          </div>
          {str(c.verdict) ? (
            <Block blockKey="verdict">
              <div
                className="rounded-md border text-center font-semibold"
                style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.5cqw', padding: '0.9cqw' }}
              >
                {str(c.verdict)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'matrix-quadrant': {
      const quadrants = objList(c.quadrants).slice(0, 4)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.3cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '0.7cqw' }}>
            <div
              className="flex items-center justify-center font-semibold uppercase"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: '1.15cqw', letterSpacing: '0.16em', color: ctx.muted }}
            >
              {str(c.yAxis)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '0.7cqw' }}>
              <div className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '1.1cqw' }}>
                <div aria-hidden className="absolute" style={{ left: '50%', top: 0, bottom: 0, width: 2, transform: 'translateX(-50%)', backgroundColor: ctx.accent, opacity: 0.3 }} />
                <div aria-hidden className="absolute" style={{ top: '50%', left: 0, right: 0, height: 2, transform: 'translateY(-50%)', backgroundColor: ctx.accent, opacity: 0.3 }} />
                {quadrants.map((quadrant, index) => (
                  <Block key={index} blockKey={`quadrant-${index}`}>
                    <div
                      className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border"
                      style={{ gap: '0.7cqw', padding: '1.15cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                    >
                      <div className="font-semibold" style={{ fontSize: '1.45cqw', color: ctx.accent }}>
                        {str(quadrant.label)}
                      </div>
                      <Points items={strList(quadrant.items)} ctx={ctx} size="1.12cqw" />
                    </div>
                  </Block>
                ))}
              </div>
              <div className="text-center font-semibold uppercase" style={{ fontSize: '1.15cqw', letterSpacing: '0.16em', color: ctx.muted }}>
                {str(c.xAxis)}
              </div>
            </div>
          </div>
        </div>
      )
    }
    case 'big-stat': {
      const points = strList(c.points)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="flex flex-1 items-center" style={{ gap: '3cqw' }}>
            <div className="flex min-w-0 flex-col" style={{ flex: '1.25 1 0%', gap: '0.9cqw' }}>
              <Block blockKey="value">
                <div className="font-bold" style={{ fontSize: '9cqw', lineHeight: 1, color: ctx.accent }}>
                  {str(c.value)}
                </div>
              </Block>
              <Block blockKey="label">
                <div style={{ fontSize: '1.9cqw', lineHeight: 1.35, color: ctx.muted }}>{str(c.label)}</div>
              </Block>
            </div>
            {points.length > 0 ? (
              <Block blockKey="points">
                <div
                  className="flex flex-col justify-center rounded-md border"
                  style={{ flex: '1 1 0%', gap: '1cqw', padding: '1.6cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <Points items={points} ctx={ctx} size="1.35cqw" />
                </div>
              </Block>
            ) : null}
          </div>
        </div>
      )
    }
    case 'testimonial': {
      const metrics = objList(c.metrics)
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.8cqw', padding: '0 3.5cqw' }}>
          <Block blockKey="text">
            <div className="flex flex-col items-center" style={{ gap: '1.5cqw' }}>
              <QuoteIcon aria-hidden style={{ width: '3.6cqw', height: '3.6cqw', color: ctx.accent }} />
              <div className="line-clamp-5" style={{ fontSize: '3cqw', lineHeight: 1.32, fontStyle: 'italic' }}>
                {str(c.text)}
              </div>
            </div>
          </Block>
          <Block blockKey="person">
            <div
              className="flex items-center rounded-full border"
              style={{ gap: '1.1cqw', padding: '0.8cqw 1.9cqw 0.8cqw 0.8cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
            >
              <span
                aria-hidden
                className="flex shrink-0 items-center justify-center rounded-full font-bold"
                style={{ width: '3.8cqw', height: '3.8cqw', backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', fontSize: '1.5cqw' }}
              >
                {initialsOf(str(c.name))}
              </span>
              <span className="flex flex-col text-left">
                <span className="font-semibold" style={{ fontSize: '1.55cqw', lineHeight: 1.2 }}>
                  {str(c.name)}
                </span>
                {str(c.role) ? <span style={{ fontSize: '1.15cqw', color: ctx.muted }}>{str(c.role)}</span> : null}
              </span>
            </div>
          </Block>
          {metrics.length > 0 ? (
            <Block blockKey="metrics">
              <div className="flex flex-wrap justify-center" style={{ gap: '1.1cqw' }}>
                {metrics.map((metric, index) => (
                  <span
                    key={index}
                    className="rounded-full border"
                    style={{ borderColor: ctx.line, backgroundColor: ctx.panelBg, padding: '0.6cqw 1.4cqw', fontSize: '1.2cqw' }}
                  >
                    <strong style={{ color: ctx.accent }}>{str(metric.value)}</strong> {str(metric.label)}
                  </span>
                ))}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'profile-cards': {
      const people = objList(c.people)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, people.length)}, minmax(0, 1fr))`, gridAutoRows: '1fr', gap: '1.4cqw' }}>
            {people.map((person, index) => (
              <Block key={index} blockKey={`person-${index}`}>
                <div
                  className="flex flex-col overflow-hidden rounded-md border"
                  style={{ gap: '0.75cqw', padding: '1.5cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <span
                    aria-hidden
                    className="flex items-center justify-center rounded-full font-bold"
                    style={{ width: '4.4cqw', height: '4.4cqw', backgroundColor: seriesColor(index, ctx.accent, ctx.series), color: 'var(--daedalus-onPrimary)', fontSize: '1.7cqw' }}
                  >
                    {initialsOf(str(person.name))}
                  </span>
                  <div className="font-semibold" style={{ fontSize: '1.6cqw', lineHeight: 1.25 }}>
                    {str(person.name)}
                  </div>
                  <div className="font-semibold uppercase" style={{ fontSize: '1.08cqw', letterSpacing: '0.13em', color: ctx.accent }}>
                    {str(person.role)}
                  </div>
                  {str(person.note) ? (
                    <div className="line-clamp-4" style={{ fontSize: '1.15cqw', color: ctx.muted, lineHeight: 1.4 }}>
                      {str(person.note)}
                    </div>
                  ) : null}
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'glossary': {
      const terms = objList(c.terms)
      const cols = terms.length <= 4 ? 2 : 3
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '1fr', gap: '1.3cqw' }}>
            {terms.map((entry, index) => (
              <Block key={index} blockKey={`term-${index}`}>
                <div
                  className="flex flex-col overflow-hidden rounded-md border"
                  style={{ gap: '0.6cqw', padding: '1.3cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <div className="font-semibold" style={{ fontSize: '1.5cqw', color: ctx.accent, lineHeight: 1.25 }}>
                    {str(entry.term)}
                  </div>
                  <div className="line-clamp-4" style={{ fontSize: '1.18cqw', color: ctx.muted, lineHeight: 1.45 }}>
                    {str(entry.definition)}
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'mosaic': {
      const tiles = objList(c.tiles).slice(0, 4)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.2cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div
            className="grid min-h-0 flex-1"
            style={{ gridTemplateColumns: '1.9fr 1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '1.1cqw' }}
          >
            {tiles.map((tile, index) => {
              const cellStyle: CSSProperties =
                index === 0 ? { gridRow: '1 / span 2' } : index === 1 ? { gridColumn: '2 / span 2' } : {}
              return (
                <Block key={index} blockKey={`tile-${index}`}>
                  <ImageSlot blockKey={`tile-${index}`} image={str(tile.image)} alt={str(tile.alt)} caption={str(tile.caption)} ctx={ctx} style={cellStyle} />
                </Block>
              )
            })}
          </div>
          {str(c.caption) ? (
            <Block blockKey="caption">
              <div className="text-center" style={{ fontSize: '1.2cqw', color: ctx.muted }}>
                {str(c.caption)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'agenda-toc': {
      const items = objList(c.items)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <AccentBar accent={ctx.accent} width="5cqw" />
          <div className="flex min-h-0 flex-1 flex-col justify-center">
            {items.map((item, index) => (
              <Block key={index} blockKey={`item-${index}`}>
                <div className="flex items-center" style={{ gap: '1.4cqw', padding: '0.8cqw 0.2cqw', borderBottom: `1px solid ${ctx.line}` }}>
                  <span className="font-bold" style={{ fontSize: '2cqw', lineHeight: 1.1, color: ctx.accent, minWidth: '3.6cqw' }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium" style={{ fontSize: '1.65cqw' }}>
                    {str(item.label)}
                  </span>
                  {str(item.page) ? (
                    <span className="shrink-0 rounded-full border font-semibold" style={{ borderColor: ctx.line, color: ctx.muted, fontSize: '1.05cqw', padding: '0.25cqw 0.95cqw' }}>
                      {str(item.page)}
                    </span>
                  ) : null}
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'kpi-band': {
      const kpis = objList(c.kpis)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="grid min-h-0 flex-1 items-center" style={{ gridTemplateColumns: `repeat(${Math.max(1, kpis.length)}, minmax(0, 1fr))`, gap: '1.3cqw' }}>
            {kpis.map((kpi, index) => {
              const down = kpi.deltaUp === false
              const deltaColor = down ? 'var(--daedalus-warning)' : 'var(--daedalus-success)'
              return (
                <Block key={index} blockKey={`kpi-${index}`}>
                  <div
                    className="flex flex-col justify-center overflow-hidden rounded-md border"
                    style={{ gap: '0.75cqw', padding: '1.6cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg, minHeight: '58%' }}
                  >
                    <div className="font-bold" style={{ fontSize: '3.7cqw', lineHeight: 1.05, color: ctx.accent }}>
                      {str(kpi.value)}
                    </div>
                    <div className="line-clamp-3" style={{ fontSize: '1.2cqw', lineHeight: 1.35, color: ctx.muted }}>
                      {str(kpi.label)}
                    </div>
                    {str(kpi.delta) ? (
                      <span
                        className="w-fit rounded-full border font-semibold"
                        style={{ borderColor: deltaColor, color: deltaColor, fontSize: '1.05cqw', padding: '0.3cqw 0.9cqw' }}
                      >
                        {down ? '▼' : '▲'} {str(kpi.delta)}
                      </span>
                    ) : null}
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'funnel': {
      const stages = objList(c.stages)
      const fallback = [100, 78, 58, 40]
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ gap: '0.95cqw' }}>
            {stages.map((stage, index) => {
              const value = num(stage.value)
              const pct = value > 0 && value <= 100 ? Math.max(30, value) : fallback[Math.min(index, fallback.length - 1)]!
              return (
                <Block key={index} blockKey={`stage-${index}`}>
                  <div className="flex items-center" style={{ gap: '1.5cqw' }}>
                    <div
                      className="shrink-0 rounded-md"
                      style={{ width: `${26 + pct * 0.5}%`, backgroundColor: seriesColor(index, ctx.accent, ctx.series), padding: '0.85cqw 1.3cqw' }}
                    >
                      <div className="flex items-baseline justify-between" style={{ gap: '1cqw', color: 'var(--daedalus-onPrimary)' }}>
                        <span className="truncate font-semibold" style={{ fontSize: '1.45cqw' }}>
                          {str(stage.label)}
                        </span>
                        {value > 0 ? (
                          <span className="shrink-0 font-bold" style={{ fontSize: '1.45cqw' }}>
                            {value}%
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {str(stage.desc) ? (
                      <div className="line-clamp-2 min-w-0" style={{ fontSize: '1.15cqw', lineHeight: 1.35, color: ctx.muted }}>
                        {str(stage.desc)}
                      </div>
                    ) : null}
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'gantt-bars': {
      const bars = objList(c.bars)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          {str(c.startLabel) || str(c.endLabel) ? (
            <div className="flex" style={{ paddingLeft: '23.2%', paddingRight: '15.2%', fontSize: '1.05cqw', color: ctx.muted }}>
              <span className="flex-1">{str(c.startLabel)}</span>
              <span>{str(c.endLabel)}</span>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ gap: '0.85cqw' }}>
            {bars.map((bar, index) => {
              const start = Math.min(95, Math.max(0, num(bar.start)))
              const span = Math.min(100 - start, Math.max(3, num(bar.span) || 10))
              return (
                <Block key={index} blockKey={`bar-${index}`}>
                  <div className="flex items-center" style={{ gap: '1.2cqw' }}>
                    <div className="shrink-0 truncate font-medium" style={{ width: '22%', fontSize: '1.25cqw' }}>
                      {str(bar.label)}
                    </div>
                    <div className="relative flex-1 rounded-full border" style={{ height: '2.05cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}>
                      <div
                        className="absolute rounded-full"
                        style={{ left: `${start}%`, width: `${span}%`, top: '16%', height: '68%', backgroundColor: seriesColor(index, ctx.accent, ctx.series) }}
                      />
                    </div>
                    <div className="shrink-0 truncate" style={{ width: '14%', fontSize: '1.05cqw', color: ctx.muted }}>
                      {str(bar.note)}
                    </div>
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'org-chart': {
      const root = obj(c.root)
      const reports = objList(c.reports)
      const personCard = (person: Record<string, unknown>, members: string[], big: boolean) => (
        <div
          className="flex flex-col items-center overflow-hidden rounded-md border text-center"
          style={{ gap: '0.55cqw', padding: big ? '1.4cqw' : '1.2cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
        >
          <span
            aria-hidden
            className="flex shrink-0 items-center justify-center rounded-full font-bold"
            style={{
              width: big ? '4.2cqw' : '3.6cqw',
              height: big ? '4.2cqw' : '3.6cqw',
              backgroundColor: ctx.accent,
              color: 'var(--daedalus-onPrimary)',
              fontSize: big ? '1.6cqw' : '1.35cqw',
            }}
          >
            {initialsOf(str(person.name))}
          </span>
          <div className="font-semibold" style={{ fontSize: big ? '1.6cqw' : '1.4cqw', lineHeight: 1.2 }}>
            {str(person.name)}
          </div>
          <div className="line-clamp-2 font-semibold uppercase" style={{ fontSize: '1cqw', letterSpacing: '0.12em', color: ctx.accent }}>
            {str(person.role)}
          </div>
          {members.length > 0 ? (
            <div className="flex flex-wrap justify-center" style={{ gap: '0.45cqw' }}>
              {members.map((member, i) => (
                <span key={i} className="rounded-full border" style={{ borderColor: ctx.line, color: ctx.muted, fontSize: '0.95cqw', padding: '0.2cqw 0.7cqw' }}>
                  {member}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.3cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex justify-center">
            <div style={{ width: '36%' }}>
              <Block blockKey="root">{personCard(root, [], true)}</Block>
            </div>
          </div>
          <div aria-hidden className="relative w-full" style={{ height: '1.7cqw' }}>
            <div className="absolute" style={{ left: '50%', top: 0, width: 2, height: '0.85cqw', marginLeft: -1, backgroundColor: ctx.line }} />
            {reports.length > 1 ? (
              <div
                className="absolute"
                style={{
                  top: '0.85cqw',
                  height: 2,
                  left: `${(0.5 / Math.max(1, reports.length)) * 100}%`,
                  width: `${((reports.length - 1) / Math.max(1, reports.length)) * 100}%`,
                  backgroundColor: ctx.line,
                }}
              />
            ) : null}
          </div>
          <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, reports.length)}, minmax(0, 1fr))`, gap: '1.3cqw' }}>
            {reports.map((person, index) => (
              <Block key={index} blockKey={`person-${index}`}>
                {personCard(person, strList(person.members), false)}
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'pros-cons': {
      const pros = obj(c.pros)
      const cons = obj(c.cons)
      const panel = (column: Record<string, unknown>, good: boolean) => (
        <div
          className="flex min-w-0 flex-1 flex-col rounded-md border"
          style={{ gap: '1cqw', padding: '1.6cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
        >
          <div className="flex items-center" style={{ gap: '0.8cqw' }}>
            <span
              aria-hidden
              className="font-bold"
              style={{ fontSize: '1.8cqw', lineHeight: 1, color: good ? 'var(--daedalus-success)' : 'var(--daedalus-warning)' }}
            >
              {good ? '✓' : '✗'}
            </span>
            <span className="font-semibold" style={{ fontSize: '1.75cqw', color: ctx.accent }}>
              {str(column.title)}
            </span>
          </div>
          <CheckList
            items={strList(column.points)}
            ctx={ctx}
            size="1.3cqw"
            marker={good ? '✓' : '✗'}
            markerColor={good ? 'var(--daedalus-success)' : 'var(--daedalus-warning)'}
          />
        </div>
      )
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.6cqw' }}>
            <Block blockKey="pros">{panel(pros, true)}</Block>
            <Block blockKey="cons">{panel(cons, false)}</Block>
          </div>
        </div>
      )
    }
    case 'pricing-tiers': {
      const tiers = objList(c.tiers)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="grid min-h-0 flex-1 items-stretch" style={{ gridTemplateColumns: `repeat(${Math.max(1, tiers.length)}, minmax(0, 1fr))`, gap: '1.3cqw' }}>
            {tiers.map((tier, index) => {
              const featured = tier.featured === true
              return (
                <Block key={index} blockKey={`tier-${index}`}>
                  <div
                    className="relative flex flex-col overflow-hidden rounded-md"
                    style={{
                      gap: '0.8cqw',
                      padding: '1.6cqw',
                      border: `${featured ? '0.28cqw' : '1px'} solid ${featured ? ctx.accent : ctx.line}`,
                      backgroundColor: ctx.panelBg,
                      ...(featured ? { transform: 'scale(1.02)' } : {}),
                    }}
                  >
                    {featured ? (
                      <span
                        className="w-fit rounded-full font-bold uppercase"
                        style={{ backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', fontSize: '0.95cqw', letterSpacing: '0.1em', padding: '0.3cqw 0.9cqw' }}
                      >
                        Paling dipilih
                      </span>
                    ) : null}
                    <div className="font-semibold uppercase" style={{ fontSize: '1.25cqw', letterSpacing: '0.14em', color: ctx.muted }}>
                      {str(tier.name)}
                    </div>
                    <div className="font-bold" style={{ fontSize: '3cqw', lineHeight: 1.05, color: featured ? ctx.accent : undefined }}>
                      {str(tier.price)}
                    </div>
                    {str(tier.period) ? <div style={{ fontSize: '1.05cqw', color: ctx.muted }}>{str(tier.period)}</div> : null}
                    <CheckList items={strList(tier.features)} ctx={ctx} size="1.18cqw" />
                  </div>
                </Block>
              )
            })}
          </div>
          {str(c.note) ? (
            <Block blockKey="note">
              <div className="text-center" style={{ fontSize: '1.15cqw', color: ctx.muted }}>
                {str(c.note)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'faq': {
      const items = objList(c.items)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ gap: '1.05cqw' }}>
            {items.map((item, index) => (
              <Block key={index} blockKey={`item-${index}`}>
                <div className="flex" style={{ gap: '1.2cqw', paddingBottom: '0.9cqw', borderBottom: `1px solid ${ctx.line}` }}>
                  <span
                    aria-hidden
                    className="flex shrink-0 items-center justify-center rounded-full font-bold"
                    style={{ width: '2.5cqw', height: '2.5cqw', backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', fontSize: '1.3cqw' }}
                  >
                    Q
                  </span>
                  <div className="flex min-w-0 flex-col" style={{ gap: '0.35cqw' }}>
                    <div className="font-semibold" style={{ fontSize: '1.5cqw', lineHeight: 1.25 }}>
                      {str(item.q)}
                    </div>
                    <div className="line-clamp-3" style={{ fontSize: '1.22cqw', lineHeight: 1.4, color: ctx.muted }}>
                      {str(item.a)}
                    </div>
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'steps-cards': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="relative flex min-h-0 flex-1 items-stretch" style={{ gap: '1.3cqw' }}>
            <div aria-hidden className="absolute" style={{ top: '1.9cqw', left: '12%', right: '12%', borderTop: `2px dashed ${ctx.line}` }} />
            {steps.map((step, index) => {
              const Icon = iconFor(str(step.icon))
              return (
                <Block key={index} blockKey={`step-${index}`}>
                  <div className="relative flex min-w-0 flex-1 flex-col items-center" style={{ gap: '1cqw' }}>
                    <span
                      aria-hidden
                      className="flex items-center justify-center rounded-full border"
                      style={{ width: '3.8cqw', height: '3.8cqw', borderColor: ctx.accent, backgroundColor: ctx.panelBg }}
                    >
                      <Icon aria-hidden style={{ width: '1.9cqw', height: '1.9cqw', color: ctx.accent }} />
                    </span>
                    <div
                      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border text-center"
                      style={{ gap: '0.6cqw', padding: '1.3cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                    >
                      <div className="font-semibold" style={{ fontSize: '1.45cqw', lineHeight: 1.25 }}>
                        {index + 1}. {str(step.title)}
                      </div>
                      {str(step.desc) ? (
                        <div className="line-clamp-4" style={{ fontSize: '1.12cqw', lineHeight: 1.4, color: ctx.muted }}>
                          {str(step.desc)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Block>
              )
            })}
          </div>
        </div>
      )
    }
    case 'split-visual-quote': {
      const imageBox = <ImageSlot blockKey="image" image={str(c.image)} alt={str(c.alt)} ctx={ctx} style={{ width: '40%', flexShrink: 0 }} />
      const quoteCol = (
        <div className="flex min-w-0 flex-1 flex-col justify-center" style={{ gap: '1.4cqw' }}>
          <Block blockKey="quote">
            <div className="flex flex-col" style={{ gap: '1.2cqw' }}>
              <QuoteIcon aria-hidden style={{ width: '3.4cqw', height: '3.4cqw', color: ctx.accent }} />
              <div className="line-clamp-6" style={{ fontSize: '2.7cqw', lineHeight: 1.32, fontStyle: 'italic' }}>
                {str(c.quote)}
              </div>
            </div>
          </Block>
          {str(c.author) || str(c.role) ? (
            <Block blockKey="author">
              <div className="flex flex-col" style={{ gap: '0.25cqw' }}>
                <span className="font-semibold" style={{ fontSize: '1.5cqw' }}>
                  {str(c.author)}
                </span>
                {str(c.role) ? <span style={{ fontSize: '1.15cqw', color: ctx.muted }}>{str(c.role)}</span> : null}
              </div>
            </Block>
          ) : null}
        </div>
      )
      return (
        <div className="flex min-h-0 flex-1" style={{ gap: '2.4cqw' }}>
          {c.side === 'left' ? (
            <>
              <Block blockKey="image">{imageBox}</Block>
              {quoteCol}
            </>
          ) : (
            <>
              {quoteCol}
              <Block blockKey="image">{imageBox}</Block>
            </>
          )}
        </div>
      )
    }
    case 'banner-cta': {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.7cqw', padding: '0 5cqw' }}>
          <AccentBar accent={ctx.accent} width="9cqw" />
          <Block blockKey="title">
            <div className="line-clamp-3 font-bold tracking-tight" style={{ fontSize: '5cqw', lineHeight: 1.12 }}>
              {str(c.title)}
            </div>
          </Block>
          {str(c.subtitle) ? (
            <Block blockKey="subtitle">
              <div className="line-clamp-3" style={{ fontSize: '1.85cqw', lineHeight: 1.4, color: ctx.muted }}>
                {str(c.subtitle)}
              </div>
            </Block>
          ) : null}
          <Block blockKey="actions">
            <div className="flex items-center" style={{ gap: '1.2cqw' }}>
              <span className="rounded-full font-bold" style={{ backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', fontSize: '1.5cqw', padding: '0.8cqw 2.2cqw' }}>
                {str(c.primary)}
              </span>
              {str(c.secondary) ? (
                <span className="rounded-full border font-semibold" style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.5cqw', padding: '0.8cqw 2.2cqw' }}>
                  {str(c.secondary)}
                </span>
              ) : null}
            </div>
          </Block>
          {str(c.note) ? (
            <Block blockKey="note">
              <div style={{ fontSize: '1.1cqw', color: ctx.muted }}>{str(c.note)}</div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'logo-wall': {
      const logos = objList(c.logos)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="grid min-h-0 flex-1 items-center" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '1.2cqw' }}>
            {logos.map((logo, index) => (
              <Block key={index} blockKey={`logo-${index}`}>
                <div
                  className="flex flex-col items-center justify-center overflow-hidden rounded-md border text-center"
                  style={{ gap: '0.7cqw', padding: '1.3cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg, minHeight: '78%' }}
                >
                  <span
                    aria-hidden
                    className="flex items-center justify-center rounded-md border font-bold"
                    style={{ width: '3.6cqw', height: '3.6cqw', borderColor: ctx.accent, color: ctx.accent, fontSize: '1.5cqw' }}
                  >
                    {initialsOf(str(logo.name))}
                  </span>
                  <div className="line-clamp-2 font-semibold" style={{ fontSize: '1.18cqw', lineHeight: 1.3 }}>
                    {str(logo.name)}
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'year-markers': {
      const years = objList(c.years)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="flex min-h-0 flex-1 items-center" style={{ gap: '1.6cqw' }}>
            {years.map((entry, index) => (
              <Block key={index} blockKey={`year-${index}`}>
                <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '0.8cqw' }}>
                  <div className="font-bold" style={{ fontSize: '4.4cqw', lineHeight: 1, color: ctx.accent }}>
                    {str(entry.year)}
                  </div>
                  <div aria-hidden className="relative" style={{ height: '0.4cqw', backgroundColor: ctx.line }}>
                    <span className="absolute rounded-full" style={{ left: 0, top: '-0.55cqw', width: '1.5cqw', height: '1.5cqw', backgroundColor: ctx.accent }} />
                  </div>
                  <div className="font-semibold" style={{ fontSize: '1.5cqw', lineHeight: 1.25 }}>
                    {str(entry.label)}
                  </div>
                  {str(entry.desc) ? (
                    <div className="line-clamp-4" style={{ fontSize: '1.15cqw', lineHeight: 1.4, color: ctx.muted }}>
                      {str(entry.desc)}
                    </div>
                  ) : null}
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'stat-duel': {
      const left = obj(c.left)
      const right = obj(c.right)
      const side = (entry: Record<string, unknown>, strong: boolean) => (
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '0.7cqw', textAlign: strong ? 'right' : 'left' }}>
          <div className="font-bold" style={{ fontSize: '6.2cqw', lineHeight: 1, color: strong ? ctx.accent : undefined }}>
            {str(entry.value)}
          </div>
          <div className="line-clamp-3" style={{ fontSize: '1.3cqw', lineHeight: 1.4, color: ctx.muted }}>
            {str(entry.label)}
          </div>
        </div>
      )
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="flex min-h-0 flex-1 items-center" style={{ gap: '2.2cqw' }}>
            <Block blockKey="left">{side(left, false)}</Block>
            <Block blockKey="delta">
              <span
                className="shrink-0 rounded-full font-bold"
                style={{ backgroundColor: ctx.accent, color: 'var(--daedalus-onPrimary)', fontSize: '1.7cqw', padding: '0.8cqw 1.8cqw' }}
              >
                {str(c.delta)}
              </span>
            </Block>
            <Block blockKey="right">{side(right, true)}</Block>
          </div>
          {str(c.note) ? (
            <Block blockKey="note">
              <div className="rounded-md border text-center" style={{ borderColor: ctx.line, backgroundColor: ctx.panelBg, fontSize: '1.2cqw', color: ctx.muted, padding: '1cqw' }}>
                {str(c.note)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'waterfall-steps': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ gap: '0.95cqw' }}>
            {steps.map((step, index) => (
              <Block key={index} blockKey={`step-${index}`}>
                <div
                  className="flex items-center rounded-md border"
                  style={{
                    gap: '1.2cqw',
                    padding: '1.05cqw 1.5cqw',
                    marginLeft: `${index * 9}%`,
                    width: `${100 - index * 9}%`,
                    borderColor: ctx.line,
                    backgroundColor: ctx.panelBg,
                  }}
                >
                  <span className="shrink-0 font-bold" style={{ fontSize: '1.6cqw', color: ctx.accent }}>
                    {index + 1}
                  </span>
                  <div className="flex min-w-0 flex-col" style={{ gap: '0.2cqw' }}>
                    <span className="font-semibold" style={{ fontSize: '1.45cqw', lineHeight: 1.25 }}>
                      {str(step.label)}
                    </span>
                    {str(step.desc) ? (
                      <span className="line-clamp-2" style={{ fontSize: '1.1cqw', lineHeight: 1.35, color: ctx.muted }}>
                        {str(step.desc)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'feature-highlight': {
      const Icon = iconFor(str(c.icon))
      return (
        <div className="flex min-h-0 flex-1 items-center" style={{ gap: '2.6cqw' }}>
          <Block blockKey="icon">
            <span
              aria-hidden
              className="flex shrink-0 items-center justify-center rounded-full border"
              style={{ width: '9.5cqw', height: '9.5cqw', borderColor: ctx.accent, backgroundColor: ctx.panelBg }}
            >
              <Icon aria-hidden style={{ width: '4.6cqw', height: '4.6cqw', color: ctx.accent }} />
            </span>
          </Block>
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: '1.3cqw' }}>
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
            {str(c.lead) ? (
              <div className="line-clamp-3" style={{ fontSize: '1.5cqw', lineHeight: 1.45, color: ctx.muted }}>
                {str(c.lead)}
              </div>
            ) : null}
            <Block blockKey="checks">
              <CheckList items={strList(c.checks)} ctx={ctx} size="1.35cqw" />
            </Block>
          </div>
        </div>
      )
    }
    case 'callout': {
      const tone = str(c.tone)
      const toneColor = tone === 'success' ? 'var(--daedalus-success)' : tone === 'warning' ? 'var(--daedalus-warning)' : ctx.accent
      const Icon = iconFor(str(c.icon) || (tone === 'success' ? 'circle-check' : 'info'))
      return (
        <div className="flex flex-1 flex-col justify-center">
          <div
            className="flex flex-col rounded-md"
            style={{ gap: '1.1cqw', padding: '2cqw', border: `1px solid ${ctx.line}`, borderLeft: `0.7cqw solid ${toneColor}`, backgroundColor: ctx.panelBg }}
          >
            <div className="flex items-center" style={{ gap: '1.2cqw' }}>
              <span
                aria-hidden
                className="flex shrink-0 items-center justify-center rounded-full"
                style={{ width: '3.5cqw', height: '3.5cqw', backgroundColor: toneColor }}
              >
                <Icon aria-hidden style={{ width: '1.9cqw', height: '1.9cqw', color: 'var(--daedalus-onPrimary)' }} />
              </span>
              <Block blockKey="title">
                <div className="font-bold" style={{ fontSize: '2.2cqw', lineHeight: 1.2 }}>
                  {str(c.title)}
                </div>
              </Block>
            </div>
            <Block blockKey="body">
              <div className="line-clamp-5" style={{ fontSize: '1.45cqw', lineHeight: 1.5 }}>
                {str(c.body)}
              </div>
            </Block>
            {strList(c.points).length > 0 ? (
              <Block blockKey="points">
                <CheckList items={strList(c.points)} ctx={ctx} size="1.25cqw" markerColor={toneColor} />
              </Block>
            ) : null}
          </div>
        </div>
      )
    }
    case 'ranking-list': {
      const entries = objList(c.entries)
      const max = Math.max(1, ...entries.map((entry) => num(entry.value)))
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <Block blockKey="title">
            <SlideTitle>{str(c.title)}</SlideTitle>
          </Block>
          <div className="flex min-h-0 flex-1 flex-col justify-center">
            {entries.map((entry, index) => (
              <Block key={index} blockKey={`entry-${index}`}>
                <div className="flex flex-col" style={{ gap: '0.5cqw', padding: '0.6cqw 0.2cqw', borderBottom: `1px solid ${ctx.line}` }}>
                  <div className="flex items-baseline" style={{ gap: '1.2cqw' }}>
                    <span className="font-bold" style={{ fontSize: '1.9cqw', minWidth: '3cqw', color: index === 0 ? ctx.accent : ctx.muted }}>
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold" style={{ fontSize: '1.45cqw' }}>
                      {str(entry.label)}
                      {str(entry.note) ? (
                        <span className="font-normal" style={{ fontSize: '1.1cqw', color: ctx.muted }}>
                          {'  '}· {str(entry.note)}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-bold" style={{ fontSize: '1.5cqw', color: ctx.accent }}>
                      {str(entry.value)}
                    </span>
                  </div>
                  <div className="flex" style={{ gap: '1.2cqw' }}>
                    <span aria-hidden style={{ minWidth: '3cqw' }} />
                    <div className="relative flex-1 overflow-hidden rounded-full border" style={{ height: '0.95cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}>
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(4, (num(entry.value) / max) * 100)}%`, backgroundColor: seriesColor(index, ctx.accent, ctx.series) }} />
                    </div>
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    case 'hero-image-caption': {
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <Block blockKey="image">
            <ImageSlot blockKey="image" image={str(c.image)} alt={str(c.alt)} ctx={ctx} style={{ height: '56%', flexShrink: 0 }} />
          </Block>
          <Block blockKey="title">
            <div className="line-clamp-2 font-bold tracking-tight" style={{ fontSize: '3.3cqw', lineHeight: 1.15 }}>
              {str(c.title)}
            </div>
          </Block>
          {str(c.caption) ? (
            <Block blockKey="caption">
              <div className="line-clamp-3" style={{ fontSize: '1.35cqw', lineHeight: 1.45, color: ctx.muted }}>
                {str(c.caption)}
              </div>
            </Block>
          ) : null}
        </div>
      )
    }
    case 'quote-wall': {
      const quotes = objList(c.quotes)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          {str(c.title) ? (
            <Block blockKey="title">
              <SlideTitle>{str(c.title)}</SlideTitle>
            </Block>
          ) : null}
          <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, quotes.length)}, minmax(0, 1fr))`, gap: '1.3cqw' }}>
            {quotes.map((quote, index) => (
              <Block key={index} blockKey={`quote-${index}`}>
                <div
                  className="flex flex-col overflow-hidden rounded-md border"
                  style={{ gap: '0.9cqw', padding: '1.5cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <QuoteIcon aria-hidden style={{ width: '2.2cqw', height: '2.2cqw', color: ctx.accent }} />
                  <div className="line-clamp-5 flex-1" style={{ fontSize: '1.42cqw', lineHeight: 1.45, fontStyle: 'italic' }}>
                    {str(quote.text)}
                  </div>
                  <div className="flex items-center" style={{ gap: '0.9cqw' }}>
                    <span
                      aria-hidden
                      className="flex shrink-0 items-center justify-center rounded-full font-bold"
                      style={{ width: '3.1cqw', height: '3.1cqw', backgroundColor: seriesColor(index, ctx.accent, ctx.series), color: 'var(--daedalus-onPrimary)', fontSize: '1.2cqw' }}
                    >
                      {initialsOf(str(quote.name))}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold" style={{ fontSize: '1.25cqw', lineHeight: 1.25 }}>
                        {str(quote.name)}
                      </span>
                      {str(quote.role) ? (
                        <span className="truncate" style={{ fontSize: '1.02cqw', color: ctx.muted }}>
                          {str(quote.role)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
              </Block>
            ))}
          </div>
        </div>
      )
    }
    default: {
      return (
        <div className="flex flex-1 flex-col justify-center" style={{ gap: '1.2cqw' }}>
          <SlideTitle>{str(c.title) || slide.id}</SlideTitle>
          <div style={{ fontSize: '1.5cqw', color: ctx.muted }}>Layout tidak dikenal: {slide.layout}</div>
        </div>
      )
    }
  }
}

type DragSession = {
  key: string
  startX: number
  startY: number
  boxW: number
  boxH: number
  origin: BlockPosition
  last: BlockPosition
  moved: boolean
}

/**
 * One image slot of a template page: the user's picked deck asset wins,
 * then the template's own original picture, then the standard labelled
 * placeholder. A failed load falls back to the placeholder rather than a
 * broken glyph. In Edit mode the whole rect is the click target that asks
 * the stage for the image picker (the stage writes the chosen asset into
 * content.slots[slotKey]).
 */
function TemplateImageSlot({ slotKey, rectStyle, chosen, chosenSrc, originalSrc, editable, onImagePick, ctx }: {
  slotKey: string
  rectStyle: CSSProperties
  chosen: string
  chosenSrc?: string
  originalSrc?: string
  editable: boolean
  onImagePick?: (blockKey: string) => void
  ctx: Ctx
}) {
  const src = chosenSrc ?? originalSrc
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  const clickable = editable && onImagePick !== undefined
  const inner = src && !failed ? (
    <img src={src} alt={chosen || 'gambar template'} className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} />
  ) : (
    <span className="flex h-full w-full flex-col items-center justify-center border border-dashed text-center" style={{ borderColor: ctx.line, backgroundColor: ctx.panelBg, gap: '0.7cqw', padding: '1cqw' }}>
      <ImageIcon aria-hidden style={{ width: '3.4cqw', height: '3.4cqw', color: ctx.accent }} />
      <span className="break-all font-semibold" style={{ fontSize: '1.1cqw' }}>
        {chosen || 'image'}
      </span>
      {clickable ? (
        <span className="font-semibold" style={{ fontSize: '1cqw', color: ctx.accent }}>
          Klik untuk upload gambar
        </span>
      ) : null}
    </span>
  )
  if (!clickable) {
    return (
      <div className="absolute overflow-hidden" style={rectStyle} data-testid={`template-slot-${slotKey}`}>
        {inner}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid={`slide-image-upload-${slotKey}`}
      aria-label={`Upload gambar untuk slot ${slotKey}`}
      className="absolute cursor-pointer overflow-hidden"
      style={rectStyle}
      onClick={() => onImagePick(slotKey)}
    >
      {inner}
    </button>
  )
}

/**
 * The template slide body: the imported page's slots at their exact
 * fractions of the slide box (960pt wide → fontSizePt/9.6 in cqw). Text
 * renders where the template put it, with the template's own run style;
 * image slots follow TemplateImageSlot's honest fallback chain. Slot
 * positions are the template's design — fixed, never draggable.
 */
function TemplateSlots({ slide, page, assetSrc, editable, onImagePick, imageSrc, ctx }: {
  slide: Slide
  page: import('../../api/client').PptTemplatePageInfo
  assetSrc: (file: string) => string
  editable: boolean
  onImagePick?: (blockKey: string) => void
  imageSrc?: (name: string) => string | undefined
  ctx: Ctx
}) {
  const slots = obj(slide.content.slots)
  return (
    <div className="absolute inset-0" style={{ zIndex: 2 }} data-testid="template-slide" data-page-kind={page.kind}>
      {page.slots.map((slot) => {
        const rectStyle: CSSProperties = {
          left: `${slot.rect.x * 100}%`,
          top: `${slot.rect.y * 100}%`,
          width: `${slot.rect.w * 100}%`,
          height: `${slot.rect.h * 100}%`,
        }
        if (slot.kind === 'text') {
          const value = typeof slots[slot.key] === 'string' ? (slots[slot.key] as string) : ''
          return (
            <div
              key={slot.key}
              data-testid={`template-slot-${slot.key}`}
              className="absolute overflow-hidden whitespace-pre-wrap"
              style={{
                ...rectStyle,
                fontSize: `${slot.fontSizePt / 9.6}cqw`,
                fontWeight: slot.bold ? 700 : 400,
                ...(slot.color ? { color: slot.color } : {}),
                ...(slot.fontFamily ? { fontFamily: slot.fontFamily } : {}),
                textAlign: slot.align ?? 'left',
                lineHeight: 1.25,
                pointerEvents: 'none',
              }}
            >
              {value}
            </div>
          )
        }
        const chosen = typeof slots[slot.key] === 'string' ? (slots[slot.key] as string) : ''
        return (
          <TemplateImageSlot
            key={slot.key}
            slotKey={slot.key}
            rectStyle={rectStyle}
            chosen={chosen}
            chosenSrc={chosen && imageSrc ? imageSrc(chosen) : undefined}
            originalSrc={slot.imageFile ? assetSrc(slot.imageFile) : undefined}
            editable={editable}
            onImagePick={onImagePick}
            ctx={ctx}
          />
        )
      })}
    </div>
  )
}

/**
 * A template slide whose page design could not be resolved (template
 * deleted or fetch failed): honest degradation — theme background plus
 * the slide's own words as plain lines, never a fake design.
 */
function TemplateFallbackBody({ slide, ctx }: { slide: Slide; ctx: Ctx }) {
  const slots = obj(slide.content.slots)
  const lines = [...new Set([str(slide.content.title), ...Object.values(slots).filter((v): v is string => typeof v === 'string' && v.length > 0)])].filter((line) => line.length > 0)
  return (
    <div className="flex flex-1 flex-col justify-center" style={{ gap: '1.2cqw' }} data-testid="template-slide-fallback">
      {lines.map((line, index) => (
        <div key={index} className={index === 0 ? 'font-bold tracking-tight' : undefined} style={{ fontSize: index === 0 ? '3.3cqw' : '1.6cqw', color: index === 0 ? undefined : ctx.muted, lineHeight: 1.3 }}>
          {line}
        </div>
      ))}
      <div style={{ fontSize: '1.2cqw', color: ctx.muted }}>Desain template tidak terbaca — impor ulang template-nya dari panel Template dari PPT.</div>
    </div>
  )
}

export function SlideRenderer({ slide, theme, editable = false, onPositionsChange, resolveImageSrc, onImagePick, templateSlide }: {
  slide: Slide
  theme?: DeckSpec['theme']
  /** Edit mode: blocks become grabbable; drags persist via onPositionsChange. */
  editable?: boolean
  onPositionsChange?: (slideId: string, positions: Record<string, BlockPosition>) => void
  /** Maps a local deck-asset name to a displayable URL (uploaded images). */
  resolveImageSrc?: (name: string) => string | undefined
  /** Edit mode: an image placeholder/image was clicked (not dragged). */
  onImagePick?: (blockKey: string) => void
  /**
   * For templateRef slides: the imported template's parsed page this
   * slide pours into, plus its asset URL resolver (page backgrounds and
   * slot pictures live in the template store, not deck/assets).
   */
  templateSlide?: { page: import('../../api/client').PptTemplatePageInfo; assetSrc: (file: string) => string }
}) {
  const isLight = theme?.dark === false
  const light = getPalette('light')
  const accent = typeof theme?.accent === 'string' && theme.accent.trim() !== '' ? theme.accent : 'var(--daedalus-accent)'
  // Template tokens (slides/templates.ts) win over the app palette when
  // the deck carries them — the canvas then matches the exported PPTX,
  // which resolves the same tokens in core's exporter.
  const ctx: Ctx = {
    accent,
    muted: theme?.muted ?? (isLight ? light.fgMoreSubtle : 'var(--daedalus-fgMoreSubtle)'),
    panelBg: theme?.surface ?? (isLight ? light.bgBase : 'var(--daedalus-bgSurface)'),
    line: 'var(--daedalus-separator)',
    ...(Array.isArray(theme?.series) && theme.series.length > 0 ? { series: theme.series } : {}),
  }
  // Imported-template background image (a deck asset, resolved like slide
  // images): paints over the background color exactly as the exported
  // PPTX paints it; without a resolver the color alone carries the theme.
  const bgSrc = theme?.backgroundImage && resolveImageSrc ? resolveImageSrc(theme.backgroundImage) : undefined
  // A template slide's own page design wins over the deck theme skin:
  // its stored background image (or color) is the slide's background.
  const tpl = slide.templateRef && templateSlide ? templateSlide : undefined
  const tplBgSrc = tpl?.page.background?.imageFile ? tpl.assetSrc(tpl.page.background.imageFile) : undefined
  const rootStyle: CSSProperties = {
    backgroundColor: tpl?.page.background?.color ?? theme?.background ?? (isLight ? light.bgSurface : 'var(--daedalus-bgBase)'),
    color: theme?.text ?? (isLight ? light.fgBase : 'var(--daedalus-fgBase)'),
    ...(theme?.bodyFont ? { fontFamily: theme.bodyFont } : {}),
    ...(tpl
      ? tplBgSrc
        ? { backgroundImage: `url("${tplBgSrc}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : {}
      : bgSrc
        ? { backgroundImage: `url("${bgSrc}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : {}),
  }

  const boxRef = useRef<HTMLDivElement | null>(null)
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(null)
  const [dragPos, setDragPos] = useState<{ key: string; pos: BlockPosition } | null>(null)
  const dragRef = useRef<DragSession | null>(null)

  const mergedPositions: Record<string, BlockPosition> = {
    ...(slide.positions ?? {}),
    ...(dragPos ? { [dragPos.key]: dragPos.pos } : {}),
  }

  const onDragStart = useCallback((key: string, event: ReactPointerEvent) => {
    if ((event.button ?? 0) !== 0) return
    const box = boxRef.current
    if (!box) return
    const boxRect = box.getBoundingClientRect()
    if (boxRect.width <= 0 || boxRect.height <= 0) return
    // Measure the block's current on-screen rect: the positioned overlay
    // div itself, or (in layout flow, where the Block wrapper is
    // display:contents and has no box) its first rendered descendant.
    const target = event.currentTarget as HTMLElement
    let rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      const inner = target.firstElementChild as HTMLElement | null
      if (inner) rect = inner.getBoundingClientRect()
    }
    if (rect.width <= 0 || rect.height <= 0) return
    const origin: BlockPosition = {
      x: (rect.left - boxRect.left) / boxRect.width,
      y: (rect.top - boxRect.top) / boxRect.height,
      w: rect.width / boxRect.width,
      h: rect.height / boxRect.height,
    }
    dragRef.current = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      boxW: boxRect.width,
      boxH: boxRect.height,
      origin,
      last: origin,
      moved: false,
    }
    // No setDragPos here: the positioned overlay render starts on the
    // first actual pointer move (see the move handler). Remounting the
    // block mid-gesture on pointerdown would unmount whatever the user
    // pressed and eat its click — e.g. the image-upload button inside a
    // placeholder, which must distinguish click from drag.
    event.preventDefault()
  }, [])

  useEffect(() => {
    if (!editable) return
    const move = (event: PointerEvent): void => {
      const session = dragRef.current
      if (!session) return
      if (Math.abs(event.clientX - session.startX) + Math.abs(event.clientY - session.startY) > 2) session.moved = true
      const w = session.origin.w ?? 0
      const h = session.origin.h ?? 0
      const pos: BlockPosition = {
        x: Math.min(Math.max(0, session.origin.x + (event.clientX - session.startX) / session.boxW), Math.max(0, 1 - w)),
        y: Math.min(Math.max(0, session.origin.y + (event.clientY - session.startY) / session.boxH), Math.max(0, 1 - h)),
        w: session.origin.w,
        h: session.origin.h,
      }
      session.last = pos
      setDragPos({ key: session.key, pos })
    }
    const up = (): void => {
      const session = dragRef.current
      dragRef.current = null
      setDragPos(null)
      if (session && session.moved && onPositionsChange) {
        onPositionsChange(slide.id, { ...(slide.positions ?? {}), [session.key]: session.last })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [editable, onPositionsChange, slide.id, slide.positions])

  return (
    <div ref={boxRef} data-testid="slide-renderer" data-layout={slide.layout} className="relative flex h-full w-full flex-col overflow-hidden" style={rootStyle}>
      <BlockCtx.Provider value={{ positions: mergedPositions, editable, overlayEl, onDragStart, imageSrc: resolveImageSrc, onImagePick }}>
        {tpl ? (
          <TemplateSlots slide={slide} page={tpl.page} assetSrc={tpl.assetSrc} editable={editable} onImagePick={onImagePick} imageSrc={resolveImageSrc} ctx={ctx} />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col" style={{ padding: tpl ? 0 : '3cqw' }}>
          {tpl ? null : slide.templateRef ? <TemplateFallbackBody slide={slide} ctx={ctx} /> : renderBody(slide, ctx)}
        </div>
        <div ref={setOverlayEl} data-testid="slide-overlay" className="pointer-events-none absolute inset-0" style={{ zIndex: 4 }} />
      </BlockCtx.Provider>
      <div className="relative flex items-center justify-between" style={{ gap: '1cqw', padding: '0 1.6cqw 1.1cqw', fontSize: '1cqw', color: ctx.muted, zIndex: 3 }}>
        <span>{getLayout(slide.layout)?.label ?? slide.layout}</span>
        {slide.notes ? <span className="truncate italic">{slide.notes}</span> : <span className="truncate">{slide.id}</span>}
      </div>
    </div>
  )
}
