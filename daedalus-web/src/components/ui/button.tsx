import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-surface-base hover:opacity-90',
        outline: 'border-line bg-surface text-foreground hover:border-primary',
        ghost: 'border-transparent bg-transparent text-muted hover:text-foreground',
        success: 'border-transparent bg-success text-surface-base hover:opacity-90',
        danger: 'border-transparent bg-error text-surface-base hover:opacity-90',
        warning: 'border-transparent bg-warning text-surface-base hover:opacity-90',
      },
      size: {
        default: 'h-8',
        sm: 'h-7 px-2 text-[11px]',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }