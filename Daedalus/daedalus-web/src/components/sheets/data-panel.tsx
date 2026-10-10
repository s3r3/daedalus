import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { Panel } from '../common/panel'
import { api } from '../../api/client'
import { useWorkbook } from './useWorkbook'
import { cn } from '../../lib/utils'

/**
 * Panel Data: what the workbook is made of right now — sources, per-
 * sheet size (rows × cols, formula vs literal counts), validation
 * (verify) status, and whether the Go sidecar is available for native
 * chart/pivot injection at export. Read-only by design; edits happen
 * on the grid.
 */
export function SheetDataPanel() {
  const { workbook, root } = useWorkbook()
  const [sidecar, setSidecar] = useState<{ available: boolean; version: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .workbookSidecar()
      .then((probe) => {
        if (!cancelled) setSidecar({ available: probe.available, version: probe.version })
      })
      .catch(() => {
        if (!cancelled) setSidecar({ available: false, version: null })
      })
    return () => {
      cancelled = true
    }
  }, [root])

  if (!workbook) {
    return (
      <Panel title="Data" data-testid="sheet-data">
        <p className="px-1 py-1 text-[11px] text-muted">Belum ada workbook di workspace ini.</p>
      </Panel>
    )
  }

  const verify = workbook.verify

  return (
    <Panel title="Data" data-testid="sheet-data">
      <div className="flex flex-col gap-2 px-1 py-1">
        <p className="flex items-center gap-1 text-[11px] text-muted">
          <Database className="size-3" aria-hidden />
          workbook/workbook.json · stage: {workbook.stage}
        </p>
        {workbook.blueprint?.sources.length ? (
          <p className="text-[10px] text-muted">Sumber: {workbook.blueprint.sources.join(', ')}</p>
        ) : null}
        <ul className="flex flex-col gap-1" data-testid="sheet-data-sheets">
          {workbook.sheets.map((sheet) => {
            const refs = Object.keys(sheet.cells)
            let maxRow = 0
            let maxCol = 0
            let formulas = 0
            for (const [ref, cell] of Object.entries(sheet.cells)) {
              const match = /^([A-Z]+)([0-9]+)$/.exec(ref)
              if (match) {
                maxRow = Math.max(maxRow, Number(match[2]))
                let col = 0
                for (const ch of match[1] ?? '') col = col * 26 + (ch.charCodeAt(0) - 64)
                maxCol = Math.max(maxCol, col)
              }
              if (cell.f) formulas += 1
            }
            void refs
            return (
              <li key={sheet.id} className="flex items-baseline justify-between rounded border border-line bg-surface px-2 py-1 text-[10px]">
                <span className="mr-1 font-semibold text-foreground">{sheet.name}</span>
                <span className="text-muted">
                  {maxRow} baris × {maxCol} kolom · {formulas} formula · {Object.keys(sheet.cells).length - formulas} nilai
                </span>
              </li>
            )
          })}
        </ul>
        <p className="flex items-center gap-1.5 text-[10px]" data-testid="sheet-data-verify">
          <span className={cn('inline-block size-2 rounded-full', verify ? (verify.ok ? 'bg-emerald-400' : 'bg-red-400') : 'bg-zinc-500')} />
          {verify ? (
            <span className="text-muted">
              Verify {verify.ok ? 'lulus' : 'ada error'} ({verify.path}) · {verify.formulasChecked} formula dicek
            </span>
          ) : (
            <span className="text-muted">Verify belum pernah jalan untuk workbook ini.</span>
          )}
        </p>
        <p className="text-[10px] text-muted" data-testid="sheet-data-sidecar">
          {sidecar === null
            ? 'Sidecar Go: memeriksa…'
            : sidecar.available
              ? `Sidecar Go: tersedia${sidecar.version ? ` (${sidecar.version})` : ''} — chart/pivot native disuntikkan saat ekspor.`
              : 'Sidecar Go: tidak terdeteksi — ekspor lanjut tanpa chart/pivot native (dicatat jujur di file ekspor + ringkasan formula).'}
        </p>
      </div>
    </Panel>
  )
}
