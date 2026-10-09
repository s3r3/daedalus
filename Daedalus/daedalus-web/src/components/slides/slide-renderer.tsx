import type { CSSProperties, ReactNode } from 'react'
import * as lucideIcons from 'lucide-react'
import { Image as ImageIcon, Quote as QuoteIcon, Sparkles } from 'lucide-react'
import type { DeckSpec, Slide } from '@daedalus/core'
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
          <div className="font-bold tracking-tight" style={{ fontSize: '6.6cqw', lineHeight: 1.05 }}>
            {str(c.title) || 'Untitled presentation'}
          </div>
          {str(c.subtitle) ? (
            <div style={{ fontSize: '2.3cqw', color: ctx.muted, lineHeight: 1.35 }}>{str(c.subtitle)}</div>
          ) : null}
        </div>
      )
    }
    case 'section': {
      return (
        <div className="relative flex flex-1 flex-col justify-center" style={{ gap: '1.4cqw' }}>
          <div
            aria-hidden
            className="absolute font-bold"
            style={{ right: 0, top: '-2cqw', fontSize: '15cqw', lineHeight: 1, color: ctx.accent, opacity: 0.14 }}
          >
            {str(c.number)}
          </div>
          <div style={{ fontSize: '1.6cqw', letterSpacing: '0.25em', textTransform: 'uppercase', color: ctx.accent }}>
            {str(c.number) ? `Bagian ${str(c.number)}` : 'Bagian'}
          </div>
          <div className="font-bold tracking-tight" style={{ fontSize: '5cqw', lineHeight: 1.1 }}>
            {str(c.title)}
          </div>
          <AccentBar accent={ctx.accent} />
        </div>
      )
    }
    case 'closing': {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.8cqw' }}>
          <AccentBar accent={ctx.accent} width="9cqw" />
          <div className="font-bold tracking-tight" style={{ fontSize: '5.6cqw', lineHeight: 1.1 }}>
            {str(c.title)}
          </div>
          {str(c.cta) ? (
            <span
              className="rounded-full border font-semibold"
              style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.7cqw', padding: '0.7cqw 2cqw' }}
            >
              {str(c.cta)}
            </span>
          ) : null}
        </div>
      )
    }
    case 'quote': {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: '1.6cqw', padding: '0 4cqw' }}>
          <QuoteIcon aria-hidden style={{ width: '4cqw', height: '4cqw', color: ctx.accent }} />
          <div style={{ fontSize: '3.4cqw', lineHeight: 1.3, fontStyle: 'italic' }}>{str(c.text)}</div>
          {str(c.author) ? <div style={{ fontSize: '1.6cqw', color: ctx.muted }}>— {str(c.author)}</div> : null}
        </div>
      )
    }
    case 'bullets': {
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.8cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <AccentBar accent={ctx.accent} width="5cqw" />
          <Points items={strList(c.points)} ctx={ctx} />
        </div>
      )
    }
    case 'two-column': {
      const left = obj(c.left)
      const right = obj(c.right)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.6cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.6cqw' }}>
            <ColumnPanel heading={str(left.heading)} points={strList(left.points)} ctx={ctx} />
            <ColumnPanel heading={str(right.heading)} points={strList(right.points)} ctx={ctx} />
          </div>
        </div>
      )
    }
    case 'comparison': {
      const left = obj(c.left)
      const right = obj(c.right)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.4cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="flex min-h-0 flex-1" style={{ gap: '1.6cqw' }}>
            <ColumnPanel heading={str(left.title)} points={strList(left.points)} ctx={ctx} />
            <ColumnPanel heading={str(right.title)} points={strList(right.points)} ctx={ctx} />
          </div>
          {str(c.verdict) ? (
            <div
              className="rounded-md border text-center font-semibold"
              style={{ borderColor: ctx.accent, color: ctx.accent, fontSize: '1.5cqw', padding: '0.9cqw' }}
            >
              {str(c.verdict)}
            </div>
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
          <SlideTitle>{str(c.title)}</SlideTitle>
          <Points items={strList(c.points)} ctx={ctx} size="1.4cqw" />
        </div>
      )
      return (
        <div className="flex min-h-0 flex-1" style={{ gap: '2cqw' }}>
          {c.side === 'left' ? (
            <>
              {imageBox}
              {textCol}
            </>
          ) : (
            <>
              {textCol}
              {imageBox}
            </>
          )}
        </div>
      )
    }
    case 'diagram-flow': {
      const steps = objList(c.steps)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.8cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="flex flex-1 items-stretch" style={{ gap: '0.6cqw' }}>
            {steps.map((step, index) => (
              <div key={index} className="flex min-w-0 flex-1 items-stretch" style={{ gap: '0.6cqw' }}>
                <div
                  className="flex min-w-0 flex-1 flex-col justify-center rounded-md border"
                  style={{ gap: '0.6cqw', padding: '1.2cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <div className="font-semibold" style={{ fontSize: '1.55cqw', color: ctx.accent }}>
                    {index + 1}. {str(step.title)}
                  </div>
                  {str(step.desc) ? <div style={{ fontSize: '1.15cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(step.desc)}</div> : null}
                </div>
                {index < steps.length - 1 ? (
                  <span aria-hidden className="flex items-center font-bold" style={{ fontSize: '2.4cqw', color: ctx.accent }}>
                    ›
                  </span>
                ) : null}
              </div>
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
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="relative flex-1" style={{ margin: '0 6cqw' }}>
            <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 400 220">
              <circle cx="200" cy="110" r="82" fill="none" strokeDasharray="7 9" strokeWidth="2.5" style={{ stroke: ctx.accent }} />
              <polygon points="200,18 192,34 208,34" style={{ fill: ctx.accent }} />
              <polygon points="292,110 276,102 276,118" style={{ fill: ctx.accent }} />
              <polygon points="200,202 208,186 192,186" style={{ fill: ctx.accent }} />
              <polygon points="108,110 124,118 124,102" style={{ fill: ctx.accent }} />
            </svg>
            {nodes.map((node, index) => (
              <div
                key={index}
                className="absolute rounded-full border text-center font-semibold"
                style={{
                  ...positions[index],
                  borderColor: ctx.accent,
                  backgroundColor: ctx.panelBg,
                  fontSize: '1.35cqw',
                  padding: '0.8cqw 1.4cqw',
                  maxWidth: '34%',
                }}
              >
                {node}
              </div>
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
            <SlideTitle>{str(c.title)}</SlideTitle>
          </div>
          <div
            className="rounded-md border text-center font-bold"
            style={{ borderColor: ctx.accent, backgroundColor: ctx.panelBg, fontSize: '1.7cqw', padding: '0.9cqw 2.2cqw', marginTop: '1.4cqw' }}
          >
            {str(c.root)}
          </div>
          <div style={{ width: 2, height: '1.6cqw', backgroundColor: ctx.line }} />
          <div style={{ height: 2, width: `${Math.max(0, (groups.length - 1) * 24)}%`, backgroundColor: ctx.line }} />
          <div className="flex w-full" style={{ gap: '1.4cqw' }}>
            {groups.map((group, index) => (
              <div key={index} className="flex min-w-0 flex-1 flex-col items-center">
                <div style={{ width: 2, height: '1.2cqw', backgroundColor: ctx.line }} />
                <div
                  className="flex w-full flex-col rounded-md border"
                  style={{ gap: '0.7cqw', padding: '1.1cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <div className="font-semibold" style={{ fontSize: '1.45cqw', color: ctx.accent }}>
                    {str(group.label)}
                  </div>
                  <Points items={strList(group.items)} ctx={ctx} size="1.15cqw" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case 'timeline': {
      const events = objList(c.events)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '2cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="relative flex flex-1 items-start" style={{ paddingTop: '0.4cqw' }}>
            <div aria-hidden className="absolute" style={{ left: 0, right: 0, top: '1.05cqw', height: 2, backgroundColor: ctx.accent, opacity: 0.45 }} />
            {events.map((event, index) => (
              <div key={index} className="relative flex min-w-0 flex-1 flex-col" style={{ gap: '0.55cqw', paddingRight: '1cqw' }}>
                <span className="rounded-full" style={{ width: '1.5cqw', height: '1.5cqw', backgroundColor: ctx.accent }} />
                <div className="font-bold" style={{ fontSize: '1.35cqw', color: ctx.accent }}>
                  {str(event.when)}
                </div>
                <div className="font-semibold" style={{ fontSize: '1.45cqw', lineHeight: 1.3 }}>
                  {str(event.title)}
                </div>
                {str(event.desc) ? <div style={{ fontSize: '1.12cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(event.desc)}</div> : null}
              </div>
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
        <div className="flex flex-1 flex-col" style={{ gap: '1.2cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" role="img" aria-label={str(c.title)}>
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
        <div className="flex flex-1 flex-col" style={{ gap: '1cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" role="img" aria-label={str(c.title)}>
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
          <div className="flex flex-wrap" style={{ gap: '1.6cqw' }}>
            {series.map((s, si) => (
              <span key={si} className="inline-flex items-center" style={{ gap: '0.5cqw', fontSize: '1.2cqw' }}>
                <span aria-hidden style={{ width: '1.4cqw', height: '0.45cqw', borderRadius: 999, backgroundColor: seriesColor(si, ctx.accent) }} />
                {s.name}
                {str(c.unit) ? <span style={{ color: ctx.muted }}>({str(c.unit)})</span> : null}
              </span>
            ))}
          </div>
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
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="flex flex-1 items-center" style={{ gap: '3cqw' }}>
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
          </div>
        </div>
      )
    }
    case 'table': {
      const columns = strList(c.columns)
      const rows = Array.isArray(c.rows) ? c.rows.map((row) => (Array.isArray(row) ? row.map((cell) => str(cell)) : [])) : []
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.5cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
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
        </div>
      )
    }
    case 'stats': {
      const stats = objList(c.stats)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '2cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="grid flex-1 items-center" style={{ gridTemplateColumns: `repeat(${Math.max(1, stats.length)}, minmax(0, 1fr))`, gap: '1.6cqw' }}>
            {stats.map((stat, index) => (
              <div key={index} className="flex flex-col items-center text-center" style={{ gap: '0.6cqw' }}>
                <div className="font-bold" style={{ fontSize: '5.2cqw', color: ctx.accent, lineHeight: 1 }}>
                  {str(stat.value)}
                </div>
                <div className="uppercase" style={{ fontSize: '1.25cqw', letterSpacing: '0.14em', color: ctx.muted }}>
                  {str(stat.label)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case 'icon-grid': {
      const items = objList(c.items)
      return (
        <div className="flex flex-1 flex-col" style={{ gap: '1.7cqw' }}>
          <SlideTitle>{str(c.title)}</SlideTitle>
          <div className="grid flex-1" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '1.4cqw' }}>
            {items.map((item, index) => {
              const Icon = iconFor(str(item.icon))
              return (
                <div
                  key={index}
                  className="flex flex-col rounded-md border"
                  style={{ gap: '0.7cqw', padding: '1.4cqw', borderColor: ctx.line, backgroundColor: ctx.panelBg }}
                >
                  <Icon aria-hidden style={{ width: '3cqw', height: '3cqw', color: ctx.accent }} />
                  <div className="font-semibold" style={{ fontSize: '1.55cqw' }}>
                    {str(item.title)}
                  </div>
                  {str(item.desc) ? <div style={{ fontSize: '1.15cqw', color: ctx.muted, lineHeight: 1.4 }}>{str(item.desc)}</div> : null}
                </div>
              )
            })}
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

export function SlideRenderer({ slide, theme }: { slide: Slide; theme?: DeckSpec['theme'] }) {
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

  return (
    <div data-testid="slide-renderer" data-layout={slide.layout} className="relative flex h-full w-full flex-col overflow-hidden" style={rootStyle}>
      <div className="flex min-h-0 flex-1 flex-col" style={{ padding: '3cqw' }}>
        {renderBody(slide, ctx)}
      </div>
      <div className="flex items-center justify-between" style={{ gap: '1cqw', padding: '0 1.6cqw 1.1cqw', fontSize: '1cqw', color: ctx.muted }}>
        <span>{getLayout(slide.layout)?.label ?? slide.layout}</span>
        {slide.notes ? <span className="truncate italic">{slide.notes}</span> : <span className="truncate">{slide.id}</span>}
      </div>
    </div>
  )
}
