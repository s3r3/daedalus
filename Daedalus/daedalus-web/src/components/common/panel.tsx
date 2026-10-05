import type { ReactNode } from 'react'
import { Card, CardBody, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'

export function Panel({
  title,
  action,
  children,
  className,
  bodyClassName,
  'data-testid': testId,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  'data-testid'?: string
}) {
  return (
    <Card className={cn('flex min-h-0 flex-col', className)} data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardBody className={cn('min-h-0 flex-1', bodyClassName)}>{children}</CardBody>
    </Card>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-3 py-6 text-center text-muted">
      <p className="text-xs">{title}</p>
      {hint ? <p className="max-w-[36ch] text-[11px] opacity-80">{hint}</p> : null}
      {action}
    </div>
  )
}

export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-1 px-3 py-4 text-xs text-error">
      <p className="font-semibold">{title}</p>
      {message ? <p className="text-muted">{message}</p> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 border border-line px-2 py-1 text-[11px] text-foreground">
          retry
        </button>
      ) : null}
    </div>
  )
}

export function LoadingState({ label }: { label: string }) {
  return <p className="px-3 py-3 text-[11px] text-muted">{label}…</p>
}