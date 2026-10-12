import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
  {
    variants: {
      tone: {
        neutral: 'border-line text-muted',
        success: 'border-success text-success',
        warning: 'border-warning text-warning',
        error: 'border-error text-error',
        info: 'border-info text-info',
        primary: 'border-primary text-primary',
        secondary: 'border-secondary text-secondary',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

export { badgeVariants }