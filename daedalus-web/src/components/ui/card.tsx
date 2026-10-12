import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('rounded-md border border-line bg-surface-base', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      data-slot="card-header"
      className={cn('flex items-center justify-between gap-2 border-b border-line px-3 py-2', className)}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('text-[11px] font-bold uppercase tracking-wider text-muted', className)} {...props} />
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-body" className={cn('px-3 py-2', className)} {...props} />
}