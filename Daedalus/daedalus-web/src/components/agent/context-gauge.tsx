import { useMemo } from 'react'
import { Badge } from '../ui/badge'
import { useTaskEvents } from '../../state/hooks'
import { useDaedalusStore } from '../../state/taskStore'
import { contextGauge } from '../../state/selectors'

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Live context pressure, next to the chat header: the newest model
 * request's own context meter (real — the loop stamps its estimate into
 * the recorded MODEL_REQUEST_* payload), the known context window for
 * the serving model when the provider reports one, and the task's
 * cumulative token accounting (the same roll-up as the chat footer).
 *
 * When the loop never reported a meter, the gauge shows plain token
 * counts with no percentage — never an invented one. When the task made
 * no model requests at all, the gauge renders nothing: a gauge with no
 * data is decoration, not information.
 */
export function ContextGauge() {
  const events = useTaskEvents()
  const providers = useDaedalusStore((state) => state.providers)
  const session = useDaedalusStore((state) => state.session)
  const gauge = useMemo(() => contextGauge(events), [events])

  const model = gauge.model ?? session?.model ?? null
  const windowTokens = useMemo(() => {
    if (!model) return null
    for (const provider of providers) {
      const known = provider.contextWindows?.[model]
      if (typeof known === 'number' && known > 0) return known
    }
    return null
  }, [model, providers])

  if (gauge.usage.requests === 0) return null

  const percent = gauge.percent
  const tone = percent === null ? 'neutral' : percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'neutral'
  const label = percent !== null ? `ctx ${percent}%` : 'ctx —'
  const detail =
    `context pressure for the active task · ` +
    (percent !== null ? `${percent}% of the loop's context limit` : 'the provider never reported a context meter') +
    (windowTokens ? ` · ${model} window ${formatCount(windowTokens)} tokens` : '') +
    ` · ${formatCount(gauge.usage.totalTokens)} tokens total over ${gauge.usage.requests} request${gauge.usage.requests === 1 ? '' : 's'}`

  return (
    <span className="flex items-center gap-1.5" data-testid="context-gauge" title={detail}>
      {percent !== null ? (
        <span className="h-1.5 w-14 overflow-hidden rounded bg-surface" aria-hidden="true">
          <span
            className={`block h-full rounded ${percent >= 90 ? 'bg-error' : percent >= 70 ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </span>
      ) : null}
      <Badge tone={tone} data-testid="context-gauge-label">
        {label}
      </Badge>
      <span className="font-mono text-[10px] text-muted" data-testid="context-gauge-tokens">
        {formatCount(gauge.usage.totalTokens)} tokens{windowTokens ? ` / ${formatCount(windowTokens)}` : ''}
      </span>
    </span>
  )
}
