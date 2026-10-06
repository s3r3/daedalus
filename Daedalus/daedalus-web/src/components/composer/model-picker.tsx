import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ProviderModel } from '../../api/types'

/**
 * Searchable model combobox. The gateway can expose hundreds of models
 * (9Router), so the list is a filter input over the already-loaded models —
 * substring match on `provider/model`, sorted by provider then model, with at
 * most {@link MAX_ROWS} rows rendered and a "+N more" hint so the DOM never
 * carries the whole catalog. The first entry is always the default model.
 */
export const MAX_ROWS = 100

export function ModelPicker({
  models,
  providerId,
  model,
  onSelect,
}: {
  models: ProviderModel[]
  providerId: string
  model: string
  onSelect: (selection: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const currentLabel = providerId && model ? `${providerId}/${model}` : model ? model : 'default model'

  const sorted = useMemo(
    () => [...models].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model)),
    [models],
  )
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return sorted
    return sorted.filter((entry) => `${entry.providerId}/${entry.model}`.toLowerCase().includes(needle))
  }, [sorted, filter])

  // Row 0 is the default-model entry; rows 1.. are the (capped) models.
  const rows = filtered.slice(0, MAX_ROWS)
  const overflow = filtered.length - rows.length
  const rowCount = rows.length + 1

  // With a filter typed, the first match is highlighted so Enter picks it;
  // unfiltered, the highlight starts on the default-model entry.
  useEffect(() => {
    setActive(filter.trim() && rows.length > 0 ? 1 : 0)
  }, [filter, open, rows.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open ])

  const choose = (index: number): void => {
    if (index === 0) {
      onSelect('')
    } else {
      const entry = rows[index - 1]
      if (entry) onSelect(`${entry.providerId}/${entry.model}`)
    }
    setOpen(false)
    setFilter('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(rowCount - 1, current + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative" data-testid="model-picker">
      <button
        type="button"
        data-testid="model-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-6 max-w-[260px] items-center gap-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
        onClick={() => setOpen((current) => !current)}
        title="Search and pick a model"
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="size-3 shrink-0 text-muted" />
      </button>

      {open ? (
        <div className="absolute top-full left-0 z-20 mt-1 w-[300px] rounded border border-line bg-surface shadow-lg" data-testid="model-picker-list">
          <input
            data-testid="model-picker-filter"
            aria-label="filter models"
            className="h-7 w-full border-b border-line bg-surface px-2 text-[11px] text-foreground outline-none"
            placeholder="Type to filter models…"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul role="listbox" aria-label="models" className="max-h-56 overflow-auto py-0.5">
            <li
              role="option"
              aria-selected={active === 0}
              data-testid="model-option"
              data-value=""
              className={`cursor-pointer truncate px-2 py-1 text-[11px] ${active === 0 ? 'bg-primary/15 text-primary' : 'text-foreground'}`}
              onMouseEnter={() => setActive(0)}
              onClick={() => choose(0)}
            >
              default model
            </li>
            {rows.map((entry, index) => (
              <li
                key={`${entry.providerId}::${entry.model}`}
                role="option"
                aria-selected={active === index + 1}
                data-testid="model-option"
                data-value={`${entry.providerId}/${entry.model}`}
                className={`cursor-pointer truncate px-2 py-1 text-[11px] ${active === index + 1 ? 'bg-primary/15 text-primary' : 'text-foreground'}`}
                onMouseEnter={() => setActive(index + 1)}
                onClick={() => choose(index + 1)}
              >
                {entry.providerId}/{entry.model}
                {entry.supportsVision ? <span className="text-muted"> · vision</span> : null}
              </li>
            ))}
            {rows.length === 0 ? <li className="px-2 py-1 text-[11px] text-muted">no models match</li> : null}
          </ul>
          {overflow > 0 ? (
            <p className="border-t border-line px-2 py-1 text-[10px] text-muted" data-testid="model-picker-more">
              +{overflow} more — keep typing
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
