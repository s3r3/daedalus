import { useEffect, useMemo, useState } from 'react'
import { ArrowDownAZ, Download, Plus } from 'lucide-react'
import type { SheetSpec, WorkbookSpec } from '@daedalus/core'
import { displayValue, evaluateWorkbook, type WorkbookEvaluation } from '@daedalus/core/sheets/evaluator'
import { formatCellRef, indexToCol, parseCellRef } from '@daedalus/core/sheets/refs'
import { tileRefs } from '@daedalus/core/sheets/workbook'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useWorkbook } from './useWorkbook'
import { cn } from '../../lib/utils'

const MAX_GRID_ROWS = 200
const MAX_GRID_COLS = 26

/**
 * Kanvas Grid: the center canvas of Agentic Spreadsheet. Sheet tabs, a
 * formula bar, and direct cell editing over workbook.json — formula
 * cells display the core evaluator's computed value (never a frozen
 * copy the user could mistake for the formula), and every commit goes
 * through the server's validated workbook save, so an invalid edit is
 * refused instead of landing. The exported .xlsx is the artifact;
 * this grid is the working surface, not a pixel-perfect Excel render.
 */
export function SheetStage() {
  const { workbook, loading, error, refresh, root } = useWorkbook()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [activeSheet, setActiveSheet] = useState(0)
  const [selected, setSelected] = useState<{ col: number; row: number }>({ col: 0, row: 0 })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dashView, setDashView] = useState<'canvas' | 'grid'>('canvas')

  const sheet = workbook?.sheets[Math.min(activeSheet, Math.max(0, (workbook?.sheets.length ?? 1) - 1))]
  const evaluation = useMemo(() => (workbook ? evaluateWorkbook(workbook) : null), [workbook])

  const selectedRef = formatCellRef(selected.col, selected.row)
  const selectedCell = sheet?.cells[selectedRef]

  useEffect(() => {
    setDraft(selectedCell?.f ?? (selectedCell?.v === undefined ? '' : String(selectedCell.v)))
  }, [selectedRef, sheet?.name, workbook])

  if (!workbook) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="sheet-stage-empty">
        <p className="text-sm font-semibold text-foreground">Belum ada workbook</p>
        <p className="max-w-md text-[11px] text-muted">
          {loading
            ? 'Memuat workbook…'
            : error
              ? `Gagal membaca workbook: ${error}`
              : 'Minta spreadsheet di chat — blueprint-nya di-stage di Panel Blueprint, lalu tekan Buat. Atau buka file .xlsx/.csv dari panel Workspace di kiri.'}
        </p>
      </div>
    )
  }

  const bounds = (() => {
    let maxRow = 8
    let maxCol = 6
    if (sheet) {
      for (const ref of Object.keys(sheet.cells)) {
        const parsed = parseCellRef(ref)
        if (!parsed) continue
        maxRow = Math.max(maxRow, parsed.row + 1)
        maxCol = Math.max(maxCol, parsed.col + 1)
      }
    }
    return { rows: Math.min(maxRow + 1, MAX_GRID_ROWS), cols: Math.min(maxCol + 1, MAX_GRID_COLS), truncated: maxRow + 1 > MAX_GRID_ROWS || maxCol + 1 > MAX_GRID_COLS }
  })()

  const commit = async (raw: string): Promise<void> => {
    if (!root || !workbook || !sheet || busy) return
    const next: WorkbookSpec = JSON.parse(JSON.stringify(workbook)) as WorkbookSpec
    const target = next.sheets.find((s) => s.id === sheet.id)
    if (!target) return
    const text = raw.trim()
    const existing = target.cells[selectedRef]
    const keepFmt = existing?.fmt ? { fmt: existing.fmt } : {}
    if (text === '') {
      delete target.cells[selectedRef]
    } else if (text.startsWith('=')) {
      target.cells[selectedRef] = { ...keepFmt, f: text }
    } else {
      // Numbers (incl. id-ID "1.234,5" and trailing %) become numbers;
      // everything else stays the literal string the user typed.
      let numeric: number | null = null
      if (/^-?[0-9][0-9.,]*%?$/.test(text)) {
        const pct = text.endsWith('%')
        const body = pct ? text.slice(0, -1) : text
        const normalized = /,/.test(body) && /\./.test(body) && body.lastIndexOf(',') > body.lastIndexOf('.')
          ? body.replace(/\./g, '').replace(',', '.')
          : body.replace(/,/g, '')
        const parsed = Number(normalized)
        if (Number.isFinite(parsed)) numeric = pct ? parsed / 100 : parsed
      }
      if (numeric !== null) {
        target.cells[selectedRef] = { ...keepFmt, v: numeric, ...(text.endsWith('%') && !existing?.fmt ? { fmt: '0.0%' } : {}) }
      } else {
        target.cells[selectedRef] = { ...keepFmt, v: text }
      }
    }
    setBusy(true)
    setActionError(null)
    try {
      await api.workbookSave(root, next)
      setNote(`${selectedRef} tersimpan — ekspor ulang untuk memperbarui file .xlsx.`)
      refresh()
      bumpWorkspaceRevision()
    } catch (saveError: unknown) {
      setActionError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const addRowOrCol = async (kind: 'row' | 'col'): Promise<void> => {
    if (!root || !workbook || !sheet || busy) return
    const next: WorkbookSpec = JSON.parse(JSON.stringify(workbook)) as WorkbookSpec
    const target = next.sheets.find((s) => s.id === sheet.id)
    if (!target) return
    if (kind === 'row') {
      target.cells[formatCellRef(0, bounds.rows - 1)] = { v: '' }
    } else {
      target.cells[formatCellRef(bounds.cols - 1, 0)] = { v: '' }
    }
    setBusy(true)
    try {
      await api.workbookSave(root, next)
      refresh()
      bumpWorkspaceRevision()
    } catch (saveError: unknown) {
      setActionError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const sortBySelectedColumn = async (): Promise<void> => {
    if (!root || !workbook || !sheet || busy) return
    const next: WorkbookSpec = JSON.parse(JSON.stringify(workbook)) as WorkbookSpec
    const target = next.sheets.find((s) => s.id === sheet.id)
    if (!target) return
    const byCol = selected.col
    const rowCount = bounds.rows
    const rowCells: Array<Map<number, (typeof target.cells)[string]>> = []
    for (let r = 1; r < rowCount; r += 1) {
      const cells = new Map<number, (typeof target.cells)[string]>()
      for (let c = 0; c < bounds.cols; c += 1) {
        const cell = target.cells[formatCellRef(c, r)]
        if (cell) cells.set(c, cell)
      }
      if (cells.size > 0) rowCells.push(cells)
    }
    const keyOf = (cells: Map<number, (typeof target.cells)[string]>): string => {
      const cell = cells.get(byCol)
      if (!cell) return ''
      return cell.f ?? (cell.v === undefined ? '' : String(cell.v))
    }
    rowCells.sort((a, b) => keyOf(a).localeCompare(keyOf(b), undefined, { numeric: true }))
    for (let r = 1; r < rowCount; r += 1) {
      for (let c = 0; c < bounds.cols; c += 1) delete target.cells[formatCellRef(c, r)]
    }
    rowCells.forEach((cells, i) => {
      for (const [c, cell] of cells) target.cells[formatCellRef(c, i + 1)] = cell
    })
    setBusy(true)
    try {
      await api.workbookSave(root, next)
      setNote(`Sheet ${target.name} diurutkan menurut kolom ${indexToCol(byCol)}. Formula ikut berpindah apa adanya — jalankan audit/verify lewat chat untuk memastikan referensi tetap benar.`)
      refresh()
      bumpWorkspaceRevision()
    } catch (saveError: unknown) {
      setActionError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (format: 'xlsx' | 'csv'): Promise<void> => {
    if (!root || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await api.workbookExport(root, format === 'csv' ? { format, sheet: sheet?.name } : { format })
      const first = result.records[0]
      setNote(first ? `Ekspor: workbook/${first.path.split('/').pop()} (${first.via}${first.note ? ` — ${first.note}` : ''})` : 'Ekspor selesai.')
      refresh()
      bumpWorkspaceRevision()
    } catch (exportError: unknown) {
      setActionError(exportError instanceof Error ? exportError.message : String(exportError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sheet-stage">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <p className="text-xs font-semibold text-foreground" data-testid="sheet-stage-title">{workbook.title}</p>
        <span className="rounded border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
          {workbook.stage === 'blueprint' ? 'blueprint ter-stage' : 'siap'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => void doExport('xlsx')} disabled={busy} data-testid="sheet-export-xlsx">
            <Download className="size-3.5" aria-hidden /> Ekspor XLSX
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void doExport('csv')} disabled={busy} data-testid="sheet-export-csv">
            <Download className="size-3.5" aria-hidden /> Ekspor CSV
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void addRowOrCol('row')} disabled={busy} data-testid="sheet-add-row">
            <Plus className="size-3.5" aria-hidden /> Baris
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void addRowOrCol('col')} disabled={busy} data-testid="sheet-add-col">
            <Plus className="size-3.5" aria-hidden /> Kolom
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void sortBySelectedColumn()} disabled={busy} data-testid="sheet-sort">
            <ArrowDownAZ className="size-3.5" aria-hidden /> Urutkan
          </Button>
        </span>
      </div>

      <div className="flex items-end gap-1 overflow-x-auto border-b border-line px-2 pt-1" role="tablist" aria-label="sheet tabs">
        {workbook.sheets.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={index === Math.min(activeSheet, workbook.sheets.length - 1)}
            data-testid={`sheet-tab-${candidate.name}`}
            onClick={() => {
              setActiveSheet(index)
              setSelected({ col: 0, row: 0 })
            }}
            className={cn(
              'rounded-t border border-b-0 px-2.5 py-1 text-[11px] font-medium',
              index === Math.min(activeSheet, workbook.sheets.length - 1)
                ? 'border-line bg-surface text-foreground'
                : 'border-transparent text-muted hover:text-foreground',
            )}
            style={candidate.tabColor ? { borderTopColor: candidate.tabColor, borderTopWidth: 2 } : undefined}
          >
            {candidate.name}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5" data-testid="sheet-formula-bar">
        <span className="min-w-10 rounded border border-line bg-surface-base px-1.5 py-0.5 text-center font-mono text-[11px] text-foreground" data-testid="sheet-selected-ref">
          {selectedRef}
        </span>
        <span className="font-mono text-[11px] text-muted">fx</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit(draft)
          }}
          onBlur={() => {
            if (sheet && draft !== (selectedCell?.f ?? (selectedCell?.v === undefined ? '' : String(selectedCell.v)))) void commit(draft)
          }}
          placeholder={selectedCell?.f ? 'formula…' : 'nilai atau =formula…'}
          data-testid="sheet-formula-input"
          className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-base px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
        {selectedCell?.f ? <span className="text-[10px] text-emerald-300">formula live</span> : null}
      </div>

      {note ? <p className="border-b border-line bg-emerald-500/10 px-3 py-1 text-[10px] text-emerald-200" data-testid="sheet-stage-note">{note}</p> : null}
      {actionError ? <p className="border-b border-line bg-red-500/10 px-3 py-1 text-[10px] text-red-200" data-testid="sheet-stage-error">Ditolak: {actionError}</p> : null}

      {sheet?.kind === 'dashboard' ? (
        <div className="flex items-center gap-1 border-b border-line px-3 py-1" data-testid="sheet-dash-toggle">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-muted">Dashboard</span>
          <button
            type="button"
            data-testid="sheet-dash-view-canvas"
            aria-pressed={dashView === 'canvas'}
            onClick={() => setDashView('canvas')}
            className={cn('rounded border px-2 py-0.5 text-[10px]', dashView === 'canvas' ? 'border-primary text-foreground' : 'border-line text-muted')}
          >
            Kanvas
          </button>
          <button
            type="button"
            data-testid="sheet-dash-view-grid"
            aria-pressed={dashView === 'grid'}
            onClick={() => setDashView('grid')}
            className={cn('rounded border px-2 py-0.5 text-[10px]', dashView === 'grid' ? 'border-primary text-foreground' : 'border-line text-muted')}
          >
            Grid sel
          </button>
        </div>
      ) : null}

      {sheet?.kind === 'dashboard' && dashView === 'canvas' && evaluation ? (
        <DashboardCanvas workbook={workbook} sheet={sheet} evaluation={evaluation} />
      ) : (
      <div className="min-h-0 flex-1 overflow-auto" data-testid="sheet-grid-scroll">
        <table className="border-collapse text-[11px]" data-testid="sheet-grid">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-10 border border-line bg-surface px-1.5 py-1 text-muted" />
              {Array.from({ length: bounds.cols }, (_, c) => (
                <th key={c} className="sticky top-0 z-[5] min-w-24 border border-line bg-surface px-1.5 py-1 font-medium text-muted">
                  {indexToCol(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: bounds.rows }, (_, r) => (
              <tr key={r}>
                <th className="sticky left-0 border border-line bg-surface px-1.5 py-1 font-medium text-muted">{r + 1}</th>
                {Array.from({ length: bounds.cols }, (_, c) => {
                  const ref = formatCellRef(c, r)
                  const cell = sheet?.cells[ref]
                  const isSelected = selected.col === c && selected.row === r
                  const text = sheet && evaluation ? displayValue(workbook, evaluation, sheet, ref) : ''
                  return (
                    <td
                      key={ref}
                      data-testid={`sheet-cell-${ref}`}
                      data-ref={ref}
                      onClick={() => setSelected({ col: c, row: r })}
                      onDoubleClick={() => {
                        setSelected({ col: c, row: r })
                        document.querySelector<HTMLInputElement>('[data-testid="sheet-formula-input"]')?.focus()
                      }}
                      className={cn(
                        'cursor-cell whitespace-nowrap border border-line px-1.5 py-1',
                        typeof cell?.v === 'number' || cell?.f ? 'text-right font-mono' : '',
                        cell?.f ? 'text-emerald-200' : 'text-foreground',
                        cell?.bold ? 'font-bold' : '',
                        isSelected ? 'bg-primary/20 outline outline-2 outline-primary' : 'hover:bg-surface',
                      )}
                      style={cell?.fill ? { backgroundColor: cell.fill } : undefined}
                    >
                      {cell?.f ? <span className="mr-0.5 text-[9px] text-emerald-400">ƒ</span> : null}
                      {text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {bounds.truncated ? (
          <p className="px-3 py-2 text-[10px] text-muted">Grid menampilkan sebagian ({MAX_GRID_ROWS}×{MAX_GRID_COLS}) — file lengkapnya ada di workbook/workbook.json dan ekspor.</p>
        ) : null}
      </div>
      )}
    </div>
  )
}

/**
 * The dashboard sheet as a readable canvas: KPI tiles with values
 * computed live by the core evaluator, chart and slicer placements as
 * honest placeholders. A browser canvas cannot draw Excel's native
 * charts — the rendered chart lives in the exported .xlsx (injected
 * by the Go sidecar); here the placeholder names exactly that, the
 * same honesty rule as Slide's editable canvas vs Pratinjau Asli.
 */
function DashboardCanvas({ workbook, sheet, evaluation }: { workbook: WorkbookSpec; sheet: SheetSpec; evaluation: WorkbookEvaluation }) {
  const tiles = [...(sheet.tiles ?? [])].sort((a, b) => {
    const ra = parseCellRef(a.anchor)
    const rb = parseCellRef(b.anchor)
    if (!ra || !rb) return 0
    return ra.row - rb.row || ra.col - rb.col
  })
  const charts = workbook.sheets.flatMap((owner) => (owner.charts ?? []).filter((c) => (c.sheet ?? owner.name) === sheet.name))
  const slicers = sheet.slicers ?? []
  const pivots = sheet.pivots ?? []
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="sheet-dash-canvas">
      {tiles.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="sheet-dash-tiles">
          {tiles.map((tile) => {
            const refs = tileRefs(tile)
            const value = refs ? displayValue(workbook, evaluation, sheet, refs.valueRef) : '—'
            return (
              <div key={tile.id} className="w-52 overflow-hidden rounded border border-line bg-surface" data-testid={`sheet-tile-${tile.id}`}>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ backgroundColor: tile.accent ?? 'var(--color-primary)' }}>
                  {tile.label}
                </p>
                <p className="px-2 pt-1.5 text-base font-bold text-foreground" data-testid={`sheet-tile-value-${tile.id}`}>{value}</p>
                <p className="truncate px-2 pb-1.5 font-mono text-[9px] text-emerald-300/80">{tile.formula}</p>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted">Belum ada kartu KPI di dashboard ini — minta lewat chat, mis. “tambah KPI total pendapatan”.</p>
      )}

      {charts.length > 0 ? (
        <div className="mt-3" data-testid="sheet-dash-charts">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Chart native ({charts.length})</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {charts.map((chart) => (
              <div key={chart.id} className="flex h-28 flex-col justify-between rounded border border-dashed border-line bg-surface-base p-2" style={{ width: Math.min(chart.width ?? 460, 560) }} data-testid={`sheet-chart-${chart.id}`}>
                <p className="text-[11px] font-medium text-foreground">{chart.title ?? `Chart ${chart.type}`}</p>
                <p className="font-mono text-[9px] text-muted">{chart.type} · {chart.range} @ {chart.anchor}</p>
                <p className="text-[9px] text-muted">Dirender sebagai chart native di file .xlsx hasil ekspor — kanvas ini placeholder, bukan grafik.</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {slicers.length > 0 ? (
        <div className="mt-3" data-testid="sheet-dash-slicers">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Slicer ({slicers.length})</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {slicers.map((slicer) => (
              <span key={slicer.id} className="rounded border border-line bg-surface px-2 py-1 text-[10px] text-foreground" data-testid={`sheet-slicer-${slicer.id}`}>
                {slicer.field}
                <span className="ml-1 text-muted">{slicer.kind === 'timeline' ? 'timeline → slicer tanggal di ekspor' : 'aktif di file ekspor (Excel)'}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {pivots.length > 0 ? (
        <p className="mt-3 text-[10px] text-muted" data-testid="sheet-dash-pivots">
          Pivot native pendukung: {pivots.map((p) => `${p.rows.join(' × ')} → sheet ${p.target}`).join(' · ')} (refresh saat file dibuka; tanpa makro).
        </p>
      ) : null}
    </div>
  )
}
