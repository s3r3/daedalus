import { useState } from 'react'
import { Hammer, ListTree } from 'lucide-react'
import { Panel } from '../common/panel'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useWorkbook } from './useWorkbook'
import { cn } from '../../lib/utils'

const SOURCE_BADGE: Record<string, string> = {
  input: 'text-sky-300 border-sky-500/40',
  formula: 'text-emerald-300 border-emerald-500/40',
  assumption: 'text-amber-300 border-amber-500/40',
}

/**
 * Panel Blueprint: the staged workbook design (sheets, columns+types,
 * key formulas, Asumsi values) the user reviews before anything is
 * built. The Buat button releases the staged run — build → verify →
 * export happen through the engine, and this panel reports the run's
 * own verdict. Standard-only in v1: a fresh spreadsheet is never built
 * unstaged.
 */
export function BlueprintPanel() {
  const { workbook, loading, error, refresh, root } = useWorkbook()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [buildNote, setBuildNote] = useState<string | null>(null)

  const blueprint = workbook?.blueprint
  const staged = workbook !== null && workbook.stage === 'blueprint' && blueprint !== undefined

  const buat = async (): Promise<void> => {
    if (!root || building) return
    setBuilding(true)
    setBuildError(null)
    setBuildNote(null)
    try {
      const result = await api.workbookGenerate(root)
      setBuildNote(result.summary)
      refresh()
      bumpWorkspaceRevision()
    } catch (buildErr: unknown) {
      setBuildError(buildErr instanceof Error ? buildErr.message : String(buildErr))
    } finally {
      setBuilding(false)
    }
  }

  return (
    <Panel title="Blueprint" data-testid="sheet-blueprint">
      {!workbook ? (
        <p className="px-1 py-1 text-[11px] text-muted" data-testid="sheet-blueprint-empty">
          {loading
            ? 'Memuat blueprint…'
            : error
              ? `Gagal membaca workbook: ${error}`
              : 'Belum ada workbook. Minta spreadsheet di chat (mis. "buatkan rekap penjualan dari penjualan.csv") — blueprint-nya di-stage di sini dulu sebelum dibangun.'}
        </p>
      ) : !blueprint ? (
        <p className="px-1 py-1 text-[11px] text-muted" data-testid="sheet-blueprint-none">
          Workbook “{workbook.title}” terbuka tanpa blueprint (dibuka langsung dari file). Minta audit atau edit di chat bila perlu.
        </p>
      ) : (
        <div className="flex flex-col gap-2 px-1 py-1">
          <p className="text-[11px] font-semibold text-foreground" data-testid="sheet-blueprint-title">
            {workbook.title}
            <span className={cn('ml-2 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide', staged ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/40 text-emerald-300')}>
              {staged ? 'menunggu Buat' : 'sudah dibangun'}
            </span>
          </p>
          {blueprint.sources.length > 0 ? (
            <p className="text-[10px] text-muted">Sumber: {blueprint.sources.join(', ')}</p>
          ) : null}
          {staged ? (
            <>
              <Button type="button" size="sm" onClick={() => void buat()} disabled={building} data-testid="sheet-blueprint-buat" className="w-full">
                <Hammer className="size-3.5" aria-hidden />
                {building ? 'Membangun…' : 'Buat workbook ini'}
              </Button>
              <p className="text-[10px] text-muted">
                Blueprint di atas belum jadi file. Periksa sheet, kolom, dan formula kuncinya di bawah — Buat membangun workbook, menjalankan verify, lalu mengekspor XLSX.
              </p>
            </>
          ) : null}
          <ul className="flex flex-col gap-1.5" data-testid="sheet-blueprint-sheets">
            {blueprint.sheets.map((sheet) => (
              <li key={sheet.name} className="rounded border border-line bg-surface px-2 py-1.5">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                  <ListTree className="size-3 text-muted" aria-hidden />
                  {sheet.name}
                  {sheet.purpose ? <span className="font-normal text-muted">— {sheet.purpose}</span> : null}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {sheet.columns.map((col) => (
                    <li key={col.name} className="flex items-baseline gap-1.5 text-[10px] text-muted">
                      <span className="text-foreground">{col.name}</span>
                      <span>{col.type}</span>
                      <span className={cn('rounded border px-1 text-[9px] uppercase', SOURCE_BADGE[col.source] ?? '')}>{col.source}</span>
                      {col.formula ? <code className="truncate text-[9px] text-emerald-300/80">{col.formula}</code> : null}
                    </li>
                  ))}
                </ul>
                {sheet.summary ? <p className="mt-1 text-[10px] text-muted">Ringkasan: {sheet.summary}</p> : null}
                {(sheet.charts?.length || sheet.pivots?.length) ? (
                  <p className="mt-1 text-[10px] text-muted">
                    Native saat ekspor: {sheet.charts?.length ? `${sheet.charts.length} chart` : ''}{sheet.charts?.length && sheet.pivots?.length ? ' · ' : ''}{sheet.pivots?.length ? `${sheet.pivots.length} pivot` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {blueprint.dashboard ? (
            <div className="rounded border border-primary/40 bg-primary/5 px-2 py-1.5" data-testid="sheet-blueprint-dashboard">
              <p className="text-[11px] font-semibold text-foreground">
                Dashboard — {blueprint.dashboard.sheet ?? 'Dashboard'}
                <span className="ml-1 font-normal text-muted">sheet KPI native (kartu + chart + slicer, tanpa makro)</span>
              </p>
              <ul className="mt-1 flex flex-col gap-0.5" data-testid="sheet-blueprint-dashboard-tiles">
                {blueprint.dashboard.tiles.map((tile) => (
                  <li key={tile.id} className="flex items-baseline gap-1.5 text-[10px] text-muted">
                    <span className="text-foreground">{tile.label}</span>
                    <code className="truncate text-[9px] text-emerald-300/80">{tile.formula}</code>
                  </li>
                ))}
              </ul>
              {(blueprint.dashboard.charts?.length || blueprint.dashboard.pivots?.length || blueprint.dashboard.slicers?.length) ? (
                <p className="mt-1 text-[10px] text-muted" data-testid="sheet-blueprint-dashboard-natives">
                  Native saat ekspor:{' '}
                  {[
                    blueprint.dashboard.charts?.length ? `${blueprint.dashboard.charts.length} chart (${blueprint.dashboard.charts.map((c) => c.title ?? c.type).join(', ')})` : '',
                    blueprint.dashboard.pivots?.length ? `${blueprint.dashboard.pivots.length} pivot → ${[...new Set(blueprint.dashboard.pivots.map((p) => p.target))].join(', ')}` : '',
                    blueprint.dashboard.slicers?.length ? `${blueprint.dashboard.slicers.length} slicer (${blueprint.dashboard.slicers.map((s) => s.field).join(', ')})` : '',
                  ].filter(Boolean).join(' · ')}
                </p>
              ) : null}
            </div>
          ) : null}
          {blueprint.assumptions.length > 0 ? (
            <div data-testid="sheet-blueprint-assumptions">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Asumsi</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {blueprint.assumptions.map((assumption) => (
                  <li key={assumption.name} className="flex items-baseline gap-2 text-[10px] text-muted">
                    <span className="text-foreground">{assumption.name}</span>
                    <span className="font-mono">{String(assumption.value)}</span>
                    {assumption.note ? <span>{assumption.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {blueprint.notes ? <p className="text-[10px] text-muted">{blueprint.notes}</p> : null}
          {buildNote ? (
            <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200" data-testid="sheet-blueprint-note">
              {buildNote}
            </p>
          ) : null}
          {buildError ? (
            <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200" data-testid="sheet-blueprint-error">
              Buat gagal: {buildError}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
