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
}

const SERIES_VARS = [
  'var(--daedalus-success)',
  'var(--daedalus-info)',
  'var(--daedalus-secondary)',
  'var(--daedalus-warning)',
  'var(--daedalus-primary)',
]

function seriesColor(index: number, accent: string): string {
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
      const image = str(c.image)
      const isRemote = /^(https?:|data:)/i.test(image)
      const imageBox = (
        <div
          className="flex shrink-0 flex-col items-center justify-center overflow-hidden rounded-md border text-center"
          style={{ width: '36%', borderColor: ctx.line, backgroundColor: ctx.panelBg, gap: '0.8cqw', padding: '1cqw' }}
        >
          {isRemote ? (
            <img src={image} alt={str(c.alt)} className="h-full w-full rounded object-cover" />
          ) : (
            <>
              <ImageIcon aria-hidden style={{ width: '4cqw', height: '4cqw', color: ctx.accent }} />
              <div className="break-all font-semibold" style={{ fontSize: '1.2cqw' }}>
                {image || 'image'}
              </div>
              {str(c.alt) ? <div style={{ fontSize: '1.05cqw', color: ctx.muted }}>{str(c.alt)}</div> : null}
            </>
          )}
        </div>
      )
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
                  <rect x={x} y={y} width={barW} height={barH} rx="5" style={{ fill: seriesColor(index, ctx.accent) }} />
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
                  style={{ stroke: seriesColor(si, ctx.accent) }}
                />
                {s.points.map((p, i) => (
                  <circle key={i} cx={xAt(i, s.points.length)} cy={yAt(p)} r="4.5" style={{ fill: seriesColor(si, ctx.accent) }} />
                ))}
              </g>
            ))}
          </svg>
          </Block>
          <Block blockKey="legend">
            <div className="flex flex-wrap" style={{ gap: '1.6cqw' }}>
              {series.map((s, si) => (
                <span key={si} className="inline-flex items-center" style={{ gap: '0.5cqw', fontSize: '1.2cqw' }}>
                  <span aria-hidden style={{ width: '1.4cqw', height: '0.45cqw', borderRadius: 999, backgroundColor: seriesColor(si, ctx.accent) }} />
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
                      style={{ stroke: seriesColor(index, ctx.accent) }}
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
                    <span aria-hidden className="rounded-sm" style={{ width: '1.3cqw', height: '1.3cqw', backgroundColor: seriesColor(index, ctx.accent) }} />
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
                        backgroundColor: seriesColor(index, ctx.accent),
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
                      backgroundColor: seriesColor(index, ctx.accent),
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
                      style={{ width: '2.2cqw', height: '2.2cqw', backgroundColor: seriesColor(index, ctx.accent), color: 'var(--daedalus-onPrimary)', fontSize: '1.15cqw' }}
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
                    style={{ width: '4.4cqw', height: '4.4cqw', backgroundColor: seriesColor(index, ctx.accent), color: 'var(--daedalus-onPrimary)', fontSize: '1.7cqw' }}
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
              const image = str(tile.image)
              const isRemote = /^(https?:|data:)/i.test(image)
              const cellStyle: CSSProperties =
                index === 0 ? { gridRow: '1 / span 2' } : index === 1 ? { gridColumn: '2 / span 2' } : {}
              return (
                <Block key={index} blockKey={`tile-${index}`}>
                  <div
                    className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-md border text-center"
                    style={{ ...cellStyle, borderColor: ctx.line, backgroundColor: ctx.panelBg, gap: '0.7cqw', padding: '1cqw' }}
                  >
                    {isRemote ? (
                      <img src={image} alt={str(tile.alt)} className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <>
                        <ImageIcon aria-hidden style={{ width: '3.4cqw', height: '3.4cqw', color: ctx.accent }} />
                        <div className="break-all font-semibold" style={{ fontSize: '1.1cqw' }}>
                          {image || 'image'}
                        </div>
                        {str(tile.alt) ? <div style={{ fontSize: '1cqw', color: ctx.muted }}>{str(tile.alt)}</div> : null}
                        {str(tile.caption) ? (
                          <div className="font-medium" style={{ fontSize: '1.05cqw', color: ctx.accent }}>
                            {str(tile.caption)}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
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

export function SlideRenderer({ slide, theme, editable = false, onPositionsChange }: {
  slide: Slide
  theme?: DeckSpec['theme']
  /** Edit mode: blocks become grabbable; drags persist via onPositionsChange. */
  editable?: boolean
  onPositionsChange?: (slideId: string, positions: Record<string, BlockPosition>) => void
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
  }
  const rootStyle: CSSProperties = {
    backgroundColor: theme?.background ?? (isLight ? light.bgSurface : 'var(--daedalus-bgBase)'),
    color: theme?.text ?? (isLight ? light.fgBase : 'var(--daedalus-fgBase)'),
    ...(theme?.bodyFont ? { fontFamily: theme.bodyFont } : {}),
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
    setDragPos({ key, pos: origin })
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
      <BlockCtx.Provider value={{ positions: mergedPositions, editable, overlayEl, onDragStart }}>
        <div className="flex min-h-0 flex-1 flex-col" style={{ padding: '3cqw' }}>
          {renderBody(slide, ctx)}
        </div>
        <div ref={setOverlayEl} data-testid="slide-overlay" className="pointer-events-none absolute inset-0" style={{ zIndex: 4 }} />
      </BlockCtx.Provider>
      <div className="flex items-center justify-between" style={{ gap: '1cqw', padding: '0 1.6cqw 1.1cqw', fontSize: '1cqw', color: ctx.muted }}>
        <span>{getLayout(slide.layout)?.label ?? slide.layout}</span>
        {slide.notes ? <span className="truncate italic">{slide.notes}</span> : <span className="truncate">{slide.id}</span>}
      </div>
    </div>
  )
}
