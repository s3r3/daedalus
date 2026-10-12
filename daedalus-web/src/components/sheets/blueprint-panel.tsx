import { useState } from 'react'
import { Hammer, ListTree, Play } from 'lucide-react'
import { Panel } from '../common/panel'
import { Button } from '../ui/button'
import { api } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'
import { useWorkbook } from './useWorkbook'
import { useAnalysis } from './useAnalysis'
import { cn } from '../../lib/utils'

const SOURCE_BADGE: Record<string, string> = {
  input: 'text-sky-300 border-sky-500/40',
  formula: 'text-emerald-300 border-emerald-500/40',
  assumption: 'text-amber-300 border-amber-500/40',
}

/**
 * Mode Analis: the staged analysis plan under review. Nothing computes
 * until "Jalankan analisis" releases the run — the same staging
 * doctrine as Susun's blueprint, different content (question, metrics
 * with formula templates, groupings, charts, assumptions, steps).
 */
function AnalysisPlanView({ analysis }: { analysis: ReturnType<typeof useAnalysis> }) {
  const { plan, planning, planError, running, runAnalysis } = analysis

  if (planning) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted" data-testid="sheet-blueprint-analisis-planning">
        Menyusun rencana analisis…
      </p>
    )
  }

  if (!plan) {
    return (
      <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="sheet-blueprint-analisis-empty">
        <p className="text-[11px] font-semibold text-foreground">Rencana analisis</p>
        <p className="text-[11px] text-muted">
          Belum ada rencana. Pilih dataset di composer (upload CSV/XLSX atau “Pakai workbook saat ini”), tulis pertanyaan
          bisnis, lalu tekan Buat rencana — rencananya di-review di sini sebelum dijalankan.
        </p>
        {planError ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200" data-testid="sheet-blueprint-analisis-error">
            Gagal menyusun rencana: {planError}
          </p>
        ) : null}
      </div>
    )
  }

  const staged = plan.plan
  const run = (): void => {
    void runAnalysis(plan.planId)
  }

  return (
    <div className="flex flex-col gap-2 px-1 py-1" data-testid="sheet-blueprint-analisis">
      <p className="text-[11px] font-semibold text-foreground" data-testid="sheet-blueprint-analisis-question">
        {staged.question}
        {plan.complexity ? (
          <span className="ml-2 rounded border border-line px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted">{plan.complexity}</span>
        ) : null}
      </p>
      <Button type="button" size="sm" onClick={run} disabled={running} data-testid="sheet-blueprint-analisis-run" className="w-full">
        <Play className="size-3.5" aria-hidden />
        {running ? 'Menjalankan analisis…' : 'Jalankan analisis'}
      </Button>
      <p className="text-[10px] text-muted">
        Rencana di bawah belum dihitung. Periksa metrik, grouping, dan asumsinya — Jalankan analisis menghitung lewat
        engine, melewati gerbang Verify, lalu menulis laporannya di Panel Laporan.
      </p>
      {staged.metrics.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-metrics">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Metrik</p>
          <ul className="mt-0.5 flex flex-col gap-1">
            {staged.metrics.map((metric) => (
              <li key={metric.id} className="rounded border border-line bg-surface px-2 py-1.5">
                <p className="text-[11px] font-medium text-foreground">{metric.label}</p>
                <code className="mt-0.5 block truncate text-[9px] text-emerald-300/80">{metric.formulaTemplate}</code>
                {metric.format ? <p className="mt-0.5 text-[9px] text-muted">format: {metric.format}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {staged.groupBys.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-groupbys">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Grouping</p>
          <p className="mt-0.5 text-[10px] text-muted">{staged.groupBys.join(' · ')}</p>
        </div>
      ) : null}
      {staged.comparisons.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-comparisons">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Perbandingan</p>
          <p className="mt-0.5 text-[10px] text-muted">{staged.comparisons.join(' · ')}</p>
        </div>
      ) : null}
      {staged.charts.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-charts">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Chart</p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {staged.charts.map((chart, index) => (
              <li key={index} className="text-[10px] text-muted">
                {chart.title ?? chart.type} <span className="text-muted/70">({chart.type})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {staged.assumptions.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-assumptions">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Asumsi</p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {staged.assumptions.map((assumption, index) => (
              <li key={index} className="text-[10px] text-muted">
                • <span className="text-foreground">{assumption.name}</span>
                {': '}
                <span className="font-mono">{String(assumption.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {staged.steps.length > 0 ? (
        <div data-testid="sheet-blueprint-analisis-steps">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Langkah</p>
          <ol className="mt-0.5 flex list-decimal flex-col gap-0.5 pl-4">
            {staged.steps.map((step, index) => (
              <li key={index} className="text-[10px] text-muted">{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Panel Blueprint: the staged design the user reviews before anything
 * is built or computed. In Susun mode it is the workbook design
 * (sheets, columns+types, key formulas, Asumsi values); the Buat button
 * releases the staged run — build → verify → export happen through the
 * engine, and this panel reports the run's own verdict. In Analis mode
 * it is the staged analysis plan (question, metrics, groupings, charts,
 * assumptions, steps); the "Jalankan analisis" button releases compute
 * → verify → insight report. Either way the doctrine holds: a fresh
 * spreadsheet run never starts unstaged.
 */
export function BlueprintPanel() {
  const mode = useDaedalusStore((state) => state.sheetOptions.mode)
  const analysis = useAnalysis()
  const { workbook, loading, error, refresh, root } = useWorkbook()
  const bumpWorkspaceRevision = useDaedalusStore((state) => state.bumpWorkspaceRevision)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [buildNote, setBuildNote] = useState<string | null>(null)

  if (mode === 'analis') {
    return (
      <Panel title="Blueprint" data-testid="sheet-blueprint">
        <AnalysisPlanView analysis={analysis} />
      </Panel>
    )
  }

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
