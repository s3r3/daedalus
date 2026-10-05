import { useMemo } from 'react'
import { Badge } from '../ui/badge'
import { EmptyState, Panel } from '../common/panel'
import { Spinner } from '../common/spinner'
import { useTaskEvents } from '../../state/hooks'
import { validation } from '../../state/selectors'
import { toneForResult } from '../agent/status-tone'

/**
 * Validation surface: build / test / lint check verdicts from VALIDATION_* events
 * plus the diagnostics each check reported (file · line · message).
 */
export function ValidationPanel() {
  const events = useTaskEvents()
  const { result, running, passed } = useMemo(() => validation(events), [events])

  return (
    <Panel
      title="validation"
      data-testid="validation-panel"
      action={
        running ? (
          <Badge tone="info" data-testid="validation-running">
            <Spinner label="validation running" /> running
          </Badge>
        ) : passed === true ? (
          <Badge tone="success" data-testid="validation-verdict">
            passed
          </Badge>
        ) : passed === false ? (
          <Badge tone="error" data-testid="validation-verdict">
            failed
          </Badge>
        ) : (
          <Badge tone="neutral">not run</Badge>
        )
      }
      bodyClassName="flex flex-col gap-2"
    >
      {!result ? (
        <EmptyState title="No validation run yet" hint="The agent runs the configured build, test, and lint checks before reporting success." />
      ) : (
        <>
          <ul className="flex flex-col gap-1" data-testid="validation-checks">
            {result.checks.map((check) => (
              <li
                key={check.name}
                data-testid="validation-check"
                data-status={check.status}
                className={`rounded border border-line px-1.5 py-1 text-[11px] ${
                  check.status === 'pass' ? 'motion-pass-flash' : check.status === 'fail' || check.status === 'error' ? 'motion-fail-shake' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-foreground">{check.name}</span>
                  <Badge tone={toneForResult(check.status)}>{check.status}</Badge>
                  <span className="ml-auto text-[10px] text-muted">{check.exit_code === null ? '—' : `exit ${check.exit_code}`}</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-muted">{check.cmd}</p>
                {check.summary ? <p className="text-[10px] text-foreground">{check.summary}</p> : null}
                {check.diagnostics.length > 0 ? <DiagnosticsList checkName={check.name} diagnostics={check.diagnostics} /> : null}
              </li>
            ))}
          </ul>

          {running ? (
            <p className="motion-validation-shimmer rounded border border-line px-1.5 py-1 text-[10px] text-muted" data-testid="validation-shimmer">
              checks running…
            </p>
          ) : null}
        </>
      )}
    </Panel>
  )
}

export function DiagnosticsList({
  checkName,
  diagnostics,
}: {
  checkName?: string
  diagnostics: Array<{ file?: string; line?: number; message: string }>
}) {
  if (diagnostics.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-0.5 border-l border-line pl-2" data-testid={checkName ? `diagnostics-${checkName}` : 'diagnostics'}>
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.file ?? ''}:${diagnostic.line ?? index}`} className="text-[10px] text-foreground" data-testid="diagnostic">
          {diagnostic.file ? (
            <span className="text-muted">
              {diagnostic.file}
              {diagnostic.line === undefined ? '' : `:${diagnostic.line}`} ·{' '}
            </span>
          ) : null}
          {diagnostic.message}
        </li>
      ))}
    </ul>
  )
}