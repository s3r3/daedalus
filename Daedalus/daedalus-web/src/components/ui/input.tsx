import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-foreground placeholder:text-muted disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'w-full resize-none rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-foreground placeholder:text-muted',
        className,
      )}
      {...props}
    />
  )
}